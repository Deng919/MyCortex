import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { FsSafeError } from "@openclaw/fs-safe/errors";
import { isPathRelativeEscape } from "@openclaw/fs-safe/path";
import { root } from "@openclaw/fs-safe/root";
import { MAX_BODY_BYTES } from "./contract.js";

export type ReadKnowledgeFileOptions = {
  sourceUri: string;
  roots: string[];
  offset?: number;
  length?: number;
  assertCurrent: () => void;
  signal?: AbortSignal;
};

export type KnowledgeFileRead = {
  sourceUri: string;
  body: string;
  offset: number;
  totalLength: number;
  truncated: boolean;
  hash: string;
  stat: { size: number; mtimeMs: number; ctimeMs: number; dev: string; ino: string };
};

// Match the Number timestamp view returned by fs-safe without rounding whole epoch nanoseconds.
function milliseconds(nanoseconds: bigint): number {
  const remainder = ((nanoseconds % 1_000_000_000n) + 1_000_000_000n) % 1_000_000_000n;
  return Number((nanoseconds - remainder) / 1_000_000_000n) * 1000 + Number(remainder) / 1_000_000;
}

export async function readKnowledgeFile(
  options: ReadKnowledgeFileOptions,
): Promise<KnowledgeFileRead> {
  const assertActive = () => {
    options.signal?.throwIfAborted();
    options.assertCurrent();
  };
  assertActive();
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
  if (options.roots.some((directory) => !path.isAbsolute(directory))) {
    throw new Error("Approved file roots must be absolute directories");
  }
  const filename = fileURLToPath(options.sourceUri);
  const directory = options.roots
    .toSorted((a, b) => b.length - a.length)
    .find((candidate) => {
      const relative = path.relative(candidate, filename);
      return relative !== "" && !isPathRelativeEscape(relative);
    });
  if (!directory) {
    throw new Error("File is outside the approved directories");
  }
  const authority = await root(directory, { hardlinks: "reject", symlinks: "reject" });
  assertActive();
  const read = await authority.read(path.relative(directory, filename), {
    hardlinks: "reject",
    symlinks: "reject",
    maxBytes: MAX_BODY_BYTES,
  });
  assertActive();
  const current = await fs.lstat(read.realPath, { bigint: true });
  if (
    !current.isFile() ||
    current.nlink !== 1n ||
    current.dev !== read.exactIdentity.dev ||
    current.ino !== read.exactIdentity.ino ||
    Number(current.size) !== read.stat.size ||
    read.buffer.length !== read.stat.size ||
    milliseconds(current.mtimeNs) !== read.stat.mtimeMs ||
    milliseconds(current.ctimeNs) !== read.stat.ctimeMs
  ) {
    throw new FsSafeError("path-mismatch", "File changed while reading; read it again");
  }
  const text = new TextDecoder("utf-8", { fatal: true }).decode(read.buffer);
  const result = {
    sourceUri: pathToFileURL(read.realPath).href,
    body: text.slice(offset, offset + length),
    offset,
    totalLength: text.length,
    truncated: offset > 0 || offset + length < text.length,
    hash: createHash("sha256").update(read.buffer).digest("hex"),
    stat: {
      size: read.buffer.length,
      mtimeMs: read.stat.mtimeMs,
      ctimeMs: read.stat.ctimeMs,
      dev: current.dev.toString(),
      ino: current.ino.toString(),
    },
  };
  assertActive();
  return result;
}
