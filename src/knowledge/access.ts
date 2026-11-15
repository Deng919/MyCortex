import fs from "node:fs/promises";
import path from "node:path";
import { acquireFileLock } from "../infra/file-lock.js";
import { KnowledgeStore } from "./store.js";

/** All CLI processes use the canonical store path and the same exclusive lock. */
export async function withKnowledgeStore<T>(
  directory: string,
  create: boolean,
  operation: (store: KnowledgeStore) => T | Promise<T>,
): Promise<T> {
  if (create) {
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  }
  const canonical = await fs.realpath(directory);
  const filename = path.join(canonical, "knowledge.sqlite");
  const lock = await acquireFileLock(filename, {
    retries: { retries: 8, factor: 1.5, minTimeout: 50, maxTimeout: 500 },
    stale: 60000,
    staleRecovery: "remove-if-definitely-stale",
  });
  try {
    const store = new KnowledgeStore(filename, { create });
    try {
      return await operation(store);
    } finally {
      store.close();
    }
  } finally {
    await lock.release();
  }
}
