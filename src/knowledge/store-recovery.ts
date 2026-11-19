import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { Compilable, Kysely } from "kysely";
import {
  bundleSchema,
  MAX_EXPORT_BYTES,
  submissionSchema,
  type KnowledgeTables,
  type MaterialRow,
  type RevisionRow,
} from "./contract.js";
import {
  organizationResultSchema,
  organizationSchema,
  validateOrganization,
} from "./organization-contract.js";
import { queueImportedOrganizations } from "./store-schema.js";

export type KnowledgeRecoveryContext = {
  db: DatabaseSync;
  query: Kysely<KnowledgeTables>;
  rows<T>(statement: Compilable<T>): T[];
  transaction<T>(operation: () => T): T;
};

export function listDeletions(context: KnowledgeRecoveryContext): MaterialRow[] {
  const rows = context.rows(
    context.query
      .selectFrom("materials")
      .selectAll()
      .where("deletedAt", "is not", null)
      .orderBy("id")
      .limit(10001),
  );
  if (rows.length > 10000) {
    throw new Error("Deletion ledger exceeds 10000 materials; use an offline database backup");
  }
  return rows;
}

export function importKnowledgeBundle(context: KnowledgeRecoveryContext, raw: unknown): void {
  const bundle = bundleSchema.parse(raw);
  if (Buffer.byteLength(JSON.stringify(bundle)) > MAX_EXPORT_BYTES) {
    throw new Error("Import exceeds 32 MiB");
  }
  const materials = new Map(bundle.materials.map((row) => [row.id, row]));
  if (
    materials.size !== bundle.materials.length ||
    new Set(bundle.materials.map((row) => row.requestKey)).size !== materials.size
  ) {
    throw new Error("Duplicate imported material");
  }
  const revisions = new Map<string, RevisionRow[]>();
  for (const row of bundle.revisions) {
    const parent = materials.get(row.materialId);
    if (!parent || parent.deletedAt) {
      throw new Error("Invalid imported revision parent");
    }
    submissionSchema.parse({
      requestKey: parent.requestKey,
      title: row.title,
      body: row.body,
      sourceUri: row.sourceUri,
      author: row.author,
      submittedBy: row.submittedBy,
      observedAt: row.observedAt,
      kind: row.kind,
    });
    const group = revisions.get(row.materialId) ?? [];
    group.push(row);
    revisions.set(row.materialId, group);
  }
  for (const parent of bundle.materials) {
    const group = (revisions.get(parent.id) ?? []).toSorted((a, b) => a.revision - b.revision);
    if (parent.deletedAt) {
      continue;
    }
    if (
      group.length !== parent.currentRevision ||
      group.some((row, index) => row.revision !== index + 1)
    ) {
      throw new Error("Incomplete imported revisions");
    }
    const original = group[0];
    if (!original) {
      throw new Error("Missing imported original");
    }
    const normalized = submissionSchema.parse({
      requestKey: parent.requestKey,
      title: original.title,
      body: original.body,
      sourceUri: original.sourceUri,
      author: original.author,
      submittedBy: original.submittedBy,
      observedAt: original.observedAt,
      kind: original.kind,
    });
    if (
      createHash("sha256").update(JSON.stringify(normalized)).digest("hex") !== parent.fingerprint
    ) {
      throw new Error("Imported original does not match its submission fingerprint");
    }
  }
  const organizationIds = new Set<string>();
  for (const row of bundle.organizations) {
    const parent = materials.get(row.materialId);
    const source = revisions
      .get(row.materialId)
      ?.find((revision) => revision.revision === row.sourceRevision);
    if (
      !parent ||
      parent.deletedAt ||
      parent.currentRevision !== row.sourceRevision ||
      source?.kind !== "text" ||
      organizationIds.has(row.materialId)
    ) {
      throw new Error("Invalid imported organization parent or revision");
    }
    organizationIds.add(row.materialId);
    if (row.status === "pending") {
      const metadata =
        row.organization === null ? null : organizationSchema.parse(JSON.parse(row.organization));
      if (metadata?.entries.length || row.processor !== null || row.manual !== 0) {
        throw new Error("Invalid imported pending organization");
      }
    } else {
      const organization: unknown =
        row.organization === null ? undefined : JSON.parse(row.organization);
      const result = organizationResultSchema.parse({
        status: row.status,
        organization,
        processor: row.processor,
      });
      if (result.organization !== undefined) {
        validateOrganization(result.organization, source.body);
      }
    }
  }
  context.transaction(() => {
    if (context.rows(context.query.selectFrom("materials").select("id").limit(1)).length) {
      throw new Error("Import requires an empty knowledge store");
    }
    for (const row of bundle.materials) {
      context.rows(context.query.insertInto("materials").values(row));
    }
    for (const row of bundle.revisions) {
      context.rows(context.query.insertInto("revisions").values(row));
    }
    for (const row of bundle.organizations) {
      context.rows(context.query.insertInto("organizations").values(row));
    }
    queueImportedOrganizations(context.db);
  });
}
