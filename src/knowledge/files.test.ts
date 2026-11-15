import { createHash } from "node:crypto";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { __setFsSafeTestHooksForTest } from "@openclaw/fs-safe/test-hooks";
import { afterEach, expect, it } from "vitest";
import { createTrackedTempDirs } from "../test-utils/tracked-temp-dirs.js";
import { readKnowledgeFile } from "./files.js";

const temps = createTrackedTempDirs();
afterEach(async () => {
  __setFsSafeTestHooksForTest(undefined);
  await temps.cleanup();
});
async function fixture() {
  const directory = await temps.make("mycortex-file-");
  const root = path.join(directory, "allowed");
  await fs.mkdir(root);
  const filename = path.join(root, "中文 笔记.txt");
  await fs.writeFile(filename, "合成原文：学习卷积。", "utf8");
  const options = { sourceUri: pathToFileURL(filename).href, roots: [root], assertCurrent() {} };
  return { directory, root, filename, options };
}

it("reads bounded source text in place and reports updated versions without retaining deleted content", async () => {
  const { filename, options } = await fixture();
  const first = await readKnowledgeFile({ ...options, offset: 5, length: 2 });
  expect(first).toMatchObject({
    body: "学习",
    offset: 5,
    totalLength: 10,
    truncated: true,
    sourceUri: options.sourceUri,
  });
  expect(first.hash).toBe(createHash("sha256").update("合成原文：学习卷积。").digest("hex"));
  expect(first.stat).toMatchObject({ size: Buffer.byteLength("合成原文：学习卷积。") });
  expect(typeof first.stat.ino).toBe("string");
  await fs.writeFile(filename, "新版本原文", "utf8");
  const current = await readKnowledgeFile(options);
  expect(current.body).toBe("新版本原文");
  expect(current.hash).not.toBe(first.hash);
  await fs.rm(filename);
  await expect(readKnowledgeFile(options)).rejects.toMatchObject({ code: "not-found" });
});

it("rejects sibling paths, directory symlinks, and hardlinks outside the approved root", async () => {
  const { directory, root, options } = await fixture();
  const outside = path.join(directory, "allowed-other");
  await fs.mkdir(outside);
  const secret = path.join(outside, "secret.txt");
  await fs.writeFile(secret, "synthetic private text", "utf8");
  await expect(
    readKnowledgeFile({ ...options, sourceUri: pathToFileURL(secret).href }),
  ).rejects.toThrow(/outside|approved/i);
  const link = path.join(root, "linked");
  await fs.symlink(outside, link, process.platform === "win32" ? "junction" : "dir");
  await expect(
    readKnowledgeFile({ ...options, sourceUri: pathToFileURL(path.join(link, "secret.txt")).href }),
  ).rejects.toMatchObject({ code: expect.stringMatching(/^(symlink|outside-workspace)$/) });
  const hardlink = path.join(root, "hardlink.txt");
  await fs.link(secret, hardlink);
  await expect(
    readKnowledgeFile({ ...options, sourceUri: pathToFileURL(hardlink).href }),
  ).rejects.toMatchObject({ code: "hardlink" });
});

it("rejects invalid bounds, non-file URLs, malformed UTF-8, and files over 256 KiB", async () => {
  const { filename, options } = await fixture();
  for (const invalid of [
    { offset: -1 },
    { length: 0 },
    { length: 8001 },
    { roots: ["relative"] },
    { sourceUri: "https://example.invalid/note" },
  ]) {
    await expect(readKnowledgeFile({ ...options, ...invalid })).rejects.toThrow();
  }
  await fs.writeFile(filename, Buffer.from([0xc3, 0x28]));
  await expect(readKnowledgeFile(options)).rejects.toThrow(/utf|encoded|encoding/i);
  await fs.writeFile(filename, Buffer.alloc(256 * 1024 + 1));
  await expect(readKnowledgeFile(options)).rejects.toMatchObject({ code: "too-large" });
});

it("refuses a file changed after its initial stat instead of attaching stale version metadata", async () => {
  const { filename, options } = await fixture();
  __setFsSafeTestHooksForTest({
    afterRootReadFinalPathIdentityCheck(filePath) {
      if (filePath === filename) {
        fsSync.writeFileSync(filename, "changed synthetic body with a different length", "utf8");
      }
    },
  });
  await expect(readKnowledgeFile(options)).rejects.toThrow(/changed/i);
});

it("refuses results when authority or cancellation changes during asynchronous preparation", async () => {
  const { options } = await fixture();
  let revoked = false;
  await expect(
    readKnowledgeFile({
      ...options,
      assertCurrent() {
        if (revoked) {
          throw new Error("synthetic permission revoked");
        }
        queueMicrotask(() => {
          revoked = true;
        });
      },
    }),
  ).rejects.toThrow(/revoked/);
  const controller = new AbortController();
  await expect(
    readKnowledgeFile({
      ...options,
      signal: controller.signal,
      assertCurrent() {
        queueMicrotask(() => controller.abort(new Error("synthetic cancelled")));
      },
    }),
  ).rejects.toThrow(/cancelled/);
});
