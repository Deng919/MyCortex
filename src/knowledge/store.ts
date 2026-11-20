/* eslint-disable max-lines -- storage owns the complete transaction lifecycle and its derived projections. */
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
  type Submission,
} from "./contract.js";
import type { NetworkOptions } from "./network.js";
import {
  organizationResultSchema,
  organizationSchema,
  organizationMetadata,
  validateOrganization,
  type OrganizationResult,
  type OrganizationRow,
  type KnowledgeOrganization,
} from "./organization-contract.js";
import { readProjectIndex, type ProjectCard } from "./project-index.js";
import { prepareKnowledgeSubmission, sourceFingerprintFromNote } from "./refinement.js";
import { readKnowledgeNetwork } from "./store-network.js";
import {
  importKnowledgeBundle,
  listDeletions,
  type KnowledgeRecoveryContext,
} from "./store-recovery.js";
import { initializeKnowledgeStore } from "./store-schema.js";
function positiveRevision(value: number): void {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error("Expected a positive revision");
}
/** Synchronous storage owner; runtime callers execute it in the knowledge worker. */
export class KnowledgeStore {
  private readonly db: DatabaseSync;
  private readonly query;
  private readonly beforeCommit?: () => void;
  constructor(filename: string, options: { create?: boolean; beforeCommit?: () => void } = {}) {
    this.beforeCommit = options.beforeCommit;
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
      initializeKnowledgeStore(this.db, options.create ?? false, this.beforeCommit);
    } catch (error) {
      this.db.close();
      throw error;
    }
  }
  private rows<T>(statement: Compilable<T>): T[] {
    return executeSqliteQuerySync(this.db, statement).rows;
  }
  private transaction<T>(operation: () => T): T {
    return runSqliteImmediateTransactionSync(this.db, operation, {
      withCommit: (commit) => {
        this.beforeCommit?.();
        commit();
      },
    });
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
  private queueOrganization(materialId: string, sourceRevision: number): void {
    const previous = this.rows(
      this.query
        .selectFrom("organizations")
        .select("organization")
        .where("materialId", "=", materialId),
    )[0];
    const metadata = organizationMetadata(
      previous?.organization ? organizationSchema.parse(JSON.parse(previous.organization)) : null,
    );
    const values = {
      sourceRevision,
      revision: 1,
      status: "pending" as const,
      organization: Object.keys(metadata).length
        ? JSON.stringify({ ...metadata, topics: [], entries: [] })
        : null,
      processor: null,
      manual: 0,
      updatedAt: new Date().toISOString(),
    };
    this.rows(
      this.query
        .insertInto("organizations")
        .values({ materialId, ...values })
        .onConflict((conflict) => conflict.column("materialId").doUpdateSet(values)),
    );
  }
  private organizationView(row: OrganizationRow) {
    return {
      status: row.status,
      sourceRevision: row.sourceRevision,
      revision: row.revision,
      organization:
        row.organization === null ? null : organizationSchema.parse(JSON.parse(row.organization)),
      processor: row.processor,
      manual: row.manual === 1,
      updatedAt: row.updatedAt,
    };
  }
  organization(id: string) {
    const current = this.current(id);
    const row = this.rows(
      this.query.selectFrom("organizations").selectAll().where("materialId", "=", id),
    )[0];
    if (!row) {
      return {
        status: "skipped" as const,
        sourceRevision: current.currentRevision,
        revision: 1,
        organization: null,
        processor: null,
        manual: false,
        updatedAt: null,
      };
    }
    if (row.sourceRevision !== current.currentRevision) {
      throw new Error("Organization source revision mismatch");
    }
    return this.organizationView(row);
  }
  pendingOrganizations(limit = 3): Material[] {
    if (!Number.isInteger(limit) || limit < 1 || limit > 10) {
      throw new Error("Pending organization limit must be 1–10");
    }
    const pending = this.rows(
      this.query
        .selectFrom("organizations as o")
        .innerJoin("materials as m", "m.id", "o.materialId")
        .select("m.id")
        .where("m.deletedAt", "is", null)
        .where("o.status", "in", ["pending", "failed"])
        .whereRef("o.sourceRevision", "=", "m.currentRevision")
        .orderBy("o.updatedAt")
        .orderBy("m.id")
        .limit(limit),
    );
    return pending.map(({ id }) => this.read(id));
  }
  commitOrganization(
    id: string,
    expectedRevision: number,
    raw: OrganizationResult,
    manual = false,
    expectedOrganizationRevision?: number,
  ) {
    positiveRevision(expectedRevision);
    const result = organizationResultSchema.parse(raw);
    if (typeof manual !== "boolean") {
      throw new Error("Manual organization flag must be boolean");
    }
    return this.transaction(() => {
      const current = this.current(id);
      if (current.currentRevision !== expectedRevision) {
        throw new Error("Organization revision conflict");
      }
      const source = this.read(id);
      if (source.kind !== "text") {
        throw new Error("A reference has no saved source to organize");
      }
      const previous = this.organization(id);
      if (
        manual &&
        (!Number.isSafeInteger(expectedOrganizationRevision) ||
          expectedOrganizationRevision !== previous.revision)
      ) {
        throw new Error(
          "Organization revision conflict; read the current view before manual correction",
        );
      }
      if (
        !manual &&
        (previous.manual || (previous.status !== "pending" && previous.status !== "failed"))
      ) {
        throw new Error("Organization is already completed or manually corrected");
      }
      const metadata = organizationMetadata(previous.organization);
      const organization =
        result.organization === undefined && !Object.keys(metadata).length
          ? null
          : validateOrganization(
              { ...metadata, topics: [], entries: [], ...result.organization },
              source.body,
            );
      this.rows(
        this.query
          .updateTable("organizations")
          .set({
            status: result.status,
            revision: previous.revision + 1,
            sourceRevision: expectedRevision,
            organization: organization === null ? null : JSON.stringify(organization),
            processor: result.processor,
            manual: manual ? 1 : 0,
            updatedAt: new Date().toISOString(),
          })
          .where("materialId", "=", id),
      );
      return this.organization(id);
    });
  }
  /** Low-level registration for legacy store/recovery fixtures, never source ingestion. */
  submit(raw: Submission): Material {
    const input = submissionSchema.parse(raw);
    return this.saveSubmission(input);
  }
  /** Production source inputs pass here; unrefined source text is never persisted. */
  submitKnowledge(raw: Submission, refinement?: KnowledgeOrganization): Material | null {
    const prepared = prepareKnowledgeSubmission(raw, refinement);
    return prepared
      ? this.saveSubmission(prepared.input, prepared.sourceFingerprint, prepared.refinement)
      : null;
  }
  /** A source refresh cannot replace knowledge the user has corrected. */
  updateKnowledge(
    id: string,
    expectedRevision: number,
    raw: Submission,
    refinement: KnowledgeOrganization,
  ): Material | null {
    positiveRevision(expectedRevision);
    const prepared = prepareKnowledgeSubmission(raw, refinement);
    if (!prepared) {
      return null;
    }
    return this.transaction(() => {
      const current = this.read(id);
      if (
        current.revision !== expectedRevision ||
        current.requestKey !== prepared.input.requestKey
      ) {
        throw new Error("Knowledge source revision conflict");
      }
      if (!sourceFingerprintFromNote(current.note) || this.organization(id).manual) {
        throw new Error(
          "Source refresh requires refined knowledge without manual corrections; legacy raw imports must be removed first",
        );
      }
      if (sourceFingerprintFromNote(current.note) === prepared.sourceFingerprint) {
        return current;
      }
      const { requestKey: _requestKey, ...content } = prepared.input;
      this.rows(
        this.query.insertInto("revisions").values({
          ...content,
          materialId: id,
          revision: expectedRevision + 1,
          recordedAt: new Date().toISOString(),
          note: JSON.stringify({
            kind: "knowledge-refinement",
            sourceFingerprint: prepared.sourceFingerprint,
          }),
        }),
      );
      this.rows(
        this.query
          .updateTable("materials")
          .set({ currentRevision: expectedRevision + 1 })
          .where("id", "=", id),
      );
      this.saveRefinement(
        id,
        expectedRevision + 1,
        prepared.refinement!,
        prepared.input.submittedBy,
      );
      return this.read(id);
    });
  }
  private saveRefinement(
    materialId: string,
    sourceRevision: number,
    refinement: KnowledgeOrganization,
    submittedBy: string,
  ) {
    const values = {
      sourceRevision,
      revision: 1,
      status: "organized" as const,
      organization: JSON.stringify(refinement),
      processor: `refined:${submittedBy}`,
      manual: 0,
      updatedAt: new Date().toISOString(),
    };
    this.rows(
      this.query
        .insertInto("organizations")
        .values({ materialId, ...values })
        .onConflict((conflict) => conflict.column("materialId").doUpdateSet(values)),
    );
  }
  private saveSubmission(
    input: ReturnType<typeof submissionSchema.parse>,
    sourceFingerprint?: string,
    refinement?: KnowledgeOrganization,
  ): Material {
    const fingerprint = createHash("sha256").update(JSON.stringify(input)).digest("hex");
    return this.transaction(() => {
      const existing = this.rows(
        this.query.selectFrom("materials").selectAll().where("requestKey", "=", input.requestKey),
      )[0];
      if (existing) {
        if (existing.deletedAt) {
          throw new Error("Request refers to a deleted material");
        }
        const sameInput = sourceFingerprint
          ? sourceFingerprintFromNote(this.read(existing.id, 1).note) === sourceFingerprint
          : existing.fingerprint === fingerprint;
        if (!sameInput) {
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
          note: sourceFingerprint
            ? JSON.stringify({ kind: "knowledge-refinement", sourceFingerprint })
            : "",
        }),
      );
      if (input.kind === "text") {
        if (refinement) {
          this.saveRefinement(id, 1, refinement, input.submittedBy);
        } else {
          this.queueOrganization(id, 1);
        }
      }
      return this.read(id);
    });
  }
  findByRequestKey(requestKey: string): Material | null {
    const row = this.rows(
      this.query.selectFrom("materials").selectAll().where("requestKey", "=", requestKey),
    )[0];
    if (!row) {
      return null;
    }
    if (row.deletedAt) {
      throw new Error("Request refers to a deleted material");
    }
    return this.read(row.id);
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
  readSlice(id: string, options: { revision?: number; offset?: number; length?: number } = {}) {
    const offset = options.offset ?? 0;
    const length = options.length ?? 3000;
    if (
      !Number.isSafeInteger(offset) ||
      offset < 0 ||
      !Number.isInteger(length) ||
      length < 1 ||
      length > 8000
    ) {
      throw new Error("Read needs a nonnegative offset and length 1–8000");
    }
    const material = this.read(id, options.revision);
    const totalLength = material.body.length;
    const organization = this.organization(id);
    return {
      ...material,
      organization: organization.sourceRevision === material.revision ? organization : null,
      body: material.body.slice(offset, offset + length),
      offset,
      totalLength,
      truncated: offset > 0 || offset + length < totalLength,
    };
  }
  private summaries(includeHistorical = false) {
    if (typeof includeHistorical !== "boolean") {
      throw new Error("includeHistorical must be boolean");
    }
    return this.query
      .selectFrom("materials as m")
      .innerJoin("revisions as r", (join) =>
        join.onRef("r.materialId", "=", "m.id").onRef("r.revision", "=", "m.currentRevision"),
      )
      .leftJoin("organizations as o", (join) =>
        join.onRef("o.materialId", "=", "m.id").onRef("o.sourceRevision", "=", "m.currentRevision"),
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
      ])
      .where("m.deletedAt", "is", null)
      .$if(!includeHistorical, (query) =>
        query.where(
          sql<boolean>`coalesce(json_extract(o.organization, '$.relevance'), 'background') <> 'historical'`,
        ),
      );
  }
  list(limit = 10, offset = 0, includeHistorical = false) {
    if (
      !Number.isInteger(limit) ||
      limit < 1 ||
      limit > 20 ||
      !Number.isSafeInteger(offset) ||
      offset < 0
    ) {
      throw new Error("List needs limit 1–20 and a nonnegative offset");
    }
    return this.rows(
      this.summaries(includeHistorical)
        .select(sql<string>`substr(r.body, 1, 240)`.as("excerpt"))
        .orderBy("r.recordedAt", "desc")
        .orderBy("m.id")
        .limit(limit)
        .offset(offset),
    );
  }
  searchMany(terms: string[], limit = 5, includeHistorical = false) {
    if (
      !Array.isArray(terms) ||
      terms.length < 1 ||
      terms.length > 6 ||
      terms.some((term) => typeof term !== "string" || !term.trim() || term.length > 100)
    ) {
      throw new Error("Search needs 1–6 literal terms of 1–100 characters each");
    }
    if (!Number.isInteger(limit) || limit < 1 || limit > 10) {
      throw new Error("Search limit must be 1–10");
    }
    // SQLite's built-in lower folds ASCII. The deterministic function also handles Unicode text.
    this.db.function("mycortex_lower", { deterministic: true }, (value) =>
      typeof value === "string" ? value.toLowerCase() : "",
    );
    const folded = terms.map((term) => term.toLowerCase());
    return this.rows(
      this.summaries(includeHistorical)
        .select([
          "o.status as organizationStatus",
          "o.revision as organizationRevision",
          "o.organization as organizationJson",
          "o.processor as organizationProcessor",
          "o.manual as organizationManual",
          "o.updatedAt as organizationUpdatedAt",
        ])
        .select(sql<string>`substr(r.body, 1, 240)`.as("excerpt"))
        .where((eb) =>
          eb.or(
            folded.flatMap((term) =>
              (["r.body", "r.title", "r.sourceUri", "o.organization"] as const).map((column) =>
                eb(
                  eb.fn<number>("instr", [eb.fn<string>("mycortex_lower", [column]), eb.val(term)]),
                  ">",
                  0,
                ),
              ),
            ),
          ),
        )
        .orderBy("r.recordedAt", "desc")
        .orderBy("m.id")
        .limit(limit),
    ).map(
      ({
        organizationStatus,
        organizationRevision,
        organizationJson,
        organizationProcessor,
        organizationManual,
        organizationUpdatedAt,
        ...hit
      }) =>
        Object.assign(hit, {
          organization:
            organizationStatus === null
              ? null
              : this.organizationView({
                  materialId: hit.id,
                  sourceRevision: hit.revision,
                  revision: organizationRevision ?? 1,
                  status: organizationStatus,
                  organization: organizationJson,
                  processor: organizationProcessor,
                  manual: organizationManual ?? 0,
                  updatedAt: organizationUpdatedAt ?? hit.recordedAt,
                }),
        }),
    );
  }
  search(term: string, limit = 20, includeHistorical = false) {
    if (typeof term !== "string" || !term.trim() || term.length > 300) {
      throw new Error("Search needs 1–300 characters");
    }
    if (!Number.isInteger(limit) || limit < 1 || limit > 50) {
      throw new Error("Search limit must be 1–50");
    }
    return this.rows(
      this.summaries(includeHistorical)
        .select(sql<string>`substr(r.body, max(1, instr(r.body, ${term}) - 80), 240)`.as("excerpt"))
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
  network(options: NetworkOptions = {}) {
    return readKnowledgeNetwork(this.query, (statement) => this.rows(statement), options);
  }
  projects(terms: string[] = [], limit = 20, includeArchived = false): ProjectCard[] {
    return readProjectIndex(
      this.query,
      (statement) => this.rows(statement),
      terms,
      limit,
      includeArchived,
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
    return this.transaction(() => {
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
      this.queueOrganization(id, expectedRevision + 1);
      return this.read(id);
    });
  }
  remove(id: string, expectedRevision: number): void {
    positiveRevision(expectedRevision);
    this.transaction(() => {
      const current = this.current(id);
      if (current.currentRevision !== expectedRevision) {
        throw new Error("Revision conflict; read current material before retrying");
      }
      this.rows(this.query.deleteFrom("organizations").where("materialId", "=", id));
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
      const organizationBytes = this.rows(
        this.query
          .selectFrom("organizations")
          .select(
            sql<number>`coalesce(sum(length(cast(coalesce(organization, '') || coalesce(processor, '') as blob))), 0)`.as(
              "bytes",
            ),
          ),
      );
      if (Number(sizes[0]?.bytes) + Number(organizationBytes[0]?.bytes) > MAX_EXPORT_BYTES) {
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
        version: 2,
        exportedAt: new Date().toISOString(),
        materials,
        revisions,
        organizations: this.rows(
          this.query.selectFrom("organizations").selectAll().orderBy("materialId").limit(10001),
        ),
      });
      if (Buffer.byteLength(JSON.stringify(bundle)) > MAX_EXPORT_BYTES) {
        throw new Error("Export exceeds 32 MiB; use an offline database backup");
      }
      return bundle;
    });
  }
  deletions(): MaterialRow[] {
    return listDeletions(this.recoveryContext());
  }
  import(raw: unknown): void {
    importKnowledgeBundle(this.recoveryContext(), raw);
  }
  private recoveryContext(): KnowledgeRecoveryContext {
    return {
      db: this.db,
      query: this.query,
      rows: <T>(statement: Compilable<T>) => this.rows(statement),
      transaction: <T>(operation: () => T) => this.transaction(operation),
    };
  }
  close(): void {
    this.db.close();
  }
}
