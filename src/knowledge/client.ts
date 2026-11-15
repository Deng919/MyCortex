import path from "node:path";
import { resolveRuntimeProcessEntrypointUrl } from "../infra/runtime-process-url.js";
import { captureRuntimeWorkerSource } from "../infra/runtime-worker-generation.js";
import { createSqliteWorkerOperationAdmission } from "../infra/sqlite-worker-operation-admission.js";
import { WorkerTaskPool } from "../infra/worker-task-pool.js";
import type {
  KnowledgeCommand,
  KnowledgeResult,
  KnowledgeWorkerInput,
  KnowledgeWorkerReply,
} from "./runtime-contract.js";

/** A cancelled transport can lose the reply after COMMIT; callers must reconcile instead of blindly retrying. */
export class KnowledgeWriteOutcomeUnknownError extends Error {
  override name = "KnowledgeWriteOutcomeUnknownError";
}

export function createKnowledgeClient(directory: string) {
  const canonicalInput = path.resolve(directory);
  let pool: WorkerTaskPool<KnowledgeWorkerInput, KnowledgeWorkerReply> | undefined;
  let closed = false;
  return {
    async execute<C extends KnowledgeCommand>(
      command: C,
      options: {
        assertCurrent: () => void;
        signal?: AbortSignal;
      },
    ): Promise<KnowledgeResult<C>> {
      if (closed) {
        throw new Error("Knowledge client is closed");
      }
      options.signal?.throwIfAborted();
      options.assertCurrent();
      const captured = structuredClone(command);
      const mutation = ["submit", "correct", "delete", "organize"].includes(captured.operation);
      let commitGranted = false;
      const admission = createSqliteWorkerOperationAdmission((request, grant) => {
        options.signal?.throwIfAborted();
        options.assertCurrent();
        if (!grant()) {
          throw new Error("Knowledge operation authority expired");
        }
        if (request.stage === "commit" && mutation) {
          commitGranted = true;
        }
      });
      try {
        pool ??= new WorkerTaskPool({
          workerUrl: captureRuntimeWorkerSource(
            resolveRuntimeProcessEntrypointUrl("knowledgeStore"),
          ).moduleUrl,
          maxWorkers: 1,
          maxPendingTasks: 32,
          idleTimeoutMs: 30000,
        });
        let reply: KnowledgeWorkerReply;
        try {
          reply = await pool.run(
            { directory: canonicalInput, command: captured, admission: admission.port },
            {
              signal: options.signal,
              timeoutMs: 30000,
              transferList: (input) => [input.admission],
            },
          );
        } catch (cause) {
          if (commitGranted) {
            throw new KnowledgeWriteOutcomeUnknownError(
              "Knowledge write outcome is unknown; inspect the material/current revision before retrying. Submit retries must reuse the original request key.",
              { cause },
            );
          }
          const failure = admission.failure ?? cause;
          throw failure instanceof Error
            ? failure
            : new Error("Knowledge worker failed", { cause: failure });
        }
        if (!reply.ok) {
          const failure = admission.failure;
          throw failure instanceof Error ? failure : new Error(reply.message);
        }
        // Reads must still belong to the current recipient when published.
        if (!mutation) {
          options.signal?.throwIfAborted();
          options.assertCurrent();
        }
        // The command and reply use one private discriminated worker protocol.
        return reply.value as KnowledgeResult<C>;
      } finally {
        admission.finish();
      }
    },
    async close(): Promise<void> {
      closed = true;
      await pool?.close();
    },
  };
}
