import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { entityKey } from "./social-contract.js";
import { KnowledgeStore } from "./store.js";

const cleanup: Array<() => void> = [];
afterEach(() =>
  cleanup
    .splice(0)
    .toReversed()
    .forEach((close) => close()),
);
function fixture() {
  const directory = mkdtempSync(path.join(os.tmpdir(), "knowledge-social-"));
  const store = new KnowledgeStore(path.join(directory, "knowledge.sqlite"), { create: true });
  cleanup.push(() => {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  });
  return store;
}
const source = {
  requestKey: "social-synthetic",
  title: "讨论",
  body: "我与小林是课程甲的师生关系。老师，我计划下周提交报告。无关闲聊。",
  sourceUri: "synthetic:private/teacher",
  author: "合成参与者",
  submittedBy: "synthetic-agent",
  kind: "text" as const,
};
const organization = {
  topics: ["课程甲"],
  privacyLevel: "personal" as const,
  entities: [
    { id: "self", kind: "person" as const, name: "我" },
    { id: "teacher", kind: "person" as const, name: "小林", aliases: ["林老师"] },
    { id: "other", kind: "person" as const, name: "小林" },
  ],
  context: {
    conversationId: "synthetic:teacher-chat",
    participantIds: ["self", "teacher"],
    summary: "向课程甲老师沟通报告安排",
  },
  relevance: "background" as const,
  entries: [
    {
      summary: "课程甲中本人称小林为老师",
      subject: "本人",
      stance: "explicit" as const,
      quote: "我与小林是课程甲的师生关系。",
      timeText: null,
      speakerIds: ["self"],
      addresseeIds: ["teacher"],
      aboutIds: ["self", "teacher"],
      relation: {
        fromId: "self",
        toId: "teacher",
        label: "课程甲老师",
        basis: "explicit" as const,
      },
    },
  ],
};

it("keeps specific people and dialogue roles with source-backed relations, without merging names", () => {
  const store = fixture();
  const saved = store.submitKnowledge(source, organization)!;
  expect(store.readSlice(saved.id).organization?.organization).toMatchObject(organization);
  const graph = store.network({});
  expect(graph.entities.map((entity) => entity.id)).toEqual(
    expect.arrayContaining(["self", "teacher", "other"]),
  );
  expect(graph.relations).toMatchObject([
    { fromId: "self", toId: "teacher", basis: "explicit", materialId: saved.id },
  ]);
  expect(graph.conversations).toMatchObject([
    { participantIds: ["self", "teacher"], summary: "向课程甲老师沟通报告安排" },
  ]);
  expect(() =>
    store.submitKnowledge(
      { ...source, requestKey: "dangling" },
      { ...organization, context: { ...organization.context, participantIds: ["missing"] } },
    ),
  ).toThrow(/entity|reference/i);
  expect(store.searchMany(["林老师"])).toMatchObject([{ id: saved.id }]);
});

it("excludes old temporary knowledge before paging, while keeping it explicitly accessible", () => {
  const store = fixture();
  const current = store.submitKnowledge(source, organization)!;
  store.submitKnowledge(
    { ...source, requestKey: "old" },
    { ...organization, relevance: "historical" },
  );
  expect(store.list(1, 0)).toMatchObject([{ id: current.id }]);
  expect(store.searchMany(["课程甲"], 10)).toHaveLength(1);
  expect(store.searchMany(["课程甲"], 10, true)).toHaveLength(2);
  expect(store.list(20, 0, true)).toHaveLength(2);
});

it("preserves identity context on correction, invalidates relations, and round-trips then deletes", () => {
  const store = fixture();
  const saved = store.submitKnowledge(source, organization)!;
  store.correct(saved.id, 1, {
    title: "报告安排已更新",
    body: "计划有变，重新沟通报告安排。",
    note: "用户更新",
    submittedBy: "synthetic-user",
  });
  const corrected = store.readSlice(saved.id);
  expect(corrected.title).toBe("报告安排已更新");
  expect(corrected.organization?.organization).toMatchObject({
    entities: organization.entities,
    context: organization.context,
    entries: [],
  });
  expect(store.network({}).relations).toEqual([]);
  const restored = fixture();
  restored.import(store.export());
  expect(restored.readSlice(saved.id).organization?.organization).toMatchObject({
    context: organization.context,
    entries: [],
  });
  restored.remove(saved.id, 2);
  expect(restored.network({}).entities).toEqual([]);
});

it("anchors platform identities to their account scope and keeps renamed entities stable", () => {
  const identity = {
    platform: "synthetic",
    accountScope: "owner-a",
    nativeId: "contact-1",
    nickname: "小林",
    remark: "课程甲老师",
  };
  const key = entityKey(identity);
  expect(entityKey({ ...identity, nickname: "改名了", remark: "新备注" })).toBe(key);
  expect(entityKey({ ...identity, accountScope: "owner-b" })).not.toBe(key);
  const store = fixture();
  const payload = {
    ...organization,
    entities: [
      ...organization.entities,
      { id: key, name: "小林", kind: "person" as const, identity },
    ],
  };
  expect(() =>
    store.submitKnowledge(source, {
      ...payload,
      entities: [
        ...payload.entities.slice(0, -1),
        { ...payload.entities.at(-1)!, identity: { ...identity, nativeId: "different-person" } },
      ],
    }),
  ).toThrow(/identity/i);
  const saved = store.submitKnowledge(source, payload)!;
  const graph = store.network({});
  expect(graph.entities.find((entity) => entity.id === key)).toMatchObject({
    remark: "课程甲老师",
    nickname: "小林",
    identity,
  });
  expect(graph.privacyLevel).toBe("personal");
  expect(graph.entities.find((entity) => entity.id === key)?.materialIds).toEqual([saved.id]);
});
