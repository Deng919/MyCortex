import { randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import http, { type IncomingMessage } from "node:http";
import path from "node:path";
import { z } from "zod";
import { createKnowledgeClient, KnowledgeWriteOutcomeUnknownError } from "./client.js";
import { correctionSchema, submissionSchema } from "./contract.js";
import type { KnowledgeOrganization } from "./organization-contract.js";

const revision = z.coerce.number().int().positive();
const correction = correctionSchema
  .omit({ submittedBy: true })
  .extend({ expectedRevision: revision });
const deletion = z.strictObject({ expectedRevision: revision });
const assets = new Map([
  ["/", ["index.html", "text/html; charset=utf-8"]],
  ["/app.js", ["app.js", "text/javascript; charset=utf-8"]],
  ["/style.css", ["style.css", "text/css; charset=utf-8"]],
]);

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    length += bytes.length;
    // The body limit is enforced by the store schema; this bounds JSON transport overhead.
    if (length > 2 * 1024 * 1024) {
      throw new HttpError(413, "内容过大，请将材料拆分后保存（正文最多 256 KiB）。");
    }
    chunks.push(bytes);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new HttpError(400, "请求格式无效，请刷新客户端后重试。");
  }
}

/** Local operator UI. Every API call is scoped to this launch and its explicit store. */
export async function startKnowledgeDesktop(options: { directory: string; port?: number }) {
  const directory = path.resolve(options.directory);
  const client = createKnowledgeClient(directory);
  const token = randomBytes(32).toString("hex");
  let origin = "";
  let closing = false;
  let lastActivity = Date.now();
  const authority = {
    assertCurrent() {
      if (closing) {
        throw new Error("客户端已关闭。");
      }
    },
  };
  const handleRequest = async (request: IncomingMessage, response: http.ServerResponse) => {
    response.setHeader("Cache-Control", "no-store");
    response.setHeader("X-Content-Type-Options", "nosniff");
    response.setHeader("Referrer-Policy", "no-referrer");
    response.setHeader(
      "Content-Security-Policy",
      "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
    );
    const json = (value: unknown, status = 200) => {
      response.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
      response.end(JSON.stringify(value));
    };
    try {
      if (request.headers.host !== new URL(origin).host) {
        throw new HttpError(403, "只允许本机客户端访问。");
      }
      const url = new URL(request.url ?? "/", origin);
      if (!url.pathname.startsWith("/api/")) {
        const asset = assets.get(url.pathname);
        if (request.method !== "GET" || !asset) {
          throw new HttpError(404, "页面不存在。");
        }
        response.setHeader("Content-Type", asset[1]!);
        response.end(await fs.readFile(new URL(`./desktop/${asset[0]}`, import.meta.url)));
        return;
      }
      if (request.headers.authorization !== `Bearer ${token}`) {
        throw new HttpError(401, "连接已失效，请从启动入口重新打开客户端。");
      }
      if (request.headers.origin && request.headers.origin !== origin) {
        throw new HttpError(403, "不允许其他网站访问记忆库。");
      }
      lastActivity = Date.now();
      if (url.pathname === "/api/info" && request.method === "GET") {
        json({ directory });
        return;
      }
      if (url.pathname === "/api/materials") {
        if (request.method === "GET") {
          const q = url.searchParams.get("q")?.trim() ?? "";
          if (q) {
            const terms = z.array(z.string().min(1).max(100)).min(1).max(6).parse(q.split(/\s+/u));
            const items = await client.execute(
              { operation: "search", input: { terms, limit: 10 } },
              authority,
            );
            json({ items, search: true, hasMore: false });
          } else {
            const offset = z.coerce
              .number()
              .int()
              .min(0)
              .parse(url.searchParams.get("offset") ?? 0);
            const items = await client.execute(
              { operation: "list", input: { limit: 20, offset } },
              authority,
            );
            json({ items, search: false, hasMore: items.length === 20 });
          }
          return;
        }
        if (request.method === "POST") {
          const raw = z.record(z.string(), z.unknown()).parse(await readJson(request));
          const { entryMode, ...source } = raw;
          const input = submissionSchema.parse({ ...source, submittedBy: "local-desktop" });
          let organization: KnowledgeOrganization | undefined;
          if (input.kind === "text") {
            if (entryMode !== "manual-knowledge") {
              throw new HttpError(
                422,
                "原始材料请先交给已连接的 Agent 提炼后提交；客户端只直接保存用户手写知识。原文未保存。",
              );
            }
            if (input.body.length > 2000) {
              throw new HttpError(400, "每条手写知识最多 2,000 字，请提炼后分条记录。");
            }
            organization = {
              topics: [],
              entries: [
                {
                  summary: input.title,
                  subject: "用户手写知识",
                  stance: "explicit",
                  quote: input.body,
                  timeText: null,
                },
              ],
            };
          }
          const saved = await client.execute(
            { operation: "submit", input, organization },
            authority,
          );
          json(saved ?? { status: "skipped", reason: "no-useful-knowledge" });
          return;
        }
      }
      const match = /^\/api\/materials\/([^/]+)(?:\/(history|correct|delete))?$/u.exec(
        url.pathname,
      );
      if (!match) {
        throw new HttpError(404, "操作不存在。");
      }
      const id = z.uuid().parse(match[1]);
      const action = match[2];
      if (request.method === "GET" && action === "history") {
        json(await client.execute({ operation: "history", input: { id } }, authority));
        return;
      }
      if (request.method === "GET" && !action) {
        const selected = url.searchParams.has("revision")
          ? revision.parse(url.searchParams.get("revision"))
          : undefined;
        const material = await client.execute(
          { operation: "read", input: { id, revision: selected, length: 8000 } },
          authority,
        );
        // Pin the first revision while assembling long originals; edits cannot mix versions.
        while (material.body.length < material.totalLength) {
          const part = await client.execute(
            {
              operation: "read",
              input: {
                id,
                revision: material.revision,
                offset: material.body.length,
                length: 8000,
              },
            },
            authority,
          );
          material.body += part.body;
        }
        json({ ...material, truncated: false });
        return;
      }
      if (request.method === "POST" && action === "correct") {
        const { expectedRevision, ...input } = correction.parse(await readJson(request));
        json(
          await client.execute(
            {
              operation: "correct",
              input: {
                id,
                expectedRevision,
                correction: { ...input, submittedBy: "local-desktop" },
              },
            },
            authority,
          ),
        );
        return;
      }
      if (request.method === "POST" && action === "delete") {
        const input = deletion.parse(await readJson(request));
        json(await client.execute({ operation: "delete", input: { id, ...input } }, authority));
        return;
      }
      throw new HttpError(405, "不支持此操作。");
    } catch (error) {
      if (error instanceof HttpError) {
        json({ error: error.message }, error.status);
      } else if (error instanceof z.ZodError) {
        const oversized = error.issues.some((issue) => issue.message.includes("256 KiB"));
        json(
          {
            error: oversized
              ? "正文最多 256 KiB，请拆分后保存。"
              : "输入无效，请检查必填字段、关键词长度与修订号。",
          },
          oversized ? 413 : 400,
        );
      } else {
        const message = error instanceof Error ? error.message : "操作失败";
        const conflict = /conflict/iu.test(message);
        const missing = /not found|deleted|no saved materials/iu.test(message);
        json(
          {
            error: conflict
              ? "这条记忆已有新版本，请保留修改内容，重新查看当前版本后再保存。"
              : missing
                ? "这条记忆已删除或不存在，请刷新列表。"
                : message,
            outcomeUnknown: error instanceof KnowledgeWriteOutcomeUnknownError,
          },
          conflict ? 409 : missing ? 404 : 500,
        );
      }
    }
  };
  const server = http.createServer((request, response) => {
    void handleRequest(request, response);
  });
  server.requestTimeout = 30000;
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port ?? 0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("无法启动本地客户端服务。");
  }
  origin = `http://127.0.0.1:${address.port}`;
  return {
    origin,
    token,
    url: `${origin}/#${token}`,
    get lastActivity() {
      return lastActivity;
    },
    async close() {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error);
          } else {
            resolve();
          }
        });
      });
      closing = true;
      await client.close();
    },
  };
}
