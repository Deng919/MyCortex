import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { KnowledgeStore } from "./store.js";

const cleanup: Array<() => void> = [];
afterEach(() =>
  cleanup
    .splice(0)
    .toReversed()
    .forEach((close) => close()),
);

function fixture() {
  const directory = mkdtempSync(path.join(os.tmpdir(), "knowledge-project-index-"));
  const store = new KnowledgeStore(path.join(directory, "knowledge.sqlite"), { create: true });
  cleanup.push(() => {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  });
  return store;
}

const source = {
  requestKey: "project-index-synthetic",
  title: "知乎搜索工具项目说明",
  body: "知乎搜索工具位于 D:/Apps/zhihu-search，使用 scripts/search.ps1 搜索知乎帖子。设计思路是复用已有浏览器会话并保留来源链接。",
  sourceUri: "synthetic:project/zhihu-search",
  author: "synthetic-user",
  submittedBy: "synthetic-agent",
  kind: "text" as const,
};

const projectProfile = {
  entityId: "project:zhihu-search",
  name: "知乎搜索工具",
  purpose: "搜索知乎帖子并保留来源链接，供其他 AI 复用。",
  status: "active" as const,
  locations: [
    { kind: "workspace" as const, path: "D:/Apps/zhihu-search", note: "项目工作区" },
    { kind: "entrypoint" as const, path: "D:/Apps/zhihu-search/scripts/search.ps1" },
  ],
  capabilities: [
    {
      name: "搜索知乎帖子",
      summary: "按关键词搜索知乎帖子并返回来源链接。",
      entrypoint: { kind: "script" as const, value: "scripts/search.ps1" },
      usage: "运行 scripts/search.ps1 -Query <关键词>",
    },
    {
      name: "读取帖子正文",
      summary: "打开搜索结果中的知乎帖子并读取正文。",
      entrypoint: { kind: "skill" as const, value: "browser" },
      usage: "先搜索，再用浏览器工具打开返回的链接。",
    },
  ],
  design: "复用已有浏览器会话并保留来源链接，不把网页缓存直接当作知识。",
  dependencies: ["Microsoft Edge", "已有浏览器会话"],
  limitations: ["需要有效的知乎登录状态"],
  verifiedAt: "2026-11-20T10:00:00+08:00",
};

const organization = {
  topics: ["项目", "知乎"],
  projectProfile,
  entities: [{ id: "project:zhihu-search", name: "知乎搜索工具", kind: "project" as const }],
  entries: [
    {
      summary: "知乎搜索工具可以搜索帖子并读取正文。",
      subject: "知乎搜索工具",
      stance: "explicit" as const,
      quote: source.body,
      timeText: null,
      aboutIds: ["project:zhihu-search"],
    },
  ],
};

it("returns a structured project card with locations, capabilities, usage, design, and source evidence", () => {
  const store = fixture();
  const saved = store.submitKnowledge(source, organization)!;
  const results = store.projects(["知乎", "搜索"]);

  expect(results).toHaveLength(1);
  expect(results[0]).toMatchObject({
    id: "project:zhihu-search",
    name: "知乎搜索工具",
    purpose: projectProfile.purpose,
    locations: projectProfile.locations,
    capabilities: projectProfile.capabilities,
    design: projectProfile.design,
    verifiedAt: projectProfile.verifiedAt,
    materialIds: [saved.id],
  });
});

it("filters archived projects before paging and returns no guessed project for unrelated terms", () => {
  const store = fixture();
  store.submitKnowledge(source, organization);
  store.submitKnowledge(
    { ...source, requestKey: "project-index-archived", title: "旧知乎工具" },
    {
      ...organization,
      entities: [{ id: "project:old-zhihu", name: "旧知乎工具", kind: "project" as const }],
      projectProfile: {
        ...projectProfile,
        entityId: "project:old-zhihu",
        name: "旧知乎工具",
        status: "archived",
      },
      entries: organization.entries.map((entry) => ({
        ...entry,
        aboutIds: ["project:old-zhihu"],
      })),
    },
  );

  expect(store.projects(["知乎"], 1)).toHaveLength(1);
  expect(store.projects(["知乎"], 10).map((project) => project.name)).toEqual(["知乎搜索工具"]);
  expect(store.projects(["知乎"], 10, true).map((project) => project.name)).toEqual([
    "知乎搜索工具",
    "旧知乎工具",
  ]);
  expect(store.projects(["微博"])).toEqual([]);
});

it("rejects malformed project profile values at the knowledge boundary", () => {
  const store = fixture();
  const malformedUnknown: unknown = structuredClone({
    ...projectProfile,
    status: "running",
  });
  const malformed = malformedUnknown as typeof projectProfile;
  expect(() =>
    store.submitKnowledge(source, {
      ...organization,
      projectProfile: malformed,
    }),
  ).toThrow(/project|status/i);
  expect(() =>
    store.submitKnowledge(source, {
      ...organization,
      projectProfile: { ...projectProfile, entityId: "project:missing" },
    }),
  ).toThrow(/project entity/i);
});

it("preserves project profile metadata when the source is corrected and requeued", () => {
  const store = fixture();
  const saved = store.submitKnowledge(source, organization)!;
  store.correct(saved.id, 1, {
    title: "知乎搜索工具更新",
    body: "知乎搜索工具现在使用 scripts/search.ps1 搜索知乎帖子，并保留来源链接。",
    note: "项目说明更新",
    submittedBy: "synthetic-user",
  });
  expect(store.organization(saved.id)).toMatchObject({
    status: "pending",
    organization: { projectProfile },
  });
});
