// Source-checkout entry: node --import ./scripts/tsx.mjs scripts/mycortex-knowledge.mts knowledge ...
import { Command } from "commander";
import { registerKnowledgeCli } from "../src/cli/knowledge-cli.js";

const program = new Command().name("mycortex").description("MyCortex local knowledge preview");
registerKnowledgeCli(program);
try {
  await program.parseAsync();
} catch (error) {
  console.error(
    JSON.stringify({ error: error instanceof Error ? error.message : "Knowledge command failed" }),
  );
  process.exitCode = 1;
}
