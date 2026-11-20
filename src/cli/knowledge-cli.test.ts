import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Command } from "commander";
import { afterEach, expect, it, vi } from "vitest";
import { registerSubCliByName } from "./program/register.subclis.js";

let directory: string | undefined;
afterEach(async () => {
  vi.restoreAllMocks();
  if (directory) {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

it("runs the material lifecycle through the actual command parser and local store", async () => {
  directory = await fs.mkdtemp(path.join(os.tmpdir(), "mycortex-cli-"));
  const store = path.join(directory, "store");
  const text = path.join(directory, "material.txt");
  await fs.writeFile(text, "合成资料：电路中电压为 5V。", "utf8");
  const refinement = path.join(directory, "refinement.json");
  await fs.writeFile(
    refinement,
    JSON.stringify({
      topics: ["电路"],
      relevance: "historical",
      entities: [{ id: "synthetic:circuit", name: "合成电路", kind: "project" }],
      context: {
        conversationId: "synthetic:lab",
        participantIds: ["synthetic:circuit"],
        summary: "合成实验记录",
      },
      entries: [
        {
          summary: "电路电压为5V",
          subject: "合成电路",
          stance: "explicit",
          quote: "电路中电压为 5V。",
          timeText: null,
        },
      ],
    }),
  );
  const output = vi.spyOn(console, "log").mockImplementation(() => {});
  async function run(...args: string[]) {
    const program = new Command().exitOverride();
    await registerSubCliByName(program, "knowledge", ["node", "openclaw", "knowledge"]);
    await program.parseAsync(["node", "openclaw", "knowledge", "--store", store, ...args]);
    return JSON.parse(String(output.mock.calls.at(-1)?.[0])) as Record<string, unknown>;
  }
  await run("init");
  const saved = await run(
    "add",
    "--file",
    text,
    "--refinement",
    refinement,
    "--title",
    "合成电路",
    "--source",
    "synthetic:circuit",
    "--author",
    "synthetic-user",
    "--request",
    "cli-1",
  );
  expect(saved).toMatchObject({ title: "电路电压为5V", revision: 1 });
  expect(saved.body).toContain("电路中电压为 5V。");
  expect(saved.body).not.toContain("合成资料：");
  const id = String(saved.id);
  expect(await run("list")).toMatchObject({ results: [] });
  expect(await run("list", "--include-historical")).toMatchObject({ results: [{ id }] });
  expect(await run("search", "电路")).toMatchObject({ results: [] });
  expect(await run("search", "电路", "--include-historical")).toMatchObject({ results: [{ id }] });
  expect(await run("network")).toMatchObject({
    entities: [],
    relations: [],
    conversations: [],
    truncated: false,
  });
  expect(
    await run(
      "network",
      "--entity",
      "synthetic:circuit",
      "--include-historical",
      "--limit",
      "50",
      "--offset",
      "0",
    ),
  ).toMatchObject({
    entities: [{ id: "synthetic:circuit" }],
    conversations: [{ conversationId: "synthetic:lab", materialId: id }],
    truncated: false,
  });
  expect(await run("read", id)).toMatchObject({ sourceUri: "synthetic:circuit" });
  await fs.writeFile(text, "合成纠正：电压为 3V。", "utf8");
  expect(
    await run("correct", id, "--revision", "1", "--file", text, "--note", "合成纠正"),
  ).toMatchObject({ revision: 2, body: "合成纠正：电压为 3V。" });
  await expect(run("delete", id, "--revision", "1")).rejects.toThrow(/revision/i);
  const exported = path.join(directory, "backup.json");
  await run("export", "--out", exported);
  await expect(run("export", "--out", exported)).rejects.toThrow(/exist/i);
  const deleted = await run("delete", id, "--revision", "2");
  expect(deleted).toMatchObject({ deleted: true, id });
  await expect(run("read", id)).rejects.toThrow(/deleted/i);
  expect(JSON.parse(await fs.readFile(exported, "utf8"))).toMatchObject({
    format: "mycortex.materials",
    version: 2,
  });
  const ledger = path.join(directory, "latest-deletions.json");
  await run("export-deletions", "--out", ledger);
  expect(await fs.readFile(ledger, "utf8")).not.toContain("电压");
  expect(JSON.parse(await fs.readFile(ledger, "utf8"))).toMatchObject({ materials: [{ id }] });
  await expect(run("import", "--file", exported)).rejects.toThrow(/deletions-from/);
});

it("searches project capabilities through the actual command parser", async () => {
  directory = await fs.mkdtemp(path.join(os.tmpdir(), "mycortex-project-cli-"));
  const store = path.join(directory, "store");
  const text = path.join(directory, "project.txt");
  const refinement = path.join(directory, "project.json");
  await fs.writeFile(
    text,
    "知乎搜索工具位于 D:/Apps/zhihu-search，使用 scripts/search.ps1 搜索知乎帖子。",
    "utf8",
  );
  await fs.writeFile(
    refinement,
    JSON.stringify({
      topics: ["项目", "知乎"],
      projectProfile: {
        entityId: "project:zhihu-search",
        name: "知乎搜索工具",
        purpose: "搜索知乎帖子并保留来源链接。",
        status: "active",
        locations: [{ kind: "workspace", path: "D:/Apps/zhihu-search" }],
        capabilities: [
          {
            name: "搜索知乎帖子",
            summary: "按关键词搜索知乎帖子。",
            entrypoint: { kind: "script", value: "scripts/search.ps1" },
            usage: "运行 scripts/search.ps1 -Query <关键词>",
          },
        ],
        design: "复用已有浏览器会话并保留来源链接。",
        verifiedAt: "2026-11-20T10:00:00+08:00",
      },
      entities: [{ id: "project:zhihu-search", name: "知乎搜索工具", kind: "project" }],
      entries: [
        {
          summary: "知乎搜索工具可搜索帖子。",
          subject: "知乎搜索工具",
          stance: "explicit",
          quote: "知乎搜索工具位于 D:/Apps/zhihu-search，使用 scripts/search.ps1 搜索知乎帖子。",
          timeText: null,
          aboutIds: ["project:zhihu-search"],
        },
      ],
    }),
    "utf8",
  );
  const output = vi.spyOn(console, "log").mockImplementation(() => {});
  async function run(...args: string[]) {
    const program = new Command().exitOverride();
    await registerSubCliByName(program, "knowledge", ["node", "openclaw", "knowledge"]);
    await program.parseAsync(["node", "openclaw", "knowledge", "--store", store, ...args]);
    return JSON.parse(String(output.mock.calls.at(-1)?.[0])) as Record<string, unknown>;
  }
  await run("init");
  await run(
    "add",
    "--file",
    text,
    "--refinement",
    refinement,
    "--title",
    "知乎搜索工具",
    "--source",
    "synthetic:zhihu-search",
    "--author",
    "synthetic-user",
    "--request",
    "project-cli-1",
  );
  expect(await run("projects", "知乎", "搜索")).toMatchObject({
    results: [
      { name: "知乎搜索工具", capabilities: [{ entrypoint: { value: "scripts/search.ps1" } }] },
    ],
  });
});

it("imports a QQ Digest bundle through the actual command parser", async () => {
  directory = await fs.mkdtemp(path.join(os.tmpdir(), "mycortex-qqdigest-cli-"));
  const store = path.join(directory, "store");
  const bundle = path.join(directory, "qqdigest.json");
  await fs.writeFile(
    bundle,
    JSON.stringify({
      format: "mycortex.qqdigest",
      version: 1,
      exportedAt: "2026-11-15T00:00:00.000Z",
      source: "qq-digest",
      candidates: [
        {
          candidateId: 11,
          candidateRevision: 2,
          requestKey: "qqdigest:candidate:11",
          title: "合成 QQ 资料",
          candidateType: "resource",
          filterReason: "对用户有帮助",
          groupId: 123,
          groupName: "学习群",
          messageIds: ["m1"],
          body: "# 合成 QQ 资料\n\n原文和上下文",
          organization: {
            topics: ["合成资料"],
            entries: [
              {
                summary: "合成知识",
                subject: "合成来源",
                stance: "explicit",
                quote: "原文和上下文",
                timeText: null,
              },
            ],
          },
          sourceUri: "qqdigest://group/123/message/m1",
          author: "QQ Digest 群 学习群",
          observedAt: "2026-11-15T08:00:00.000+08:00",
          context: { source_context: [] },
        },
      ],
    }),
    "utf8",
  );
  const output = vi.spyOn(console, "log").mockImplementation(() => {});
  async function run(...args: string[]) {
    const program = new Command().exitOverride();
    await registerSubCliByName(program, "knowledge", ["node", "openclaw", "knowledge"]);
    await program.parseAsync(["node", "openclaw", "knowledge", "--store", store, ...args]);
    return JSON.parse(String(output.mock.calls.at(-1)?.[0])) as Record<string, unknown>;
  }
  await run("init");
  expect(await run("import-qqdigest", "--file", bundle)).toMatchObject({
    imported: 1,
    updated: 0,
  });
  expect(await run("import-qqdigest", "--file", bundle)).toMatchObject({
    imported: 0,
    unchanged: 1,
  });
});
