import { createKnowledgeTools } from "../agents/tools/knowledge-tools.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  KnowledgeCapabilitySchema,
  KnowledgeConfigSchema,
  type KnowledgeCapability,
} from "../knowledge/config.js";
import { connectToolsMcpServerToStdio, createToolsMcpServer } from "./tools-stdio-server.js";

/** Local stdio inherits the launching operator's explicit grant; there is no unauthenticated listener. */
export function createKnowledgeMcpServer(options: {
  directory: string;
  connectionId: string;
  capabilities: KnowledgeCapability[];
  fileRoots?: string[];
}) {
  const knowledge = KnowledgeConfigSchema.parse({
    directory: options.directory,
    connections: { [options.connectionId]: options.capabilities },
    fileRoots: options.fileRoots,
  });
  const config: OpenClawConfig = { tools: { knowledge } };
  const cleanups: Array<() => Promise<void>> = [];
  let active = true;
  const tools = createKnowledgeTools({
    getConfig: () => config,
    connectionId: options.connectionId,
    assertCurrent: () => {
      if (!active) {
        throw new Error("Knowledge MCP connection closed");
      }
    },
    registerCleanup: (close) => cleanups.push(close),
  });
  const server = createToolsMcpServer({ name: "mycortex-knowledge", tools });
  return {
    server,
    async close() {
      active = false;
      try {
        await server.close();
      } finally {
        for (const close of cleanups.splice(0)) {
          await close();
        }
      }
    },
  };
}

export async function serveKnowledgeMcp(options: {
  directory: string;
  connectionId: string;
  capabilities: string;
  fileRoots?: string[];
}) {
  const capabilities = options.capabilities
    .split(",")
    .map((value) => KnowledgeCapabilitySchema.parse(value.trim()));
  const service = createKnowledgeMcpServer({ ...options, capabilities });
  try {
    await connectToolsMcpServerToStdio(service.server);
  } finally {
    await service.close();
  }
}
