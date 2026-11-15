import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Command } from "commander";
import { afterEach, expect, it, vi } from "vitest";
import { registerSubCliByName } from "./program/register.subclis.js";

let directory: string | undefined;
afterEach(async () => {
  vi.restoreAllMocks();
  if (directory) {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

it("runs the material lifecycle through the actual command parser and local store", async () => {
  directory = await fs.mkdtemp(path.join(os.tmpdir(), "mycortex-cli-"));
  const store = path.join(directory, "store");
  const text = path.join(directory, "material.txt");
  await fs.writeFile(text, "合成资料：电路中电压为 5V。", "utf8");
  const output = vi.spyOn(console, "log").mockImplementation(() => {});
  async function run(...args: string[]) {
    const program = new Command().exitOverride();
    await registerSubCliByName(program, "knowledge", ["node", "openclaw", "knowledge"]);
    await program.parseAsync(["node", "openclaw", "knowledge", "--store", store, ...args]);
    return JSON.parse(String(output.mock.calls.at(-1)?.[0])) as Record<string, unknown>;
  }
  await run("init");
  const saved = await run(
    "add",
    "--file",
    text,
    "--title",
    "合成电路",
    "--source",
    "synthetic:circuit",
    "--author",
    "synthetic-user",
    "--request",
    "cli-1",
  );
  expect(saved).toMatchObject({ body: "合成资料：电路中电压为 5V。", revision: 1 });
  const id = String(saved.id);
  expect(await run("read", id)).toMatchObject({ sourceUri: "synthetic:circuit" });
  await fs.writeFile(text, "合成纠正：电压为 3V。", "utf8");
  expect(
    await run("correct", id, "--revision", "1", "--file", text, "--note", "合成纠正"),
  ).toMatchObject({ revision: 2, body: "合成纠正：电压为 3V。" });
  await expect(run("delete", id, "--revision", "1")).rejects.toThrow(/revision/i);
  const exported = path.join(directory, "backup.json");
  await run("export", "--out", exported);
  await expect(run("export", "--out", exported)).rejects.toThrow(/exist/i);
  const deleted = await run("delete", id, "--revision", "2");
  expect(deleted).toMatchObject({ deleted: true, id });
  await expect(run("read", id)).rejects.toThrow(/deleted/i);
  expect(JSON.parse(await fs.readFile(exported, "utf8"))).toMatchObject({
    format: "mycortex.materials",
    version: 2,
  });
  const ledger = path.join(directory, "latest-deletions.json");
  await run("export-deletions", "--out", ledger);
  expect(await fs.readFile(ledger, "utf8")).not.toContain("电压");
  expect(JSON.parse(await fs.readFile(ledger, "utf8"))).toMatchObject({ materials: [{ id }] });
  await expect(run("import", "--file", exported)).rejects.toThrow(/deletions-from/);
});

it("imports a QQ Digest bundle through the actual command parser", async () => {
  directory = await fs.mkdtemp(path.join(os.tmpdir(), "mycortex-qqdigest-cli-"));
  const store = path.join(directory, "store");
  const bundle = path.join(directory, "qqdigest.json");
  await fs.writeFile(
    bundle,
    JSON.stringify({
      format: "mycortex.qqdigest",
      version: 1,
      exportedAt: "2026-11-15T00:00:00.000Z",
      source: "qq-digest",
      candidates: [
        {
          candidateId: 11,
          candidateRevision: 2,
          requestKey: "qqdigest:candidate:11",
          title: "合成 QQ 资料",
          candidateType: "resource",
          filterReason: "对用户有帮助",
          groupId: 123,
          groupName: "学习群",
          messageIds: ["m1"],
          body: "# 合成 QQ 资料\n\n原文和上下文",
          sourceUri: "qqdigest://group/123/message/m1",
          author: "QQ Digest 群 学习群",
          observedAt: "2026-11-15T08:00:00.000+08:00",
          context: { source_context: [] },
        },
      ],
    }),
    "utf8",
  );
  const output = vi.spyOn(console, "log").mockImplementation(() => {});
  async function run(...args: string[]) {
    const program = new Command().exitOverride();
    await registerSubCliByName(program, "knowledge", ["node", "openclaw", "knowledge"]);
    await program.parseAsync(["node", "openclaw", "knowledge", "--store", store, ...args]);
    return JSON.parse(String(output.mock.calls.at(-1)?.[0])) as Record<string, unknown>;
  }
  await run("init");
  expect(await run("import-qqdigest", "--file", bundle)).toMatchObject({
    imported: 1,
    updated: 0,
  });
  expect(await run("import-qqdigest", "--file", bundle)).toMatchObject({
    imported: 0,
    unchanged: 1,
  });
});
