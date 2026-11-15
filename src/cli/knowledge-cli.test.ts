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
