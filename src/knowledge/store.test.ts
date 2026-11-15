import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { KnowledgeStore } from "./store.js";

const directories: string[] = [];
function file() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mycortex-knowledge-"));
  directories.push(dir);
  return path.join(dir, "knowledge.sqlite");
}
const input = {
  requestKey: "synthetic-1",
  title: "合成课程笔记",
  body: "卷积可以描述线性系统的响应；完成度 50%。",
  sourceUri: "synthetic:course-note",
  author: "synthetic-user",
  submittedBy: "local-operator",
  observedAt: "2026-11-15T00:00:00.000Z",
  kind: "text" as const,
};
afterEach(() => {
  for (const dir of directories.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("knowledge material lifecycle", () => {
  it("persists original Chinese text and source, searches literally with bounded results", () => {
    const filename = file();
    let store = new KnowledgeStore(filename, { create: true });
    const saved = store.submit(input);
    expect(store.submit(input)).toEqual(saved);
    expect(() => store.submit({ ...input, body: "different" })).toThrow(/request/i);
    store.close();
    store = new KnowledgeStore(filename);
    try {
      expect(store.read(saved.id)).toMatchObject({ ...input, revision: 1, id: saved.id });
      expect(store.search("卷积")).toMatchObject([{ id: saved.id, revision: 1 }]);
      expect(store.search("50%")).toHaveLength(1);
      expect(store.search("' OR 1=1 --")).toEqual([]);
      expect(() => store.search("", 1)).toThrow();
      expect(() => store.search("卷积", 5000)).toThrow();
    } finally {
      store.close();
    }
  });

  it("keeps historical source and rejects stale corrections and deletes", () => {
    const store = new KnowledgeStore(file(), { create: true });
    try {
      const saved = store.submit(input);
      const changed = store.correct(saved.id, 1, {
        body: "修正：频域乘积对应时域卷积。",
        note: "合成纠正",
        submittedBy: "local-operator",
      });
      expect(changed.revision).toBe(2);
      expect(store.search("50%")).toEqual([]);
      expect(store.read(saved.id, 1).body).toBe(input.body);
      expect(store.read(saved.id).sourceUri).toBe(input.sourceUri);
      expect(store.history(saved.id)).toHaveLength(2);
      expect(() =>
        store.correct(saved.id, 1, { body: "stale", note: "stale", submittedBy: "local-operator" }),
      ).toThrow(/revision/i);
      expect(() => store.remove(saved.id, 1)).toThrow(/revision/i);
      store.remove(saved.id, 2);
      expect(store.search("卷积")).toEqual([]);
      expect(() => store.read(saved.id)).toThrow(/deleted/i);
      expect(() => store.read(saved.id, 1)).toThrow(/deleted/i);
      expect(() => store.submit(input)).toThrow(/deleted/i);
      expect(() =>
        store.correct(saved.id, 2, {
          body: "resurrect",
          note: "bad",
          submittedBy: "local-operator",
        }),
      ).toThrow(/deleted/i);
      const bundle = JSON.stringify(store.export());
      expect(bundle).not.toContain("50%");
      expect(bundle).not.toContain("synthetic:course-note");
      expect(bundle).not.toContain("频域");
    } finally {
      store.close();
    }
  });

  it("exports and restores revisions and tombstones only into an empty store", () => {
    const source = new KnowledgeStore(file(), { create: true });
    const target = new KnowledgeStore(file(), { create: true });
    try {
      const saved = source.submit(input);
      source.correct(saved.id, 1, {
        body: "new",
        submittedBy: "local-operator",
        note: "correction",
      });
      const deleted = source.submit({ ...input, requestKey: "delete-me" });
      source.remove(deleted.id, 1);
      const bundle = source.export();
      const incomplete = structuredClone(bundle);
      incomplete.revisions.pop();
      expect(() => target.import(incomplete)).toThrow(/revision/i);
      const altered = structuredClone(bundle);
      const original = altered.revisions.find(
        (row) => row.materialId === saved.id && row.revision === 1,
      );
      if (!original) {
        throw new Error("Fixture lacks original revision");
      }
      original.body = "tampered original";
      expect(() => target.import(altered)).toThrow(/fingerprint/i);
      expect(target.search("卷积")).toEqual([]);
      target.import(bundle);
      expect(target.read(saved.id)).toEqual(source.read(saved.id));
      expect(target.read(saved.id, 1)).toEqual(source.read(saved.id, 1));
      expect(() => target.submit({ ...input, requestKey: "delete-me" })).toThrow(/deleted/i);
      expect(() => target.import(bundle)).toThrow(/empty/i);
    } finally {
      source.close();
      target.close();
    }
  });

  it("rejects unknown/corrupt imports atomically and distinguishes references from saved text", () => {
    const store = new KnowledgeStore(file(), { create: true });
    try {
      expect(() => store.import({ format: "mycortex.materials", version: 999 })).toThrow();
      const ref = store.submit({
        ...input,
        kind: "reference",
        body: "",
        sourceUri: "https://example.invalid/article",
      });
      expect(store.read(ref.id)).toMatchObject({ kind: "reference", body: "" });
      expect(() =>
        store.submit({ ...input, requestKey: "huge", body: "界".repeat(100000) }),
      ).toThrow();
    } finally {
      store.close();
    }
  });

  it("refuses uninitialized and unrelated databases", () => {
    const filename = file();
    expect(() => new KnowledgeStore(filename)).toThrow(/init/i);
    fs.writeFileSync(filename, "not a database");
    expect(() => new KnowledgeStore(filename, { create: true })).toThrow();
  });
});
