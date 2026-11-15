import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { openNodeSqliteDatabase } from "../infra/node-sqlite.js";
import { KnowledgeStore } from "./store.js";

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
it("queues durable source-bound interpretations, rejects bad quotes and makes corrections/deletions invalidate them", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "knowledge-organization-"));
  directories.push(directory);
  let store = new KnowledgeStore(path.join(directory, "knowledge.sqlite"), { create: true });
  const saved = store.submit({
    requestKey: "synthetic-view",
    title: "计划",
    body: "我打算周日学习卷积。",
    sourceUri: "synthetic:plan",
    author: "synthetic",
    submittedBy: "owner",
    kind: "text",
  });
  store.close();
  store = new KnowledgeStore(path.join(directory, "knowledge.sqlite"));
  try {
    expect(store.pendingOrganizations()).toMatchObject([{ id: saved.id }]);
    const organization = {
      topics: ["学习计划"],
      entries: [
        {
          summary: "计划周日学习卷积",
          subject: "原作者",
          stance: "intent" as const,
          quote: "我打算周日学习卷积。",
          timeText: "周日",
        },
      ],
    };
    expect(() =>
      store.commitOrganization(saved.id, 1, {
        status: "organized",
        organization: {
          ...organization,
          entries: organization.entries.map((entry) =>
            Object.assign({}, entry, { quote: "我已学完" }),
          ),
        },
        processor: "test/model",
      }),
    ).toThrow(/quote/i);
    store.commitOrganization(saved.id, 1, {
      status: "organized",
      organization,
      processor: "test/model",
    });
    expect(store.organization(saved.id)).toMatchObject({
      status: "organized",
      sourceRevision: 1,
      organization,
    });
    expect(store.pendingOrganizations()).toEqual([]);
    store.correct(saved.id, 1, {
      body: "修正：我打算周六学习拉普拉斯变换。",
      note: "用户纠正",
      submittedBy: "owner",
    });
    expect(store.organization(saved.id)).toMatchObject({
      status: "pending",
      sourceRevision: 2,
      organization: null,
    });
    expect(() =>
      store.commitOrganization(saved.id, 1, {
        status: "organized",
        organization,
        processor: "stale/model",
      }),
    ).toThrow(/revision/i);
    store.remove(saved.id, 2);
    expect(store.pendingOrganizations()).toEqual([]);
    expect(() => store.organization(saved.id)).toThrow(/deleted/i);
    expect(() =>
      store.commitOrganization(saved.id, 2, {
        status: "empty",
        organization: { topics: [], entries: [] },
        processor: "late/model",
      }),
    ).toThrow(/deleted/i);
    expect(JSON.stringify(store.export())).not.toContain("卷积");
  } finally {
    store.close();
  }
});

it("upgrades v1 originals and rebuilds pending projections after a portable original-only import", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "knowledge-v1-upgrade-"));
  directories.push(directory);
  const filename = path.join(directory, "knowledge.sqlite");
  let store = new KnowledgeStore(filename, { create: true });
  const saved = store.submit({
    requestKey: "v1-note",
    title: "Legacy",
    body: "旧版保留的原文。",
    sourceUri: "synthetic:legacy",
    author: "synthetic",
    submittedBy: "owner",
    kind: "text",
  });
  store.close();
  const old = openNodeSqliteDatabase(filename);
  old.exec("DROP TABLE organizations; PRAGMA user_version = 1;");
  old.close();
  store = new KnowledgeStore(filename);
  try {
    expect(store.read(saved.id).body).toBe("旧版保留的原文。");
    expect(store.pendingOrganizations()).toMatchObject([{ id: saved.id }]);
    const { organizations: _organizations, ...exported } = store.export();
    const bundle = { ...exported, version: 1 };
    const restored = new KnowledgeStore(path.join(directory, "restored.sqlite"), { create: true });
    try {
      restored.import(bundle);
      expect(restored.organization(saved.id)).toMatchObject({
        status: "pending",
        sourceRevision: 1,
        organization: null,
      });
    } finally {
      restored.close();
    }
  } finally {
    store.close();
  }
});

it("protects completed/manual views and validates exact time evidence", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "knowledge-manual-view-"));
  directories.push(directory);
  const store = new KnowledgeStore(path.join(directory, "knowledge.sqlite"), { create: true });
  try {
    const saved = store.submit({
      requestKey: "manual-view",
      title: "计划",
      body: "我打算周日学习卷积。",
      sourceUri: "synthetic:manual",
      author: "synthetic",
      submittedBy: "owner",
      kind: "text",
    });
    const organization = {
      topics: ["学习计划"],
      entries: [
        {
          summary: "计划周日学习卷积",
          subject: "原作者",
          stance: "intent" as const,
          quote: "我打算周日学习卷积。",
          timeText: "周日",
        },
      ],
    };
    expect(() =>
      store.commitOrganization(saved.id, 1, {
        status: "organized",
        organization: {
          ...organization,
          entries: organization.entries.map((entry) =>
            Object.assign({}, entry, { timeText: "周六" }),
          ),
        },
        processor: "test/model",
      }),
    ).toThrow(/timeText/i);
    store.commitOrganization(saved.id, 1, {
      status: "organized",
      organization,
      processor: "test/model",
    });
    expect(store.searchMany(["卷积"])[0]?.organization).toMatchObject({
      status: "organized",
      sourceRevision: 1,
      organization,
    });
    expect(store.readSlice(saved.id).organization).toMatchObject({ status: "organized" });
    expect(() =>
      store.commitOrganization(saved.id, 1, { status: "empty", processor: "automatic/retry" }),
    ).toThrow(/completed/i);
    store.commitOrganization(
      saved.id,
      1,
      { status: "organized", organization, processor: "user/correction" },
      true,
      2,
    );
    expect(store.organization(saved.id).manual).toBe(true);
    expect(store.organization(saved.id).revision).toBe(3);
    expect(store.searchMany(["学习计划"])).toMatchObject([{ id: saved.id }]);
    const bundle = store.export();
    expect(bundle.version).toBe(2);
    expect(store.deletions()).toEqual([]);
    const restored = new KnowledgeStore(path.join(directory, "manual-restored.sqlite"), {
      create: true,
    });
    try {
      const invalidQuote = structuredClone(bundle);
      const firstOrganization = invalidQuote.organizations.at(0);
      if (!firstOrganization) {
        throw new Error("Expected exported organization");
      }
      firstOrganization.organization = JSON.stringify({
        ...organization,
        entries: organization.entries.map((entry) =>
          Object.assign({}, entry, { quote: "不存在的引文" }),
        ),
      });
      expect(() => restored.import(invalidQuote)).toThrow(/quote/i);
      expect(restored.list()).toEqual([]);
      const staleRevision = structuredClone(bundle);
      const staleOrganization = staleRevision.organizations.at(0);
      if (!staleOrganization) {
        throw new Error("Expected exported organization");
      }
      staleOrganization.sourceRevision = 2;
      expect(() => restored.import(staleRevision)).toThrow(/revision/i);
      expect(restored.list()).toEqual([]);
      const deletedParent = structuredClone(bundle);
      const deletedMaterial = deletedParent.materials.at(0);
      if (!deletedMaterial) {
        throw new Error("Expected exported material");
      }
      deletedMaterial.deletedAt = new Date().toISOString();
      deletedParent.revisions = [];
      expect(() => restored.import(deletedParent)).toThrow(/parent/i);
      expect(restored.list()).toEqual([]);
      restored.import(bundle);
      expect(restored.organization(saved.id)).toMatchObject({
        manual: true,
        revision: 3,
        organization,
      });
    } finally {
      restored.close();
    }
    expect(() =>
      store.commitOrganization(
        saved.id,
        1,
        { status: "organized", organization, processor: "stale/user" },
        true,
        2,
      ),
    ).toThrow(/revision/i);
    expect(() =>
      store.commitOrganization(saved.id, 1, {
        status: "organized",
        organization,
        processor: "late/model",
      }),
    ).toThrow(/manual|completed/i);
    store.correct(saved.id, 1, {
      body: "我打算周六学习卷积。",
      note: "源纠正",
      submittedBy: "owner",
    });
    expect(store.readSlice(saved.id, { revision: 1 }).organization).toBe(null);
    expect(store.organization(saved.id)).toMatchObject({
      status: "pending",
      organization: null,
      manual: false,
    });
    store.remove(saved.id, 2);
    expect(store.deletions()).toMatchObject([{ id: saved.id, currentRevision: 2 }]);
  } finally {
    store.close();
  }
});

it("retries a failed interpretation explicitly while preserving completed views", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "knowledge-retry-"));
  directories.push(directory);
  const store = new KnowledgeStore(path.join(directory, "knowledge.sqlite"), { create: true });
  try {
    const saved = store.submit({
      requestKey: "retry-view",
      title: "Synthetic retry",
      body: "原始材料",
      sourceUri: "synthetic:retry",
      author: "synthetic",
      submittedBy: "owner",
      kind: "text",
    });
    store.commitOrganization(saved.id, 1, { status: "failed", processor: "synthetic/failed" });
    expect(store.pendingOrganizations()).toMatchObject([{ id: saved.id }]);
    store.commitOrganization(saved.id, 1, {
      status: "organized",
      processor: "synthetic/retry",
      organization: {
        topics: ["重试"],
        entries: [
          {
            summary: "原始材料",
            subject: "source",
            stance: "explicit",
            quote: "原始材料",
            timeText: null,
          },
        ],
      },
    });
    expect(store.organization(saved.id)).toMatchObject({ status: "organized", revision: 3 });
    expect(store.pendingOrganizations()).toEqual([]);
    expect(() =>
      store.commitOrganization(saved.id, 1, { status: "failed", processor: "synthetic/late" }),
    ).toThrow(/completed/);
  } finally {
    store.close();
  }
});
