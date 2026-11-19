import type { Compilable } from "kysely";
import { sql } from "kysely";
import { getNodeSqliteKysely } from "../infra/kysely-sync.js";
import type { KnowledgeTables } from "./contract.js";
import { buildKnowledgeNetwork, type NetworkOptions } from "./network.js";
import { organizationSchema } from "./organization-contract.js";

type KnowledgeQuery = ReturnType<typeof getNodeSqliteKysely<KnowledgeTables>>;
type ReadRows = <T>(statement: Compilable<T>) => T[];

export function readKnowledgeNetwork(
  query: KnowledgeQuery,
  readRows: ReadRows,
  options: NetworkOptions = {},
) {
  const rows = readRows(
    query
      .selectFrom("materials as m")
      .innerJoin("revisions as r", (join) =>
        join.onRef("r.materialId", "=", "m.id").onRef("r.revision", "=", "m.currentRevision"),
      )
      .leftJoin("organizations as o", (join) =>
        join.onRef("o.materialId", "=", "m.id").onRef("o.sourceRevision", "=", "m.currentRevision"),
      )
      .select(["m.id", "r.revision", "r.observedAt", "o.organization"])
      .where("m.deletedAt", "is", null)
      .$if(!options.includeHistorical, (builder) =>
        builder.where(
          sql<boolean>`coalesce(json_extract(o.organization, '$.relevance'), 'background') <> 'historical'`,
        ),
      )
      .where("o.organization", "is not", null)
      .$if(Boolean(options.entityId), (builder) =>
        builder.where(sql<boolean>`instr(o.organization, ${JSON.stringify(options.entityId)}) > 0`),
      )
      .orderBy("r.observedAt", "desc")
      .orderBy("m.id")
      .limit(1001),
  );
  const result = buildKnowledgeNetwork(
    rows.slice(0, 1000).map((row) => ({
      materialId: row.id,
      revision: row.revision,
      observedAt: row.observedAt,
      organization: organizationSchema.parse(JSON.parse(row.organization!)),
    })),
    options,
  );
  return { ...result, truncated: result.truncated || rows.length > 1000 };
}
