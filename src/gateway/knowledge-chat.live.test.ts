import { randomUUID } from "node:crypto";
import path from "node:path";
import { expect, it } from "vitest";
import type { AgentWaitResult } from "../agents/run-wait.types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { SessionsUsageResult } from "../shared/usage-types.js";

// Live-only: synthetic data, isolated Gateway state, and the existing local model.
// No fake provider and no existing account/config/auth-profile discovery.
const live = process.env.OPENCLAW_LIVE_KNOWLEDGE_CHAT === "1";
const processing = process.env.OPENCLAW_LIVE_KNOWLEDGE_PROCESSING === "1";
const MODEL = "qwen3.5:9b-q4_K_M";
const MODEL_REF = `ollama/${MODEL}`;
const STEP_TIMEOUT_MS = 150_000;

type HistoryMessage = {
  role: string;
  toolName?: string;
  toolCallId?: string;
  isError?: boolean;
  details?: unknown;
  content?: string | Array<{ type: string; text?: string; [key: string]: unknown }>;
};

function currentTurnMessages(messages: HistoryMessage[]): HistoryMessage[] {
  const lastUser = messages.findLastIndex((message) => message.role === "user");
  return lastUser >= 0 ? messages.slice(lastUser) : messages;
}

function summarizeToolEvents(messages: HistoryMessage[]) {
  return messages.flatMap((message, messageIndex) => {
    const events: Array<Record<string, unknown>> = [];
    if (message.role === "toolResult") {
      events.push({
        messageIndex,
        role: message.role,
        name: message.toolName,
        toolCallId: message.toolCallId,
        isError: message.isError,
        content: message.content,
        details: message.details,
      });
    }
    if (!Array.isArray(message.content)) {
      return events;
    }
    for (const part of message.content) {
      if (part.type === "toolCall") {
        events.push({
          messageIndex,
          role: message.role,
          type: part.type,
          name: part.name,
          arguments: part.arguments,
        });
      }
    }
    return events;
  });
}

function summarizeHistoryMessage(message: HistoryMessage) {
  const content = Array.isArray(message.content)
    ? message.content.map((part) => ({ type: part.type, text: part.text }))
    : message.content;
  return { role: message.role, toolName: message.toolName, content };
}

function hasToolInvocation(messages: HistoryMessage[], toolName: string): boolean {
  return messages.some((message) => {
    if (message.toolName === toolName) {
      return true;
    }
    if (!Array.isArray(message.content)) {
      return false;
    }
    return message.content.some((part) => {
      const candidate = part as { type?: unknown; name?: unknown };
      return candidate.type === "toolCall" && candidate.name === toolName;
    });
  });
}

it.skipIf(!live)(
  "saves, recalls across chats, corrects and deletes knowledge through a real local-model Gateway",
  { timeout: 15 * 60_000 },
  async () => {
    const [
      { runQaGatewayFixture },
      { withOpenClawTestState },
      { acquireTestPortBlock },
      { createKnowledgeClient },
      { startGatewayWithClient, disconnectGatewayClient },
      { kernelGatewayTestStateOptions },
      { READ_SCOPE, WRITE_SCOPE },
    ] = await Promise.all([
      import("../../test/helpers/qa-gateway-cleanup.js"),
      import("../test-utils/openclaw-test-state.js"),
      import("../test-utils/port-claims.js"),
      import("../knowledge/client.js"),
      import("./test-helpers.e2e.js"),
      import("./test-helpers.env.js"),
      import("./operator-scopes.js"),
    ]);
    await withOpenClawTestState(
      {
        ...kernelGatewayTestStateOptions("knowledge-chat-live"),
        env: {
          ...kernelGatewayTestStateOptions("knowledge-chat-live").env,
          OPENCLAW_DISABLE_BUNDLED_PLUGINS: undefined,
          OPENCLAW_SKIP_PROVIDERS: undefined,
          OPENCLAW_DISABLE_BONJOUR: "1",
        },
      },
      async (state) => {
        const nonce = randomUUID().slice(0, 8);
        const title = `合成项目 CedarArchive-${nonce}`;
        const sourceUri = `synthetic:knowledge-chat:${nonce}`;
        const original = `${title} 的复习安排：每周三晚上复习线性代数，暂不决定是否报考研究生。`;
        const corrected = `${title} 的复习安排：每周六上午复习线性代数，暂不决定是否报考研究生。`;
        const captureSession = `agent:main:knowledge-live-${nonce}-capture`;
        const recallSession = `agent:main:knowledge-live-${nonce}-recall`;
        const directory = path.join(state.root, "knowledge");
        const token = randomUUID();
        const config: OpenClawConfig = {
          agents: {
            entries: { main: { agentDir: state.agentDir("main"), workspace: state.workspaceDir } },
            defaults: {
              workspace: state.workspaceDir,
              skipBootstrap: true,
              thinkingDefault: "off",
              model: { primary: MODEL_REF, fallbacks: [] },
              models: {
                [MODEL_REF]: {
                  agentRuntime: { id: "openclaw" },
                  params: { temperature: 0, num_ctx: 32768 },
                },
              },
              timeoutSeconds: 150,
              compaction: { memoryFlush: { enabled: false } },
              sandbox: { mode: "off" },
            },
          },
          models: {
            mode: "replace",
            providers: {
              ollama: {
                api: "ollama",
                baseUrl: "http://127.0.0.1:11434",
                apiKey: "synthetic-local-ollama",
                models: [
                  {
                    id: MODEL,
                    name: "Existing local synthetic-test model",
                    api: "ollama",
                    reasoning: false,
                    input: ["text"],
                    contextWindow: 32768,
                    maxTokens: 1024,
                    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                  },
                ],
              },
            },
          },
          tools: {
            allow: ["knowledge_read", "knowledge_write"],
            toolSearch: false,
            knowledge: {
              directory,
              connections: {
                [captureSession]: ["read", "submit", "manage", "organize"],
                [recallSession]: ["read", "submit", "manage", "organize"],
              },
              ...(processing
                ? { processing: { provider: "ollama", model: MODEL, timeoutMs: 60000 } }
                : {}),
            },
          },
          plugins: { slots: { memory: "none" } },
          gateway: { mode: "local", bind: "loopback", auth: { mode: "token", token } },
          hooks: { enabled: false },
        };
        const knowledge = createKnowledgeClient(directory);
        let gateway: Awaited<ReturnType<typeof startGatewayWithClient>> | undefined;
        let phase = "gateway-start";
        const usage: Array<{
          phase: string;
          session: string;
          totals: SessionsUsageResult["totals"];
        }> = [];
        await runQaGatewayFixture(
          async () => {
            const portClaim = await acquireTestPortBlock({ offsets: [0, 1, 2, 3, 4] });
            gateway = await startGatewayWithClient({
              cfg: config,
              configPath: state.configPath,
              token,
              portClaim,
              scopes: [READ_SCOPE, WRITE_SCOPE],
            });
            await gateway.server.startupSettled;
            const client = gateway.client;
            const execute = <C extends Parameters<typeof knowledge.execute>[0]>(command: C) =>
              knowledge.execute(command, { assertCurrent() {} });
            const turn = async (
              nextPhase: string,
              sessionKey: string,
              userMessage: string,
              requiredTool?: string,
            ) => {
              phase = nextPhase;
              console.log(`[knowledge-chat-live] ${phase}`);
              const accepted = await client.request<{ runId: string; status: string }>("agent", {
                sessionKey,
                message: userMessage,
                thinking: "off",
                deliver: false,
                timeout: Math.ceil(STEP_TIMEOUT_MS / 1000),
                idempotencyKey: randomUUID(),
              });
              expect(accepted.status, `${phase}: agent admission`).toBe("accepted");
              const completed = await client.request<AgentWaitResult>(
                "agent.wait",
                {
                  runId: accepted.runId,
                  timeoutMs: STEP_TIMEOUT_MS,
                },
                { timeoutMs: STEP_TIMEOUT_MS + 5000 },
              );
              expect(completed.status, `${phase}: ${JSON.stringify(completed)}`).toBe("ok");
              const history = await client.request<{ messages: HistoryMessage[] }>("chat.history", {
                sessionKey,
                limit: 50,
              });
              const turnMessages = currentTurnMessages(history.messages);
              console.log(
                `[knowledge-chat-live] turn-observation ${JSON.stringify({
                  phase,
                  terminalReply: completed.terminalReply,
                  tools: summarizeToolEvents(turnMessages),
                })}`,
              );
              if (requiredTool) {
                const invoked = hasToolInvocation(turnMessages, requiredTool);
                if (!invoked) {
                  console.log(
                    `[knowledge-chat-live] missing-tool ${JSON.stringify({
                      phase,
                      requiredTool,
                      terminalReply: completed.terminalReply,
                      messages: turnMessages.map(summarizeHistoryMessage),
                    })}`,
                  );
                }
                expect(
                  invoked,
                  `${phase}: expected ${requiredTool} invocation in chat history`,
                ).toBe(true);
              }
              const assistant = history.messages.findLast((entry) => entry.role === "assistant");
              const content = assistant?.content;
              const terminal = completed.terminalReply;
              const text =
                (terminal?.disposition === "visible" ? terminal.text : undefined) ??
                (typeof content === "string"
                  ? content
                  : (content
                      ?.flatMap((part) => (part.type === "text" && part.text ? [part.text] : []))
                      .join("\n") ?? ""));
              expect(text.trim(), `${phase}: visible reply`).not.toBe("");
              const usageReport = await client.request<SessionsUsageResult>("sessions.usage", {
                key: sessionKey,
                range: "all",
              });
              usage.push({ phase, session: sessionKey, totals: usageReport.totals });
              console.log(`[knowledge-chat-live] ${JSON.stringify(usage.at(-1))}`);
              return text;
            };

            await turn(
              "save",
              captureSession,
              `请将下面原文逐字保存到我的知识库。标题“${title}”，来源 ${sourceUri}，作者 synthetic-user。原文：\n${original}`,
              "knowledge_write",
            );
            const saved = await execute({ operation: "list", input: { limit: 10 } });
            expect(saved, "save must create exactly one real material").toHaveLength(1);
            const id = saved[0]!.id;
            expect(await execute({ operation: "read", input: { id } })).toMatchObject({
              body: original,
              revision: 1,
              sourceUri,
              author: "synthetic-user",
            });
            if (processing) {
              const organization = await execute({ operation: "organization", input: { id } });
              console.log(`[knowledge-chat-live] organization ${JSON.stringify(organization)}`);
              expect(organization.status).toBe("organized");
              expect(organization.organization?.entries.length).toBeGreaterThan(0);
              for (const entry of organization.organization?.entries ?? []) {
                expect(original).toContain(entry.quote);
              }
            }

            const recalled = await turn(
              "cross-session-recall",
              recallSession,
              `请从我的知识库找出“${title}”的复习安排。请写明安排、尚未决定的事项，并引用资料编号、当前版本和来源。`,
              "knowledge_read",
            );
            expect(recalled).toMatch(/周三/);
            expect(recalled).toMatch(/线性代数/);
            expect(recalled).toMatch(/未.*决定|没有决定|未定|不确定|暂不决定/);
            expect(recalled).toContain(id);
            expect(recalled).toContain(sourceUri);

            await turn(
              "correct",
              recallSession,
              `请纠正知识库中“${title}”的安排，完整替换原文为下面这段，其他资料不变，并说明当前原文版本（不是整理解释版本）。\n${corrected}`,
              "knowledge_write",
            );
            const correctedMaterial = await execute({ operation: "read", input: { id } });
            console.log(
              `[knowledge-chat-live] correct-material ${JSON.stringify({
                id,
                revision: correctedMaterial.revision,
                body: correctedMaterial.body,
              })}`,
            );
            expect(correctedMaterial).toMatchObject({ body: corrected, revision: 2 });
            expect(await execute({ operation: "search", input: { terms: ["周三"] } })).toEqual([]);
            expect(await execute({ operation: "history", input: { id } })).toHaveLength(2);

            await turn(
              "delete",
              captureSession,
              `请从知识库删除“${title}”这条材料及其全部历史修订，保留其他资料。请先确认它的当前版本再删除。`,
              "knowledge_write",
            );
            expect(await execute({ operation: "list", input: { limit: 10 } })).toEqual([]);
            await expect(execute({ operation: "read", input: { id } })).rejects.toThrow(
              /deleted|not found/i,
            );

            const afterDelete = await turn(
              "query-after-delete",
              recallSession,
              `请重新查询知识库：“${title}”现在保存了什么复习安排？以当前库为准，查不到时请明确说明，不用以前聊天里的内容代答。`,
              "knowledge_read",
            );
            expect(afterDelete).toMatch(
              /已被?删除|未找到|没有找到|查无|没有.*记录|没有.*资料|无.*记录|不存在.*记录/,
            );
            expect(afterDelete).not.toMatch(/周三|周六|线性代数|synthetic:knowledge-chat:/);
            expect(
              await execute({ operation: "search", input: { terms: [title, "周六"] } }),
            ).toEqual([]);
          },
          async () => {
            console.log(
              `[knowledge-chat-live] finished phase=${phase}; measured usage reports=${usage.length}`,
            );
            if (gateway) {
              await disconnectGatewayClient(gateway.client);
            }
          },
          async () => {
            await gateway?.server.close({ reason: "synthetic knowledge chat live test complete" });
          },
          () => knowledge.close(),
        );
      },
    );
  },
);
