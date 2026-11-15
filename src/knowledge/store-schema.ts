import type { DatabaseSync } from "node:sqlite";
import { sql } from "kysely";
import { executeSqliteQuerySync, getNodeSqliteKysely } from "../infra/kysely-sync.js";
import { runSqliteImmediateTransactionSync } from "../infra/sqlite-transaction.js";
import type { KnowledgeTables } from "./contract.js";
import type { OrganizationStatus } from "./organization-contract.js";

const APPLICATION_ID = 0x4d435458;
const SCHEMA = `
CREATE TABLE materials (
  id TEXT PRIMARY KEY NOT NULL, requestKey TEXT UNIQUE NOT NULL, fingerprint TEXT NOT NULL,
  currentRevision INTEGER NOT NULL CHECK(currentRevision > 0), deletedAt TEXT
) STRICT;
CREATE TABLE revisions (
  materialId TEXT NOT NULL REFERENCES materials(id) ON DELETE CASCADE,
  revision INTEGER NOT NULL CHECK(revision > 0), title TEXT NOT NULL, body TEXT NOT NULL,
  sourceUri TEXT NOT NULL, author TEXT NOT NULL, submittedBy TEXT NOT NULL,
  observedAt TEXT, recordedAt TEXT NOT NULL, kind TEXT NOT NULL CHECK(kind IN ('text','reference')),
  note TEXT NOT NULL, PRIMARY KEY(materialId, revision)
) STRICT;
PRAGMA application_id = ${APPLICATION_ID};
`;
const ORGANIZATIONS_SCHEMA = `CREATE TABLE organizations (
  materialId TEXT PRIMARY KEY NOT NULL REFERENCES materials(id) ON DELETE CASCADE,
  sourceRevision INTEGER NOT NULL CHECK(sourceRevision > 0),
  revision INTEGER NOT NULL CHECK(revision > 0),
  status TEXT NOT NULL CHECK(status IN ('pending','organized','empty','failed','skipped')),
  organization TEXT, processor TEXT, manual INTEGER NOT NULL CHECK(manual IN (0,1)),
  updatedAt TEXT NOT NULL
) STRICT;
PRAGMA user_version = 2;`;

/** Schema changes share the storage owner's commit admission and rollback boundary. */
export function initializeKnowledgeStore(
  db: DatabaseSync,
  create: boolean,
  beforeCommit?: () => void,
): void {
  const transaction = (operation: () => void) =>
    runSqliteImmediateTransactionSync(db, operation, {
      withCommit: (commit) => {
        beforeCommit?.();
        commit();
      },
    });
  const app = db.prepare("PRAGMA application_id").get()?.application_id;
  const version = db.prepare("PRAGMA user_version").get()?.user_version;
  if (app === 0 && version === 0 && create) {
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all();
    if (tables.length) {
      throw new Error("Refusing unrelated database");
    }
    transaction(() => db.exec(SCHEMA + ORGANIZATIONS_SCHEMA));
  } else if (app === APPLICATION_ID && version === 1) {
    transaction(() => {
      db.exec(ORGANIZATIONS_SCHEMA);
      queueImportedOrganizations(db);
    });
  } else if (app !== APPLICATION_ID || version !== 2) {
    throw new Error("Unknown knowledge database format/version; preserve it for recovery");
  }
  db.exec(
    "PRAGMA foreign_keys = ON; PRAGMA secure_delete = ON; PRAGMA journal_mode = DELETE; PRAGMA synchronous = FULL;",
  );
  const check = db.prepare("PRAGMA quick_check").all();
  if (check.length !== 1 || check[0]?.quick_check !== "ok") {
    throw new Error("Knowledge database integrity check failed");
  }
}

export function queueImportedOrganizations(db: DatabaseSync): void {
  const query = getNodeSqliteKysely<KnowledgeTables>(db);
  executeSqliteQuerySync(
    db,
    query
      .insertInto("organizations")
      .columns([
        "materialId",
        "sourceRevision",
        "revision",
        "status",
        "organization",
        "processor",
        "manual",
        "updatedAt",
      ])
      .expression(
        query
          .selectFrom("materials as m")
          .innerJoin("revisions as r", (join) =>
            join.onRef("r.materialId", "=", "m.id").onRef("r.revision", "=", "m.currentRevision"),
          )
          .leftJoin("organizations as o", "o.materialId", "m.id")
          .select([
            "m.id as materialId",
            "m.currentRevision as sourceRevision",
            sql<number>`${1}`.as("revision"),
            sql<OrganizationStatus>`${"pending"}`.as("status"),
            sql<string | null>`${null}`.as("organization"),
            sql<string | null>`${null}`.as("processor"),
            sql<number>`${0}`.as("manual"),
            sql<string>`${new Date().toISOString()}`.as("updatedAt"),
          ])
          .where("m.deletedAt", "is", null)
          .where("r.kind", "=", "text")
          .where("o.materialId", "is", null),
      ),
  );
}
