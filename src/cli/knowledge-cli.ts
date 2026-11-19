import fs from "node:fs/promises";
import path from "node:path";
import type { Command } from "commander";
import { withKnowledgeStore } from "../knowledge/access.js";
import { MAX_BODY_BYTES, MAX_EXPORT_BYTES } from "../knowledge/contract.js";
import { importQqDigestBundle } from "../knowledge/qqdigest-import.js";
import { mergeDeletionLedger } from "../knowledge/recovery.js";
import type { KnowledgeStore } from "../knowledge/store.js";

async function readUtf8(filename: string, maximum: number): Promise<string> {
  const file = await fs.open(filename, "r");
  try {
    if (!(await file.stat()).isFile()) {
      throw new Error("Input must be a regular UTF-8 file");
    }
    const buffer = Buffer.alloc(maximum + 1);
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await file.read(buffer, length, buffer.length - length, null);
      if (!bytesRead) {
        break;
      }
      length += bytesRead;
    }
    if (length > maximum) {
      throw new Error(`Input exceeds ${maximum} bytes`);
    }
    return new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, length));
  } finally {
    await file.close();
  }
}

function revision(value: string): number {
  if (!/^[1-9]\d*$/.test(value) || !Number.isSafeInteger(Number(value))) {
    throw new Error("Revision must be a positive integer");
  }
  return Number(value);
}

export function registerKnowledgeCli(program: Command): void {
  const knowledge = program
    .command("knowledge")
    .description("Manage the local MyCortex material store (synthetic preview)")
    .requiredOption(
      "--store <directory>",
      "Explicit knowledge directory; independent of agent state",
    );

  async function use(create: boolean, operation: (store: KnowledgeStore) => unknown) {
    const options = knowledge.opts<{ store: string }>();
    const result = await withKnowledgeStore(path.resolve(options.store), create, operation);
    console.log(JSON.stringify(result, null, 2));
  }

  knowledge
    .command("init")
    .description("Initialize an isolated knowledge directory")
    .action(async () => use(true, () => ({ initialized: true, schemaVersion: 2 })));

  const metadata = (command: Command) =>
    command
      .requiredOption("--title <title>", "Material title")
      .requiredOption(
        "--source <uri>",
        "Original source URI or descriptive source identifier; never fetched",
      )
      .requiredOption("--author <identity>", "Original author, or unknown when unavailable")
      .requiredOption("--request <key>", "Stable submission identifier for safe retries")
      .option("--observed-at <ISO-date>", "Source time when known")
      .option(
        "--submitted-by <identity>",
        "Transfer identity (provenance, not authentication)",
        "local-operator",
      );

  metadata(
    knowledge
      .command("add")
      .description("Save refined knowledge backed by a transient UTF-8 source")
      .requiredOption(
        "--refinement <path>",
        "Agent-produced topics/entries JSON with verbatim source evidence",
      )
      .requiredOption("--file <path>", "Explicit UTF-8 input file, at most 256 KiB"),
  ).action(
    async (options: {
      file: string;
      refinement: string;
      title: string;
      source: string;
      author: string;
      request: string;
      observedAt?: string;
      submittedBy: string;
    }) => {
      const body = await readUtf8(options.file, MAX_BODY_BYTES);
      const { organizationSchema } = await import("../knowledge/organization-contract.js");
      const organization = organizationSchema.parse(
        JSON.parse(await readUtf8(options.refinement, MAX_BODY_BYTES)),
      );
      return use(false, (store) =>
        store.submitKnowledge(
          {
            requestKey: options.request,
            title: options.title,
            body,
            sourceUri: options.source,
            author: options.author,
            submittedBy: options.submittedBy,
            observedAt: options.observedAt ?? null,
            kind: "text",
          },
          organization,
        ),
      );
    },
  );

  knowledge
    .command("import-qqdigest")
    .description("Import confirmed QQ Digest candidates with stable, idempotent request keys")
    .requiredOption("--file <path>", "QQ Digest MyCortex bundle, at most 32 MiB")
    .action(async (options: { file: string }) => {
      const raw = JSON.parse(await readUtf8(options.file, MAX_EXPORT_BYTES));
      return use(false, (store) => importQqDigestBundle(store, raw));
    });

  metadata(
    knowledge.command("reference").description("Save a source link only, without fetching content"),
  ).action(
    async (options: {
      title: string;
      source: string;
      author: string;
      request: string;
      observedAt?: string;
      submittedBy: string;
    }) =>
      use(false, (store) =>
        store.submitKnowledge({
          requestKey: options.request,
          title: options.title,
          body: "",
          sourceUri: options.source,
          author: options.author,
          submittedBy: options.submittedBy,
          observedAt: options.observedAt ?? null,
          kind: "reference",
        }),
      ),
  );

  knowledge
    .command("serve")
    .description("Expose the knowledge tools to one authorized local MCP stdio connection")
    .requiredOption("--connection <id>", "Host-assigned connection identity")
    .option("--capabilities <list>", "Comma-separated read,submit,manage,organize grants", "read")
    .option("--file-root <directories...>", "Approved absolute directories for current file reads")
    .action(async (options: { connection: string; capabilities: string; fileRoot?: string[] }) => {
      const { serveKnowledgeMcp } = await import("../mcp/knowledge-serve.js");
      await serveKnowledgeMcp({
        directory: path.resolve(knowledge.opts<{ store: string }>().store),
        connectionId: options.connection,
        capabilities: options.capabilities,
        fileRoots: options.fileRoot,
      });
    });
  knowledge
    .command("list")
    .description("List current materials, newest first")
    .option("--limit <number>", "Result limit, 1–20", "10")
    .option("--offset <number>", "Pagination offset", "0")
    .option("--include-historical", "Include historical knowledge explicitly")
    .action(async (options: { limit: string; offset: string; includeHistorical?: boolean }) =>
      use(false, (store) => ({
        results: store.list(
          Number(options.limit),
          Number(options.offset),
          options.includeHistorical,
        ),
      })),
    );
  knowledge
    .command("search <text>")
    .description("Search current original materials literally")
    .option("--limit <number>", "Result limit, 1–50", "20")
    .option("--include-historical", "Include historical knowledge explicitly")
    .action(async (text: string, options: { limit: string; includeHistorical?: boolean }) =>
      use(false, (store) => ({
        kind: "original-material-results",
        results: store.search(text, Number(options.limit), options.includeHistorical),
      })),
    );
  knowledge
    .command("network")
    .description("Read source-backed entities, relationships and conversation context as JSON")
    .option("--entity <id>", "Focus on one entity ID")
    .option("--include-historical", "Include historical knowledge explicitly")
    .option("--limit <number>", "Result limit, 1–50", "20")
    .option("--offset <number>", "Pagination offset", "0")
    .action(
      async (options: {
        entity?: string;
        includeHistorical?: boolean;
        limit: string;
        offset: string;
      }) =>
        use(false, (store) =>
          store.network({
            entityId: options.entity,
            includeHistorical: options.includeHistorical,
            limit: Number(options.limit),
            offset: Number(options.offset),
          }),
        ),
    );
  knowledge
    .command("read <id>")
    .description("Read current material or an explicitly requested historical revision")
    .option("--revision <number>", "Historical revision")
    .action(async (id: string, options: { revision?: string }) =>
      use(false, (store) =>
        store.read(id, options.revision ? revision(options.revision) : undefined),
      ),
    );
  knowledge
    .command("history <id>")
    .description("List the latest 50 revisions and their provenance")
    .action(async (id: string) => use(false, (store) => ({ revisions: store.history(id) })));
  knowledge
    .command("correct <id>")
    .description("Record an explicit correction as a new current revision")
    .requiredOption("--revision <number>", "Expected current revision")
    .requiredOption("--file <path>", "Replacement UTF-8 text")
    .requiredOption("--note <reason>", "Correction reason")
    .option("--submitted-by <identity>", "Correction provenance", "local-operator")
    .action(
      async (
        id: string,
        options: { revision: string; file: string; note: string; submittedBy: string },
      ) => {
        const body = await readUtf8(options.file, MAX_BODY_BYTES);
        return use(false, (store) =>
          store.correct(id, revision(options.revision), {
            body,
            note: options.note,
            submittedBy: options.submittedBy,
          }),
        );
      },
    );
  knowledge
    .command("delete <id>")
    .description("Erase all revisions; keep a minimal retry tombstone")
    .requiredOption("--revision <number>", "Expected current revision")
    .action(async (id: string, options: { revision: string }) =>
      use(false, (store) => {
        store.remove(id, revision(options.revision));
        return { id, deleted: true, scope: "this-store", externalBackups: "user-managed" };
      }),
    );
  knowledge
    .command("export")
    .description("Export a portable plaintext backup, including history and deletion markers")
    .requiredOption("--out <path>", "New output file; existing files are never overwritten")
    .action(async (options: { out: string }) =>
      use(false, async (store) => {
        const output = path.resolve(options.out);
        const data = JSON.stringify(store.export(), null, 2);
        if (Buffer.byteLength(data) > MAX_EXPORT_BYTES) {
          throw new Error("Formatted export exceeds 32 MiB");
        }
        const file = await fs.open(output, "wx", 0o600);
        try {
          await file.writeFile(data, "utf8");
          await file.sync();
        } finally {
          await file.close();
        }
        return { exported: true, path: output };
      }),
    );
  knowledge
    .command("export-deletions")
    .description("Export the latest deletion ledger without original text")
    .requiredOption("--out <path>", "New ledger file; existing files are never overwritten")
    .action(async (options: { out: string }) =>
      use(false, async (store) => {
        const output = path.resolve(options.out);
        const data = JSON.stringify(
          {
            format: "mycortex.deletions",
            version: 1,
            exportedAt: new Date().toISOString(),
            materials: store.deletions(),
          },
          null,
          2,
        );
        const file = await fs.open(output, "wx", 0o600);
        try {
          await file.writeFile(data, "utf8");
          await file.sync();
        } finally {
          await file.close();
        }
        return { exported: true, path: output };
      }),
    );
  knowledge
    .command("import")
    .description("Restore a portable backup into an empty initialized store")
    .requiredOption("--file <path>", "Portable MyCortex export, at most 32 MiB")
    .option("--deletions-from <path>", "Latest deletion ledger from the authoritative store")
    .option(
      "--historical",
      "Explicitly restore the historical state without a current deletion ledger",
    )
    .action(async (options: { file: string; deletionsFrom?: string; historical?: boolean }) => {
      if (!options.deletionsFrom && !options.historical) {
        throw new Error(
          "Restore needs --deletions-from <latest-ledger>; use --historical only to deliberately restore that historical state",
        );
      }
      if (options.deletionsFrom && options.historical) {
        throw new Error(
          "Choose either the current deletion ledger or an explicit historical restore",
        );
      }
      let bundle: unknown = JSON.parse(await readUtf8(options.file, MAX_EXPORT_BYTES));
      if (options.deletionsFrom) {
        bundle = mergeDeletionLedger(
          bundle,
          JSON.parse(await readUtf8(options.deletionsFrom, MAX_EXPORT_BYTES)),
        );
      }
      return use(false, (store) => {
        store.import(bundle);
        return { imported: true };
      });
    });
}
