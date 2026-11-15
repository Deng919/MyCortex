import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { withKnowledgeStore } from "./access.js";
import { createKnowledgeClient, KnowledgeWriteOutcomeUnknownError } from "./client.js";

const roots: string[] = [];
const clients: ReturnType<typeof createKnowledgeClient>[] = [];
const submission = {
  requestKey: "worker-test",
  title: "Synthetic note",
  body: "Alpha 卷积 " + "x".repeat(9000),
  sourceUri: "synthetic:worker",
  author: "synthetic-user",
  submittedBy: "synthetic-connection",
  kind: "text" as const,
};
async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "knowledge-worker-"));
  roots.push(root);
  const directory = path.join(root, "store");
  const client = createKnowledgeClient(directory);
  clients.push(client);
  return { directory, client };
}
afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.close()));
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

describe("knowledge runtime worker", () => {
  it("serves the complete material lifecycle off-thread and releases the CLI lock between calls", async () => {
    const { client, directory } = await fixture();
    const options = { assertCurrent() {} };
    expect(await client.execute({ operation: "list", input: {} }, options)).toEqual([]);
    expect(
      await client.execute({ operation: "search", input: { terms: ["missing"] } }, options),
    ).toEqual([]);
    const material = await client.execute({ operation: "submit", input: submission }, options);
    expect(await client.execute({ operation: "pending", input: {} }, options)).toMatchObject([
      { id: material.id },
    ]);
    await client.execute(
      {
        operation: "organize",
        input: {
          id: material.id,
          expectedRevision: 1,
          result: {
            status: "organized",
            processor: "synthetic/model",
            organization: {
              topics: ["synthetic"],
              entries: [
                {
                  summary: "Source mentions Alpha",
                  subject: "source",
                  stance: "explicit",
                  quote: "Alpha",
                  timeText: null,
                },
              ],
            },
          },
        },
      },
      options,
    );
    expect(
      await client.execute({ operation: "organization", input: { id: material.id } }, options),
    ).toMatchObject({ status: "organized", sourceRevision: 1 });
    expect(
      await client.execute({ operation: "search", input: { terms: ["ALPHA", "卷积"] } }, options),
    ).toMatchObject([{ id: material.id }]);
    const read = await client.execute(
      { operation: "read", input: { id: material.id, length: 20 } },
      options,
    );
    expect(read.body.length).toBe(20);
    expect(read.truncated).toBe(true);
    const changed = await client.execute(
      {
        operation: "correct",
        input: {
          id: material.id,
          expectedRevision: 1,
          correction: {
            body: "Updated",
            note: "synthetic correction",
            submittedBy: "synthetic-connection",
          },
        },
      },
      options,
    );
    expect(changed.revision).toBe(2);
    expect(
      await client.execute({ operation: "history", input: { id: material.id } }, options),
    ).toHaveLength(2);
    expect(
      await withKnowledgeStore(directory, false, (store) => store.read(material.id)),
    ).toMatchObject({ body: "Updated" });
    await client.execute(
      { operation: "delete", input: { id: material.id, expectedRevision: 2 } },
      options,
    );
    expect(await client.execute({ operation: "list", input: {} }, options)).toEqual([]);
    await expect(
      client.execute({ operation: "read", input: { id: material.id } }, options),
    ).rejects.toThrow(/deleted/i);
  });

  it("rechecks current authority after lock waits and before committing", async () => {
    const { client } = await fixture();
    await client.execute({ operation: "submit", input: submission }, { assertCurrent() {} });
    let admissions = 0;
    await expect(
      client.execute(
        { operation: "submit", input: { ...submission, requestKey: "revoked" } },
        {
          assertCurrent() {
            if (++admissions >= 3) {
              throw new Error("revoked");
            }
          },
        },
      ),
    ).rejects.toThrow(/revoked/);
    expect(
      await client.execute({ operation: "list", input: {} }, { assertCurrent() {} }),
    ).toHaveLength(1);
  });

  it("rejects cancellation before dispatch without creating the store", async () => {
    const { client, directory } = await fixture();
    const controller = new AbortController();
    controller.abort(new Error("cancelled"));
    await expect(
      client.execute(
        { operation: "submit", input: submission },
        {
          assertCurrent() {},
          signal: controller.signal,
        },
      ),
    ).rejects.toThrow(/cancelled/);
    await expect(fs.stat(directory)).rejects.toThrow();
  });

  it("reports uncertain writes when cancellation loses the reply after commit admission", async () => {
    const { client } = await fixture();
    await client.execute({ operation: "submit", input: submission }, { assertCurrent() {} });
    const controller = new AbortController();
    let checks = 0;
    await expect(
      client.execute(
        { operation: "submit", input: { ...submission, requestKey: "late-cancellation" } },
        {
          signal: controller.signal,
          assertCurrent() {
            if (++checks === 3) {
              queueMicrotask(() => controller.abort(new Error("late cancellation")));
            }
          },
        },
      ),
    ).rejects.toBeInstanceOf(KnowledgeWriteOutcomeUnknownError);
    // The worker must finish its native section and release the lock before reconciliation.
    const reconciled = await client.execute(
      { operation: "list", input: {} },
      { assertCurrent() {} },
    );
    expect(reconciled).toHaveLength(2);
  });
});
