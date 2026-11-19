import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { expect, it } from "vitest";
import type { KnowledgeCapability } from "../knowledge/config.js";
import { createKnowledgeMcpServer } from "./knowledge-serve.js";

it.each<KnowledgeCapability[]>([["read"], ["submit"], ["read", "submit"], ["manage"]])(
  "delivers automatic personal-context guidance only for granted capabilities: %j",
  async (...capabilities) => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "knowledge-mcp-guidance-"));
    const service = createKnowledgeMcpServer({
      directory,
      connectionId: "synthetic-guidance",
      capabilities,
    });
    const client = new Client({ name: "synthetic-guidance", version: "1" });
    const [outbound, inbound] = InMemoryTransport.createLinkedPair();
    try {
      await Promise.all([service.server.connect(inbound), client.connect(outbound)]);
      const instructions = client.getInstructions() ?? "";
      const tools = (await client.listTools()).tools;
      if (capabilities.includes("read")) {
        expect(instructions).toMatch(/speaker.*addressee/i);
        expect(instructions).toMatch(/includeHistorical/);
        expect(instructions).toMatch(/inferred/);
      }
      for (const [capability, name, guidance] of [
        ["read", "knowledge_read", /Before personalizing/],
        ["submit", "knowledge_write", /Automatically save/],
      ] as const) {
        if (capabilities.includes(capability)) {
          expect(instructions).toMatch(guidance);
          expect(tools.find((tool) => tool.name === name)?.description).toMatch(guidance);
        } else {
          expect(instructions).not.toMatch(guidance);
          expect(tools.find((tool) => tool.name === name)?.description ?? "").not.toMatch(guidance);
        }
      }
    } finally {
      await client.close();
      await service.close();
      await fs.rm(directory, { recursive: true, force: true });
    }
  },
);

it("exposes the same durable knowledge tools over MCP with a host-owned read-only grant", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "knowledge-mcp-"));
  const service = createKnowledgeMcpServer({
    directory,
    connectionId: "external-reader",
    capabilities: ["read"],
  });
  const client = new Client({ name: "synthetic-test", version: "1" });
  const [outbound, inbound] = InMemoryTransport.createLinkedPair();
  try {
    await Promise.all([service.server.connect(inbound), client.connect(outbound)]);
    expect((await client.listTools()).tools.map((tool) => tool.name)).toEqual(["knowledge_read"]);
    const listed = await client.callTool({ name: "knowledge_read", arguments: { action: "list" } });
    expect(listed.isError).not.toBe(true);
    expect(listed.content).toContainEqual(
      expect.objectContaining({ type: "text", text: expect.stringContaining('"results": []') }),
    );
    const network = await client.callTool({
      name: "knowledge_read",
      arguments: { action: "network", limit: 50, includeHistorical: true },
    });
    expect(network.isError).not.toBe(true);
    expect(network.content).toContainEqual(
      expect.objectContaining({
        type: "text",
        text: expect.stringContaining('"truncated": false'),
      }),
    );
    expect(
      (
        await client.callTool({
          name: "knowledge_read",
          arguments: { action: "network", limit: 51 },
        })
      ).isError,
    ).toBe(true);
    const denied = await client.callTool({
      name: "knowledge_write",
      arguments: { action: "delete", id: "untrusted" },
    });
    expect(denied.isError).toBe(true);
  } finally {
    await client.close();
    await service.close();
    await fs.rm(directory, { recursive: true, force: true });
  }
});

it("reads an indexed file through the external connection's explicit roots", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "knowledge-mcp-files-"));
  const filename = path.join(directory, "synthetic.txt");
  await fs.writeFile(filename, "合成原位文件");
  const service = createKnowledgeMcpServer({
    directory: path.join(directory, "store"),
    connectionId: "external-files",
    capabilities: ["read", "submit"],
    fileRoots: [directory],
  });
  const client = new Client({ name: "synthetic-files", version: "1" });
  const [outbound, inbound] = InMemoryTransport.createLinkedPair();
  try {
    await Promise.all([service.server.connect(inbound), client.connect(outbound)]);
    expect(
      (await client.listTools()).tools.find((tool) => tool.name === "knowledge_write")?.inputSchema,
    ).toMatchObject({
      type: "object",
      properties: {
        action: expect.anything(),
        body: expect.anything(),
        organization: expect.anything(),
      },
    });
    const source = {
      action: "submit",
      requestId: "synthetic-refined",
      title: "合成聊天",
      body: "闲聊天气不错。本人可能明年读研，尚未决定。",
      sourceUri: "synthetic:chat",
    };
    expect((await client.callTool({ name: "knowledge_write", arguments: source })).isError).toBe(
      true,
    );
    const refined = await client.callTool({
      name: "knowledge_write",
      arguments: {
        ...source,
        organization: {
          topics: ["学习计划"],
          entries: [
            {
              summary: "读研计划未定",
              subject: "本人",
              stance: "uncertain",
              quote: "本人可能明年读研，尚未决定。",
              timeText: "明年",
            },
          ],
        },
      },
    });
    expect(refined.isError).not.toBe(true);
    const receipt = refined.content.find((part) => part.type === "text");
    if (receipt?.type !== "text") {
      throw new Error("Expected refinement receipt");
    }
    const knowledgeId = (JSON.parse(receipt.text) as { id: string }).id;
    const knowledge = await client.callTool({
      name: "knowledge_read",
      arguments: { action: "read", id: knowledgeId },
    });
    expect(JSON.stringify(knowledge.content)).toContain("读研计划未定");
    expect(JSON.stringify(knowledge.content)).not.toContain("闲聊");
    const saved = await client.callTool({
      name: "knowledge_write",
      arguments: {
        action: "submit",
        title: "合成文件",
        body: "",
        kind: "reference",
        sourceUri: pathToFileURL(filename).href,
      },
    });
    const content = saved.content.find((part) => part.type === "text");
    expect(content?.type).toBe("text");
    if (content?.type !== "text") {
      throw new Error("Expected a saved receipt");
    }
    const { id } = JSON.parse(content.text) as { id: string };
    const read = await client.callTool({
      name: "knowledge_read",
      arguments: { action: "read_file", id },
    });
    expect(read.isError).not.toBe(true);
    expect(read.content).toContainEqual(
      expect.objectContaining({
        type: "text",
        text: expect.stringContaining("合成原位文件"),
      }),
    );
  } finally {
    await client.close();
    await service.close();
    await fs.rm(directory, { recursive: true, force: true });
  }
});
