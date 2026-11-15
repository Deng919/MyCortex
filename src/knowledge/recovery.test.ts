import { expect, it } from "vitest";
import { mergeDeletionLedger } from "./recovery.js";

it("applies later deletion markers before restoring an old backup, including its historical bodies", () => {
  const material = {
    id: "84b0aa1f-1564-47aa-aa0f-758957995573",
    requestKey: "synthetic-old",
    fingerprint: "a".repeat(64),
    currentRevision: 1,
    deletedAt: null,
  };
  const backup = {
    format: "mycortex.materials",
    version: 1,
    exportedAt: "2026-11-14T00:00:00.000Z",
    materials: [material],
    revisions: [
      {
        materialId: material.id,
        revision: 1,
        title: "旧资料",
        body: "以后应该被删除的合成正文",
        sourceUri: "synthetic:deleted",
        author: "synthetic",
        submittedBy: "owner",
        observedAt: null,
        recordedAt: "2026-11-14T00:00:00.000Z",
        kind: "text",
        note: "",
      },
    ],
  };
  const ledger = {
    format: "mycortex.deletions",
    version: 1,
    exportedAt: "2026-11-15T00:00:00.000Z",
    materials: [{ ...material, deletedAt: "2026-11-15T00:00:00.000Z", currentRevision: 2 }],
  };
  const restored = mergeDeletionLedger(backup, ledger);
  expect(restored.materials).toMatchObject([
    { id: material.id, deletedAt: "2026-11-15T00:00:00.000Z" },
  ]);
  expect(restored.revisions).toEqual([]);
  expect(JSON.stringify(restored)).not.toContain("合成正文");
  expect(backup.revisions).toHaveLength(1);
  expect(() =>
    mergeDeletionLedger(backup, {
      ...ledger,
      materials: [{ ...ledger.materials[0], deletedAt: null }],
    }),
  ).toThrow();
  expect(() => mergeDeletionLedger({ ...backup, materials: [material, material] }, ledger)).toThrow(
    /duplicate/i,
  );
});
