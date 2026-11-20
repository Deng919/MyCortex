import type { Compilable } from "kysely";
import { sql } from "kysely";
import { getNodeSqliteKysely } from "../infra/kysely-sync.js";
import type { KnowledgeTables } from "./contract.js";
import { organizationSchema } from "./organization-contract.js";
import type { ProjectProfile } from "./project-contract.js";

type KnowledgeQuery = ReturnType<typeof getNodeSqliteKysely<KnowledgeTables>>;
type ReadRows = <T>(statement: Compilable<T>) => T[];

export type ProjectCard = ProjectProfile & {
  id: string;
  materialIds: string[];
  sources: Array<{ materialId: string; revision: number; observedAt: string | null }>;
};

function searchable(profile: ProjectProfile): string {
  return JSON.stringify(profile).toLocaleLowerCase();
}

function matches(profile: ProjectProfile, terms: string[]): boolean {
  if (!terms.length) {
    return true;
  }
  const haystack = searchable(profile);
  return terms.some((term) => haystack.includes(term.toLocaleLowerCase()));
}

export function readProjectIndex(
  query: KnowledgeQuery,
  readRows: ReadRows,
  terms: string[] = [],
  limit = 20,
  includeArchived = false,
): ProjectCard[] {
  if (!Array.isArray(terms) || terms.length > 6 || terms.some((term) => !labelTerm(term))) {
    throw new Error("Project search needs 0–6 literal terms of 1–100 characters each");
  }
  if (!Number.isInteger(limit) || limit < 1 || limit > 50) {
    throw new Error("Project limit must be 1–50");
  }
  const rows = readRows(
    query
      .selectFrom("materials as m")
      .innerJoin("revisions as r", (join) =>
        join.onRef("r.materialId", "=", "m.id").onRef("r.revision", "=", "m.currentRevision"),
      )
      .innerJoin("organizations as o", (join) =>
        join.onRef("o.materialId", "=", "m.id").onRef("o.sourceRevision", "=", "m.currentRevision"),
      )
      .select(["m.id", "r.revision", "r.observedAt", "o.organization"])
      .where("m.deletedAt", "is", null)
      .where("o.status", "=", "organized")
      .where("o.organization", "is not", null)
      .where(sql<boolean>`json_extract(o.organization, '$.projectProfile') is not null`)
      .orderBy("r.observedAt", "desc")
      .orderBy("m.id")
      .limit(1001),
  );
  const cards = new Map<string, ProjectCard>();
  for (const row of rows) {
    const organization = organizationSchema.parse(JSON.parse(row.organization!));
    const profile = organization.projectProfile;
    if (
      !profile ||
      (!includeArchived && profile.status === "archived") ||
      !matches(profile, terms)
    ) {
      continue;
    }
    const existing = cards.get(profile.entityId);
    if (existing) {
      if (!existing.materialIds.includes(row.id)) {
        existing.materialIds.push(row.id);
      }
      existing.sources.push({
        materialId: row.id,
        revision: row.revision,
        observedAt: row.observedAt,
      });
      continue;
    }
    cards.set(profile.entityId, {
      id: profile.entityId,
      ...profile,
      materialIds: [row.id],
      sources: [{ materialId: row.id, revision: row.revision, observedAt: row.observedAt }],
    });
  }
  return [...cards.values()]
    .toSorted(
      (a, b) =>
        statusRank(a.status) - statusRank(b.status) ||
        (Date.parse(b.verifiedAt ?? "") || 0) - (Date.parse(a.verifiedAt ?? "") || 0) ||
        a.name.localeCompare(b.name, "zh-CN"),
    )
    .slice(0, limit);
}

function labelTerm(value: unknown): value is string {
  return typeof value === "string" && Boolean(value.trim()) && value.length <= 100;
}

function statusRank(status: ProjectProfile["status"]): number {
  return status === "active" ? 0 : status === "paused" ? 1 : 2;
}
