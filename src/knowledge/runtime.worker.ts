import fs from "node:fs/promises";
import path from "node:path";
import {
  requestSqliteWorkerOperationAdmission,
  withSqliteWorkerOperationAdmissionAsync,
} from "../infra/sqlite-worker-operation-admission.js";
import { serveWorkerTasks } from "../infra/worker-task-server.js";
import { withKnowledgeStore } from "./access.js";
import type {
  KnowledgeCommand,
  KnowledgeOutputs,
  KnowledgeWorkerInput,
  KnowledgeWorkerReply,
} from "./runtime-contract.js";
import type { KnowledgeStore } from "./store.js";

function execute(
  store: KnowledgeStore,
  command: KnowledgeCommand,
): KnowledgeOutputs[keyof KnowledgeOutputs] {
  switch (command.operation) {
    case "submit":
      return store.submitKnowledge(command.input, command.organization);
    case "read":
      return store.readSlice(command.input.id, command.input);
    case "search":
      return store.searchMany(command.input.terms, command.input.limit);
    case "list":
      return store.list(command.input.limit, command.input.offset);
    case "history":
      return store.history(command.input.id);
    case "pending":
      return store.pendingOrganizations(command.input.limit);
    case "organization":
      return store.organization(command.input.id);
    case "organize":
      return store.commitOrganization(
        command.input.id,
        command.input.expectedRevision,
        command.input.result,
        command.input.manual,
        command.input.expectedOrganizationRevision,
      );
    case "correct":
      return store.correct(
        command.input.id,
        command.input.expectedRevision,
        command.input.correction,
      );
    case "delete": {
      store.remove(command.input.id, command.input.expectedRevision);
      return { deleted: true, id: command.input.id };
    }
  }
  const unsupported: never = command;
  throw new Error(`Unsupported knowledge operation: ${String(unsupported)}`);
}

serveWorkerTasks<KnowledgeWorkerReply, KnowledgeWorkerInput>((input, _channel, control) =>
  control.runNativeSection(async () => {
    try {
      return await withSqliteWorkerOperationAdmissionAsync({ port: input.admission }, async () => {
        control.throwIfCancelled();
        if (input.command.operation !== "submit") {
          try {
            await fs.stat(path.join(input.directory, "knowledge.sqlite"));
          } catch (error) {
            if (error instanceof Error && "code" in error && error.code === "ENOENT") {
              if (
                input.command.operation === "list" ||
                input.command.operation === "search" ||
                input.command.operation === "pending"
              ) {
                return { ok: true, value: [] };
              }
              throw new Error("Material not found; this knowledge store has no saved materials", {
                cause: error,
              });
            }
            throw error;
          }
        }
        const beforeCommit = () => {
          control.throwIfCancelled();
          requestSqliteWorkerOperationAdmission({ stage: "commit", facts: undefined });
        };
        const value = await withKnowledgeStore(
          input.directory,
          input.command.operation === "submit",
          (store) => {
            control.throwIfCancelled();
            requestSqliteWorkerOperationAdmission({ stage: "transaction", facts: undefined });
            return execute(store, input.command);
          },
          { beforeCommit },
        );
        return { ok: true, value };
      });
    } catch (error) {
      return {
        ok: false,
        message: error instanceof Error ? error.message : "Knowledge operation failed",
      };
    } finally {
      input.admission.close();
    }
  }),
);
