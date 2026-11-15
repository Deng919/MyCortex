import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import type { DatabaseSync } from "node:sqlite";
import type { Compilable } from "kysely";
import { sql } from "kysely";
import { executeSqliteQuerySync, getNodeSqliteKysely } from "../infra/kysely-sync.js";
import { openNodeSqliteDatabase } from "../infra/node-sqlite.js";
import { runSqliteImmediateTransactionSync } from "../infra/sqlite-transaction.js";
import {
  bundleSchema,
  correctionSchema,
  MAX_EXPORT_BYTES,
  submissionSchema,
  type Correction,
  type KnowledgeBundle,
  type KnowledgeTables,
  type Material,
  type MaterialRow,
  type RevisionRow,
  type Submission,
} from "./contract.js";

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
PRAGMA user_version = 1;`;

function positiveRevision(value: number): void {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error("Expected a positive revision");
  }
}

/** Offline one-shot owner only. Gateway callers must use a worker before integration. */
export class KnowledgeStore {
  private readonly db: DatabaseSync;
  private readonly query;

  constructor(filename: string, options: { create?: boolean } = {}) {
    const exists = fs.existsSync(filename);
    if (!exists && !options.create) {
      throw new Error("Knowledge store is missing; run init first");
    }
    if (!exists) {
      fs.closeSync(fs.openSync(filename, "wx", 0o600));
    }
    if (exists && !fs.lstatSync(filename).isFile()) {
      throw new Error("Store must be a regular file");
    }
    this.db = openNodeSqliteDatabase(filename);
    this.query = getNodeSqliteKysely<KnowledgeTables>(this.db);
    try {
      const app = this.db.prepare("PRAGMA application_id").get()?.application_id;
      const version = this.db.prepare("PRAGMA user_version").get()?.user_version;
      if (app === 0 && version === 0 && options.create) {
        const tables = this.db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all();
        if (tables.length) {
          throw new Error("Refusing unrelated database");
        }
        runSqliteImmediateTransactionSync(this.db, () => this.db.exec(SCHEMA));
      } else if (app !== APPLICATION_ID || version !== 1) {
        throw new Error("Unknown knowledge database format/version; preserve it for recovery");
      }
      this.db.exec(
        "PRAGMA foreign_keys = ON; PRAGMA secure_delete = ON; PRAGMA journal_mode = DELETE; PRAGMA synchronous = FULL;",
      );
      const check = this.db.prepare("PRAGMA quick_check").all();
      if (check.length !== 1 || check[0]?.quick_check !== "ok") {
        throw new Error("Knowledge database integrity check failed");
      }
    } catch (error) {
      this.db.close();
      throw error;
    }
  }

  private rows<T>(statement: Compilable<T>): T[] {
    return executeSqliteQuerySync(this.db, statement).rows;
  }

  private current(id: string): MaterialRow {
    const row = this.rows(this.query.selectFrom("materials").selectAll().where("id", "=", id))[0];
    if (!row) {
      throw new Error("Material not found");
    }
    if (row.deletedAt) {
      throw new Error("Material was deleted");
    }
    return row;
  }

  submit(raw: Submission): Material {
    const input = submissionSchema.parse(raw);
    const fingerprint = createHash("sha256").update(JSON.stringify(input)).digest("hex");
    return runSqliteImmediateTransactionSync(this.db, () => {
      const existing = this.rows(
        this.query.selectFrom("materials").selectAll().where("requestKey", "=", input.requestKey),
      )[0];
      if (existing) {
        if (existing.deletedAt) {
          throw new Error("Request refers to a deleted material");
        }
        if (existing.fingerprint !== fingerprint) {
          throw new Error("Request key already used with different content");
        }
        return this.read(existing.id);
      }
      const id = randomUUID();
      const { requestKey, ...content } = input;
      this.rows(
        this.query
          .insertInto("materials")
          .values({ id, requestKey, fingerprint, currentRevision: 1, deletedAt: null }),
      );
      this.rows(
        this.query.insertInto("revisions").values({
          ...content,
          materialId: id,
          revision: 1,
          recordedAt: new Date().toISOString(),
          note: "",
        }),
      );
      return this.read(id);
    });
  }

  read(id: string, revision?: number): Material {
    const current = this.current(id);
    const selected = revision ?? current.currentRevision;
    positiveRevision(selected);
    const row = this.rows(
      this.query
        .selectFrom("revisions")
        .selectAll()
        .where("materialId", "=", id)
        .where("revision", "=", selected),
    )[0];
    if (!row) {
      throw new Error("Revision not found");
    }
    const { materialId: _materialId, ...content } = row;
    return { id, requestKey: current.requestKey, ...content };
  }

  search(term: string, limit = 20) {
    if (typeof term !== "string" || !term.trim() || term.length > 300) {
      throw new Error("Search needs 1–300 characters");
    }
    if (!Number.isInteger(limit) || limit < 1 || limit > 50) {
      throw new Error("Search limit must be 1–50");
    }
    return this.rows(
      this.query
        .selectFrom("materials as m")
        .innerJoin("revisions as r", (join) =>
          join.onRef("r.materialId", "=", "m.id").onRef("r.revision", "=", "m.currentRevision"),
        )
        .select([
          "m.id",
          "r.revision",
          "r.title",
          "r.kind",
          "r.sourceUri",
          "r.author",
          "r.observedAt",
          "r.recordedAt",
          sql<string>`substr(r.body, max(1, instr(r.body, ${term}) - 80), 240)`.as("excerpt"),
        ])
        .where("m.deletedAt", "is", null)
        .where((eb) =>
          eb.or([
            eb(eb.fn<number>("instr", ["r.body", eb.val(term)]), ">", 0),
            eb(eb.fn<number>("instr", ["r.title", eb.val(term)]), ">", 0),
            eb(eb.fn<number>("instr", ["r.sourceUri", eb.val(term)]), ">", 0),
          ]),
        )
        .orderBy("r.recordedAt", "desc")
        .orderBy("m.id")
        .limit(limit),
    );
  }

  history(id: string) {
    this.current(id);
    return this.rows(
      this.query
        .selectFrom("revisions")
        .select(["revision", "recordedAt", "submittedBy", "note", "kind"])
        .where("materialId", "=", id)
        .orderBy("revision", "desc")
        .limit(50),
    );
  }

  correct(id: string, expectedRevision: number, raw: Correction): Material {
    positiveRevision(expectedRevision);
    const input = correctionSchema.parse(raw);
    return runSqliteImmediateTransactionSync(this.db, () => {
      const current = this.current(id);
      if (current.currentRevision !== expectedRevision) {
        throw new Error("Revision conflict; read current material before retrying");
      }
      const previous = this.read(id);
      if (previous.kind === "reference") {
        throw new Error("Reference content is not saved; submit text as a new material");
      }
      const { id: _id, requestKey: _requestKey, ...content } = previous;
      this.rows(
        this.query.insertInto("revisions").values({
          ...content,
          ...input,
          materialId: id,
          revision: expectedRevision + 1,
          recordedAt: new Date().toISOString(),
        }),
      );
      this.rows(
        this.query
          .updateTable("materials")
          .set({ currentRevision: expectedRevision + 1 })
          .where("id", "=", id),
      );
      return this.read(id);
    });
  }

  remove(id: string, expectedRevision: number): void {
    positiveRevision(expectedRevision);
    runSqliteImmediateTransactionSync(this.db, () => {
      const current = this.current(id);
      if (current.currentRevision !== expectedRevision) {
        throw new Error("Revision conflict; read current material before retrying");
      }
      this.rows(this.query.deleteFrom("revisions").where("materialId", "=", id));
      this.rows(
        this.query
          .updateTable("materials")
          .set({ deletedAt: new Date().toISOString() })
          .where("id", "=", id),
      );
    });
  }

  export(): KnowledgeBundle {
    return runSqliteImmediateTransactionSync(this.db, () => {
      // The byte-length aggregate bounds data before transferring bodies into JavaScript.
      const sizes = this.rows(
        this.query
          .selectFrom("revisions")
          .select(
            sql<number>`coalesce(sum(length(cast(body || title || sourceUri || author || submittedBy || note as blob))), 0)`.as(
              "bytes",
            ),
          ),
      );
      if (Number(sizes[0]?.bytes) > MAX_EXPORT_BYTES) {
        throw new Error("Export exceeds 32 MiB; use an offline database backup");
      }
      const materials = this.rows(
        this.query.selectFrom("materials").selectAll().orderBy("id").limit(10001),
      );
      const revisions = this.rows(
        this.query
          .selectFrom("revisions")
          .selectAll()
          .orderBy("materialId")
          .orderBy("revision")
          .limit(100001),
      );
      const bundle = bundleSchema.parse({
        format: "mycortex.materials",
        version: 1,
        exportedAt: new Date().toISOString(),
        materials,
        revisions,
      });
      if (Buffer.byteLength(JSON.stringify(bundle)) > MAX_EXPORT_BYTES) {
        throw new Error("Export exceeds 32 MiB; use an offline database backup");
      }
      return bundle;
    });
  }

  import(raw: unknown): void {
    const bundle = bundleSchema.parse(raw);
    if (Buffer.byteLength(JSON.stringify(bundle)) > MAX_EXPORT_BYTES) {
      throw new Error("Import exceeds 32 MiB");
    }
    // Validate the complete graph before opening a write transaction.
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
    runSqliteImmediateTransactionSync(this.db, () => {
      if (this.rows(this.query.selectFrom("materials").select("id").limit(1)).length) {
        throw new Error("Import requires an empty knowledge store");
      }
      for (const row of bundle.materials) {
        this.rows(this.query.insertInto("materials").values(row));
      }
      for (const row of bundle.revisions) {
        this.rows(this.query.insertInto("revisions").values(row));
      }
    });
  }

  close(): void {
    this.db.close();
  }
}
