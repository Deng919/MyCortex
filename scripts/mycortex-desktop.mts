import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { Command } from "commander";
import { startKnowledgeDesktop } from "../src/knowledge/desktop-server.js";

const program = new Command()
  .name("mycortex-desktop")
  .requiredOption("--store <directory>", "Knowledge directory shared with MCP")
  .option("--open", "Open an independent Microsoft Edge app window")
  .option("--profile <directory>", "Explicit browser cache directory")
  .option("--port <port>", "Optional fixed local port for development", (value: string) => {
    const port = Number(value);
    if (!Number.isInteger(port) || port < 0 || port > 65535) {
      throw new Error("Invalid port");
    }
    return port;
  })
  .parse();
const options = program.opts<{ store: string; open?: boolean; profile?: string; port?: number }>();
if (options.open && (process.platform !== "win32" || !options.profile)) {
  throw new Error("--open requires Windows and an explicit --profile directory");
}
const desktop = await startKnowledgeDesktop({ directory: options.store, port: options.port });
let closed = false;
async function close() {
  if (closed) {
    return;
  }
  closed = true;
  await desktop.close();
  process.exit(0);
}
process.on("SIGINT", () => void close());
process.on("SIGTERM", () => void close());
if (options.open) {
  const candidates = [
    process.env["ProgramFiles(x86)"],
    process.env.ProgramFiles,
    process.env.LOCALAPPDATA,
  ]
    .filter((value): value is string => Boolean(value))
    .map((root) => path.join(root, "Microsoft", "Edge", "Application", "msedge.exe"));
  let edge: string | undefined;
  for (const candidate of candidates) {
    if (
      await fs.stat(candidate).then(
        (info) => info.isFile(),
        () => false,
      )
    ) {
      edge = candidate;
      break;
    }
  }
  if (!edge) {
    await desktop.close();
    throw new Error(
      "Microsoft Edge not found. Start without --open and open the printed local URL.",
    );
  }
  const browser = spawn(
    edge,
    [
      `--user-data-dir=${path.resolve(options.profile!)}`,
      `--app=${desktop.url}`,
      "--no-first-run",
      "--no-default-browser-check",
    ],
    { detached: true, stdio: "ignore", windowsHide: true },
  );
  browser.on("error", (error) => {
    console.error(error.message);
    void close();
  });
  browser.unref();
  // The page pings while open; exiting after two quiet minutes also covers browser crashes.
  setInterval(() => {
    if (Date.now() - desktop.lastActivity > 120000) {
      void close();
    }
  }, 15000).unref();
  console.log("MyCortex window opened.");
} else {
  // This URL is a local launch credential. Do not retain it in logs or shared evidence.
  console.log(desktop.url);
}
