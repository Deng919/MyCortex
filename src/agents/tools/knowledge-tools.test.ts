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

it("advertises network navigation and explicit historical retrieval to read connections", () => {
  const [reader] = createKnowledgeTools({
    getConfig: () => ({
      tools: { knowledge: { directory: os.tmpdir(), connections: { reader: ["read"] } } },
    }),
    connectionId: "reader",
    assertCurrent() {},
  });
  expect(reader!.parameters).toMatchObject({
    properties: {
      action: { enum: expect.arrayContaining(["network", "projects"]) },
      entityId: { type: "string" },
      includeHistorical: { type: "boolean" },
      includeArchived: { type: "boolean" },
      limit: { maximum: 50 },
    },
  });
  expect(reader!.description).toMatch(/speaker.*addressee/i);
});

it("searches reusable project capabilities without implying execution", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "knowledge-project-tool-"));
  directories.push(directory);
  const config: OpenClawConfig = {
    tools: { knowledge: { directory, connections: { owner: ["read", "submit"] } } },
  };
  const tools = createKnowledgeTools({
    getConfig: () => config,
    connectionId: "owner",
    assertCurrent() {},
    registerCleanup: (close) => cleanups.push(close),
  });
  const writer = tools.find((tool) => tool.name === "knowledge_write")!;
  const reader = tools.find((tool) => tool.name === "knowledge_read")!;
  const profile = {
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
  };
  await writer.execute("project-save", {
    action: "submit",
    title: "知乎搜索工具",
    body: "知乎搜索工具位于 D:/Apps/zhihu-search，使用 scripts/search.ps1 搜索知乎帖子。",
    organization: {
      topics: ["项目", "知乎"],
      projectProfile: profile,
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
    },
  });
  const result = await reader.execute("project-search", {
    action: "projects",
    terms: ["知乎", "搜索"],
  });
  expect(result.details).toMatchObject({
    results: [
      {
        name: "知乎搜索工具",
        locations: [{ path: "D:/Apps/zhihu-search" }],
        capabilities: [{ entrypoint: { value: "scripts/search.ps1" } }],
      },
    ],
  });
  expect(result.details).not.toHaveProperty("executed");
});

it("returns source-backed participants and relations while keeping historical knowledge opt-in", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "knowledge-social-tool-"));
  directories.push(directory);
  const config: OpenClawConfig = {
    tools: { knowledge: { directory, connections: { owner: ["read", "submit"] } } },
  };
  const tools = createKnowledgeTools({
    getConfig: () => config,
    connectionId: "owner",
    assertCurrent() {},
    registerCleanup: (close) => cleanups.push(close),
  });
  const writer = tools.find((tool) => tool.name === "knowledge_write")!;
  const reader = tools.find((tool) => tool.name === "knowledge_read")!;
  const organization = {
    topics: ["合成协作"],
    entities: [
      { id: "synthetic:a", name: "合成人甲", kind: "person" },
      { id: "synthetic:b", name: "合成人乙", kind: "person" },
    ],
    context: {
      conversationId: "synthetic:conversation",
      participantIds: ["synthetic:a", "synthetic:b"],
      summary: "合成项目交流",
    },
    entries: [
      {
        summary: "甲计划复习",
        subject: "合成人甲",
        stance: "intent",
        quote: "甲计划复习。",
        timeText: null,
        speakerIds: ["synthetic:a"],
        addresseeIds: ["synthetic:b"],
      },
      {
        summary: "乙称甲为同事",
        subject: "合成人乙",
        stance: "explicit",
        quote: "乙称甲为同事。",
        timeText: null,
        speakerIds: ["synthetic:b"],
        aboutIds: ["synthetic:a"],
        relation: { fromId: "synthetic:b", toId: "synthetic:a", label: "同事", basis: "explicit" },
      },
    ],
  };
  const saved = await writer.execute("social-save", {
    action: "submit",
    title: "合成关系",
    body: "甲计划复习。乙称甲为同事。",
    organization,
  });
  const { id } = saved.details as { id: string };
  expect(
    (await reader.execute("social-context", { action: "context", terms: ["合成协作"] })).details,
  ).toMatchObject({
    results: [
      {
        organization: {
          organization: {
            entities: organization.entities,
            context: organization.context,
            entries: [
              expect.anything(),
              expect.objectContaining({
                speakerIds: ["synthetic:b"],
                relation: organization.entries[1]!.relation,
              }),
            ],
          },
        },
      },
    ],
  });
  expect(
    (
      await reader.execute("social-network", {
        action: "network",
        entityId: "synthetic:b",
        limit: 50,
      })
    ).details,
  ).toMatchObject({
    entities: expect.arrayContaining([expect.objectContaining({ id: "synthetic:b" })]),
    relations: [expect.objectContaining({ label: "同事", materialId: id, revision: 1 })],
    conversations: [
      expect.objectContaining({ conversationId: "synthetic:conversation", materialId: id }),
    ],
    truncated: false,
  });
  await writer.execute("social-history", {
    action: "submit",
    title: "合成往事",
    body: "甲计划复习。乙称甲为同事。",
    organization: { ...organization, relevance: "historical" },
  });
  expect((await reader.execute("current-list", { action: "list" })).details).toMatchObject({
    results: [{ id }],
  });
  const historical = await reader.execute("history-search", {
    action: "search",
    terms: ["合成协作"],
    includeHistorical: true,
  });
  expect((historical.details as { results: unknown[] }).results).toHaveLength(2);
  expect(
    (
      (await reader.execute("history-list", { action: "list", includeHistorical: true }))
        .details as { results: unknown[] }
    ).results,
  ).toHaveLength(2);
  await writer.execute("large-network", {
    action: "submit",
    title: "合成网络预算",
    body: "甲计划复习。乙称甲为同事。",
    organization: {
      ...organization,
      entities: [
        ...organization.entities,
        ...Array.from({ length: 22 }, (__, entityIndex) => ({
          id: `synthetic:large:${entityIndex}`,
          name: `合成人物${entityIndex}`,
          kind: "person",
          aliases: Array.from(
            { length: 12 },
            (___, aliasIndex) => `${aliasIndex}${"合".repeat(150)}`,
          ),
        })),
      ],
    },
  });
  const bounded = await reader.execute("bounded-network", { action: "network", limit: 50 });
  expect(bounded.details).toMatchObject({ truncated: true });
  expect(JSON.stringify(bounded.details, null, 2).length).toBeLessThanOrEqual(12000);
  config.tools!.knowledge!.connections.owner = [];
  await expect(reader.execute("network-revoked", { action: "network" })).rejects.toThrow(
    /permission|authorized/i,
  );
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
