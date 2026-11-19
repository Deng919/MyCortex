import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { KnowledgeStore } from "./store.js";

const closes: Array<() => void> = [];
afterEach(() =>
  closes
    .splice(0)
    .toReversed()
    .forEach((close) => close()),
);
function fixture() {
  const directory = mkdtempSync(path.join(os.tmpdir(), "knowledge-refinement-"));
  closes.push(() => rmSync(directory, { recursive: true, force: true }));
  const store = new KnowledgeStore(path.join(directory, "knowledge.sqlite"), { create: true });
  closes.push(() => store.close());
  return store;
}
const source = {
  requestKey: "synthetic-refinement",
  title: "按天归档",
  kind: "text" as const,
  body: "甲：今天天气不错。\n本人：我可能明年读研，还没有决定。\n乙：我喜欢跑步。",
  sourceUri: "synthetic:private-discussion",
  author: "讨论参与者",
  submittedBy: "synthetic-importer",
};
const organization = {
  topics: ["学习计划"],
  entries: [
    {
      subject: "本人",
      stance: "uncertain" as const,
      summary: "本人尚未决定是否明年读研。",
      quote: "我可能明年读研，还没有决定。",
      timeText: "明年",
    },
  ],
};
it("requires source-backed refinement before saving and excludes unrelated raw messages", () => {
  const store = fixture();
  expect(() => store.submitKnowledge(source)).toThrow(/refin/i);
  expect(store.list()).toEqual([]);
  expect(() =>
    store.submitKnowledge(source, {
      ...organization,
      entries: [{ ...organization.entries[0]!, quote: "我决定明年读研。" }],
    }),
  ).toThrow(/source/i);
  expect(store.list()).toEqual([]);
  expect(store.submitKnowledge(source, { topics: [], entries: [] })).toBeNull();
  const saved = store.submitKnowledge(source, organization)!;
  expect(saved.title).toContain("尚未决定");
  expect(saved.title).not.toContain("按天归档");
  expect(saved.body).toContain("本人尚未决定是否明年读研。");
  expect(saved.body).toContain("我可能明年读研，还没有决定。");
  expect(saved.body).not.toContain("天气");
  expect(saved.body).not.toContain("跑步");
  expect(store.searchMany(["天气"])).toEqual([]);
  expect(store.read(saved.id).body).toEqual(saved.body);
});
it("reconciles retries by the source fingerprint, preserves corrections, and prevents resurrection", () => {
  const store = fixture();
  const saved = store.submitKnowledge(source, organization)!;
  const rephrased = {
    ...organization,
    entries: [{ ...organization.entries[0]!, summary: "读研计划未定" }],
  };
  expect(store.submitKnowledge(source, rephrased)?.id).toBe(saved.id);
  expect(() =>
    store.submitKnowledge({ ...source, body: source.body + "新增" }, organization),
  ).toThrow(/different/i);
  store.correct(saved.id, 1, {
    body: "用户纠正后的知识",
    note: "用户明确纠正",
    submittedBy: "synthetic-user",
  });
  expect(store.submitKnowledge(source, organization)?.body).toBe("用户纠正后的知识");
  const exported = store.export();
  const restored = fixture();
  restored.import(exported);
  expect(restored.submitKnowledge(source, organization)?.id).toBe(saved.id);
  store.remove(saved.id, 2);
  expect(() => store.submitKnowledge(source, organization)).toThrow(/deleted/i);
});
