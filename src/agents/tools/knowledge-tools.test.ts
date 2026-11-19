import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, expect, it } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { ToolsSchema } from "../../config/zod-schema.agent-runtime.js";
import { createKnowledgeTools } from "./knowledge-tools.js";

const directories: string[] = [];
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of cleanups.splice(0)) {
    await close();
  }
  for (const directory of directories.splice(0)) {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

it("validates an explicit knowledge connection and leaves the default disabled", () => {
  expect(
    createKnowledgeTools({ getConfig: () => ({}), connectionId: "owner", assertCurrent() {} }),
  ).toEqual([]);
  expect(
    ToolsSchema.safeParse({
      knowledge: { directory: os.tmpdir(), connections: { owner: ["read", "submit"] } },
    }).success,
  ).toBe(true);
  expect(
    ToolsSchema.safeParse({
      knowledge: { directory: "relative", connections: { owner: ["read"] } },
    }).success,
  ).toBe(false);
});

it("uses the same entry to save, retrieve current evidence, correct and delete across connections", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "knowledge-tools-"));
  directories.push(directory);
  const config: OpenClawConfig = {
    tools: {
      knowledge: {
        directory,
        connections: { owner: ["read", "submit", "manage"], reader: ["read"], inbox: ["submit"] },
      },
    },
  };
  const toolsFor = (connectionId: string) =>
    createKnowledgeTools({
      getConfig: () => config,
      connectionId,
      assertCurrent() {},
      registerCleanup: (close) => cleanups.push(close),
    });
  const owner = toolsFor("owner");
  const writer = owner.find((tool) => tool.name === "knowledge_write")!;
  const reader = toolsFor("reader").find((tool) => tool.name === "knowledge_read")!;
  const submission = {
    action: "submit",
    requestId: "synthetic-save-1",
    title: "合成周末计划",
    body: "我打算周六复习卷积，尚未确定是否参加活动。",
    author: "synthetic-user",
    organization: {
      topics: ["周末计划"],
      entries: [
        {
          summary: "周末复习计划，参加活动未定",
          subject: "synthetic-user",
          stance: "intent",
          quote: "我打算周六复习卷积，尚未确定是否参加活动。",
          timeText: "周六",
        },
      ],
    },
  };
  const { organization: _organization, ...rawOnly } = submission;
  await expect(writer.execute("unrefined", rawOnly)).rejects.toThrow(/refin/i);
  const saved = await writer.execute("save-1", submission);
  expect(saved.details).toMatchObject({ status: "saved", revision: 1 });
  const { id } = saved.details as { id: string };
  expect((await writer.execute("retry-new-mcp-call", submission)).details).toMatchObject({
    id,
    revision: 1,
  });
  const results = await reader.execute("search-1", { action: "search", terms: ["周末", "周六"] });
  expect(results.details).toMatchObject({
    results: [
      { id, revision: 1, sourceUri: "mycortex:connection:owner", author: "synthetic-user" },
    ],
  });
  const listed = await reader.execute("list-1", { action: "list" });
  expect(listed.details).toMatchObject({ results: [{ id }] });
  const interpretation = {
    topics: ["个人学习安排"],
    entries: [
      {
        summary: "计划周六复习",
        subject: "synthetic-user",
        stance: "intent",
        quote: "我打算周六复习卷积",
        timeText: "周六",
      },
    ],
  };
  await writer.execute("manual-view", {
    action: "correct_organization",
    id,
    expectedRevision: 1,
    expectedOrganizationRevision: 1,
    organization: interpretation,
  });
  expect(
    (await reader.execute("derived-topic", { action: "context", terms: ["个人学习安排"] })).details,
  ).toMatchObject({ results: [{ id, organization: { manual: true, revision: 2 } }] });
  await expect(
    writer.execute("stale-view", {
      action: "correct_organization",
      id,
      expectedRevision: 1,
      expectedOrganizationRevision: 1,
      organization: interpretation,
    }),
  ).rejects.toThrow(/revision/i);
  await writer.execute("correct-1", {
    action: "correct",
    id,
    expectedRevision: 1,
    body: "修正：我打算周日复习拉普拉斯变换。",
  });
  expect(
    (await reader.execute("old", { action: "search", terms: ["卷积"] })).details,
  ).toMatchObject({ results: [] });
  expect((await reader.execute("current", { action: "read", id })).details).toMatchObject({
    revision: 2,
    body: "修正：我打算周日复习拉普拉斯变换。",
  });
  await expect(
    writer.execute("stale", {
      action: "correct",
      id,
      expectedRevision: 1,
      body: "过期",
      note: "过期",
    }),
  ).rejects.toThrow(/revision/i);
  const inbox = toolsFor("inbox");
  expect(inbox.map((tool) => tool.name)).toEqual(["knowledge_write"]);
  await expect(
    inbox[0]!.execute("probe", {
      action: "correct",
      id,
      expectedRevision: 2,
      body: "越权",
      note: "越权",
    }),
  ).rejects.toThrow(/permission|authorized/i);
  await writer.execute("delete-1", { action: "delete", id, expectedRevision: 2 });
  await expect(reader.execute("deleted", { action: "read", id })).rejects.toThrow(/deleted/i);
  expect((await reader.execute("after", { action: "list" })).details).toMatchObject({
    results: [],
  });
  config.tools!.knowledge!.connections.reader = [];
  await expect(reader.execute("revoked", { action: "list" })).rejects.toThrow(
    /permission|authorized/i,
  );
});

it("reads the live bytes of an indexed file without saving a body snapshot", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "knowledge-files-tool-"));
  directories.push(directory);
  const filename = path.join(directory, "synthetic-note.txt");
  await fs.writeFile(filename, "第一版合成文件");
  const config: OpenClawConfig = {
    tools: {
      knowledge: {
        directory: path.join(directory, "store"),
        fileRoots: [directory],
        connections: { owner: ["read", "submit", "manage"] },
      },
    },
  };
  const tools = createKnowledgeTools({
    getConfig: () => config,
    connectionId: "owner",
    assertCurrent() {},
    registerCleanup: (close) => cleanups.push(close),
  });
  const writer = tools.find((tool) => tool.name === "knowledge_write")!;
  const reader = tools.find((tool) => tool.name === "knowledge_read")!;
  const saved = await writer.execute("index-file", {
    action: "submit",
    title: "合成文件",
    sourceUri: pathToFileURL(filename).href,
    body: "",
    kind: "reference",
  });
  const { id } = saved.details as { id: string };
  expect((await reader.execute("read-index", { action: "read", id })).details).toMatchObject({
    body: "",
    kind: "reference",
  });
  const first = await reader.execute("read-file", { action: "read_file", id });
  expect(first.details).toMatchObject({ body: "第一版合成文件", savedSnapshot: false });
  await fs.writeFile(filename, "第二版合成文件");
  expect(
    (await reader.execute("read-file-new", { action: "read_file", id })).details,
  ).toMatchObject({ body: "第二版合成文件" });
  await fs.unlink(filename);
  await expect(reader.execute("missing-file", { action: "read_file", id })).rejects.toThrow();
});
