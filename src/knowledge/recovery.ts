import { z } from "zod";
import { bundleSchema, materialRowSchema, type KnowledgeBundle } from "./contract.js";

export const deletionLedgerSchema = z.strictObject({
  format: z.literal("mycortex.deletions"),
  version: z.literal(1),
  exportedAt: z.iso.datetime({ offset: true }),
  materials: z
    .array(
      materialRowSchema.refine(
        (row) => row.deletedAt !== null,
        "A deletion ledger may only contain tombstones",
      ),
    )
    .max(10000),
});

/** Merge before opening the target store: historical payloads never reach its database. */
export function mergeDeletionLedger(backup: unknown, ledger: unknown): KnowledgeBundle {
  const bundle = bundleSchema.parse(backup);
  const deleted = deletionLedgerSchema.parse(ledger);
  if (
    new Set(bundle.materials.map((row) => row.requestKey)).size !== bundle.materials.length ||
    new Set(bundle.materials.map((row) => row.id)).size !== bundle.materials.length ||
    new Set(deleted.materials.map((row) => row.requestKey)).size !== deleted.materials.length ||
    new Set(deleted.materials.map((row) => row.id)).size !== deleted.materials.length
  ) {
    throw new Error("Duplicate material identity in backup or deletion ledger");
  }
  const materials = new Map(bundle.materials.map((row) => [row.requestKey, row]));
  const ids = new Map(bundle.materials.map((row) => [row.id, row.requestKey]));
  for (const tombstone of deleted.materials) {
    const existing = materials.get(tombstone.requestKey);
    if (
      (existing &&
        (existing.id !== tombstone.id || existing.fingerprint !== tombstone.fingerprint)) ||
      (ids.has(tombstone.id) && ids.get(tombstone.id) !== tombstone.requestKey)
    ) {
      throw new Error(
        "Deletion ledger conflicts with backup identity; preserve both files for recovery",
      );
    }
    materials.set(tombstone.requestKey, tombstone);
  }
  const tombstones = new Set(
    [...materials.values()].filter((row) => row.deletedAt).map((row) => row.id),
  );
  return bundleSchema.parse({
    ...bundle,
    materials: [...materials.values()],
    revisions: bundle.revisions.filter((row) => !tombstones.has(row.materialId)),
    organizations: bundle.organizations.filter((row) => !tombstones.has(row.materialId)),
  });
}
