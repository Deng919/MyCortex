import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { importQqDigestBundle } from "./qqdigest-import.js";
import { KnowledgeStore } from "./store.js";

function bundle(body = "# 教程\n\n正文") {
  return {
    format: "mycortex.qqdigest" as const,
    version: 1 as const,
    exportedAt: "2026-11-15T00:00:00.000Z",
    source: "qq-digest" as const,
    candidates: [
      {
        candidateId: 7,
        candidateRevision: 2,
        requestKey: "qqdigest:candidate:7",
        title: "教程",
        candidateType: "resource" as const,
        filterReason: "对学习有帮助",
        groupId: 123,
        groupName: "学习群",
        messageIds: ["m1"],
        body,
        sourceUri: "qqdigest://group/123/message/m1",
        author: "QQ Digest 群 学习群",
        observedAt: "2026-11-15T08:00:00.000+08:00",
        context: { source_context: [] },
      },
    ],
  };
}

function store() {
  const directory = mkdtempSync(path.join(os.tmpdir(), "mycortex-qqdigest-"));
  return new KnowledgeStore(path.join(directory, "knowledge.sqlite"), { create: true });
}

describe("QQ Digest bundle import", () => {
  it("imports once and keeps retries idempotent", () => {
    const knowledge = store();
    expect(importQqDigestBundle(knowledge, bundle())).toMatchObject({
      candidates: 1,
      imported: 1,
      updated: 0,
      unchanged: 0,
    });
    expect(importQqDigestBundle(knowledge, bundle())).toMatchObject({
      imported: 0,
      updated: 0,
      unchanged: 1,
    });
    expect(knowledge.list(20, 0)).toHaveLength(1);
  });

  it("creates a new MyCortex revision when the same QQ candidate changes", () => {
    const knowledge = store();
    importQqDigestBundle(knowledge, bundle());
    const result = importQqDigestBundle(knowledge, bundle("# 教程\n\n修订后的正文"));
    expect(result).toMatchObject({ imported: 0, updated: 1, unchanged: 0 });
    const material = knowledge.findByRequestKey("qqdigest:candidate:7");
    expect(material).toMatchObject({ revision: 2, body: "# 教程\n\n修订后的正文" });
  });

  it("rejects duplicate candidate identities in one bundle", () => {
    const raw = bundle();
    raw.candidates.push({ ...raw.candidates[0] });
    expect(() => importQqDigestBundle(store(), raw)).toThrow(/duplicate/i);
  });
});
