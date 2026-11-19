import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { createKnowledgeClient } from "./client.js";
import { startKnowledgeDesktop } from "./desktop-server.js";
import { entityKey } from "./social-contract.js";

const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).toReversed()) {
    await close();
  }
});

async function fixture() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "knowledge-desktop-"));
  cleanup.push(() => fs.rm(directory, { recursive: true, force: true }));
  const desktop = await startKnowledgeDesktop({ directory });
  cleanup.push(() => desktop.close());
  const request = (route: string, data?: unknown) =>
    fetch(`${desktop.origin}/api/${route}`, {
      method: data === undefined ? "GET" : "POST",
      headers: {
        authorization: `Bearer ${desktop.token}`,
        "content-type": "application/json",
        origin: desktop.origin,
      },
      body: data === undefined ? undefined : JSON.stringify(data),
    });
  return { desktop, directory, request };
}

it("exposes the authenticated social network and validates history and pagination filters", async () => {
  const { desktop, request } = await fixture();
  expect((await fetch(`${desktop.origin}/api/network`)).status).toBe(401);
  const result = await request("network");
  expect(result.status).toBe(200);
  expect(await result.json()).toEqual({
    privacyLevel: "normal",
    entities: [],
    relations: [],
    conversations: [],
    truncated: false,
  });
  for (const route of [
    "network?includeHistorical=maybe",
    "network?limit=0",
    "network?offset=-1",
    "materials?includeHistorical=maybe",
  ]) {
    expect((await request(route)).status).toBe(400);
  }
}, 30000);

it("returns specific dialogue context and current social evidence through HTTP, invalidating claims on correction", async () => {
  const { request, directory } = await fixture();
  const client = createKnowledgeClient(directory);
  cleanup.push(() => client.close());
  const identity = {
    platform: "synthetic",
    accountScope: "synthetic-owner",
    nativeId: "synthetic-contact",
    nickname: "小林",
    remark: "林老师",
  };
  const teacherId = entityKey(identity);
  const organization = {
    topics: ["合成课程"],
    privacyLevel: "personal" as const,
    entities: [
      { id: "self", name: "我", kind: "person" as const },
      { id: teacherId, name: "小林", kind: "person" as const, identity },
    ],
    context: {
      conversationId: "synthetic:course",
      participantIds: ["self", teacherId],
      summary: "与林老师讨论课程报告",
    },
    entries: [
      {
        summary: "本人称对方为林老师",
        subject: "本人",
        stance: "explicit" as const,
        quote: "林老师，我计划下周交报告。",
        timeText: null,
        speakerIds: ["self"],
        addresseeIds: [teacherId],
        relation: {
          fromId: "self",
          toId: teacherId,
          label: "课程老师",
          basis: "explicit" as const,
        },
      },
    ],
  };
  const input = {
    requestKey: "http-social",
    title: "合成课程报告",
    body: "林老师，我计划下周交报告。",
    sourceUri: "synthetic:course",
    author: "合成用户",
    submittedBy: "synthetic-agent",
    kind: "text" as const,
  };
  const saved = await client.execute(
    { operation: "submit", input, organization },
    { assertCurrent() {} },
  );
  if (!saved) {
    throw new Error("Synthetic knowledge was not saved");
  }
  await client.execute(
    {
      operation: "submit",
      input: { ...input, requestKey: "http-social-old" },
      organization: { ...organization, relevance: "historical" },
    },
    { assertCurrent() {} },
  );
  expect(await (await request("materials")).json()).toMatchObject({ items: [{ id: saved.id }] });
  expect((await (await request("materials?includeHistorical=true")).json()).items).toHaveLength(2);
  expect((await (await request("materials?q=林老师")).json()).items).toHaveLength(1);
  expect(
    (await (await request("materials?q=林老师&includeHistorical=true")).json()).items,
  ).toHaveLength(2);
  const graph = await (await request(`network?entityId=${encodeURIComponent(teacherId)}`)).json();
  expect(graph.entities).toContainEqual(
    expect.objectContaining({
      id: teacherId,
      nickname: "小林",
      remark: "林老师",
      identity,
    }),
  );
  expect(graph.privacyLevel).toBe("personal");
  expect(graph.relations).toMatchObject([
    { materialId: saved.id, fromId: "self", toId: teacherId, basis: "explicit" },
  ]);
  expect(JSON.stringify(graph)).toContain(identity.accountScope);
  expect(JSON.stringify(graph)).toContain(identity.nativeId);
  expect((await (await request("network?includeHistorical=true")).json()).relations).toHaveLength(
    2,
  );
  expect(
    (
      await request(`materials/${saved.id}/correct`, {
        expectedRevision: 1,
        title: "合成：调整报告安排",
        body: "报告安排已经调整。",
        note: "合成纠正",
      })
    ).ok,
  ).toBe(true);
  const corrected = await (await request(`materials/${saved.id}`)).json();
  expect(corrected.title).toBe("合成：调整报告安排");
  expect(corrected.organization.organization).toMatchObject({
    context: organization.context,
    entries: [],
  });
  expect((await (await request("network")).json()).relations).toEqual([]);
  expect((await request(`materials/${saved.id}/delete`, { expectedRevision: 2 })).ok).toBe(true);
  expect((await (await request("network")).json()).entities).toEqual([]);
}, 30000);

it("saves explicit handwritten knowledge and manages reads, corrections and deletion through HTTP", async () => {
  const { request } = await fixture();
  expect(await (await request("materials")).json()).toMatchObject({ items: [] });
  const body = "合成知识：卷积可以表示线性时不变系统的输出。";
  const draft = {
    requestKey: "desktop-lifecycle",
    title: "合成学习笔记",
    body,
    sourceUri: "synthetic:desktop",
    author: "synthetic-user",
    kind: "text",
    entryMode: "manual-knowledge",
  };
  const saved = await (await request("materials", draft)).json();
  expect(saved).toMatchObject({ revision: 1 });
  expect(saved.body).toContain(body);
  expect(saved.body).toContain("归属：用户手写知识");
  expect(await (await request("materials", draft)).json()).toMatchObject({ id: saved.id });
  expect(await (await request("materials?q=卷积")).json()).toMatchObject({
    items: [{ id: saved.id }],
  });
  const read = await (await request(`materials/${saved.id}`)).json();
  expect(read.body).toBe(saved.body);
  expect(read.organization.organization).toMatchObject({
    entries: [
      { summary: "合成学习笔记", subject: "用户手写知识", stance: "explicit", quote: body },
    ],
  });
  const changed = await request(`materials/${saved.id}/correct`, {
    expectedRevision: 1,
    body: "合成纠正：学习拉普拉斯变换。",
    note: "改正计划",
  });
  expect(await changed.json()).toMatchObject({ revision: 2, body: "合成纠正：学习拉普拉斯变换。" });
  expect((await request(`materials/${saved.id}/delete`, { expectedRevision: 1 })).status).toBe(409);
  expect(await (await request(`materials/${saved.id}/history`)).json()).toHaveLength(2);
  expect(await (await request(`materials/${saved.id}?revision=1`)).json()).toMatchObject({
    body: saved.body,
  });
  expect((await request(`materials/${saved.id}/delete`, { expectedRevision: 2 })).ok).toBe(true);
  expect(await (await request("materials")).json()).toMatchObject({ items: [] });
  expect((await request(`materials/${saved.id}`)).status).toBe(404);
}, 30000);

it("rejects unrefined pasted text without creating a store and still accepts source links", async () => {
  const { request, directory } = await fixture();
  const source = {
    requestKey: "unrefined",
    title: "聊天原文",
    body: "甲：今天吃什么？乙：随便。",
    sourceUri: "synthetic:chat",
    author: "synthetic-user",
    kind: "text",
  };
  const rejected = await request("materials", source);
  expect(rejected.status).toBe(422);
  expect(await rejected.json()).toMatchObject({ error: expect.stringContaining("Agent") });
  expect(await (await request("materials")).json()).toMatchObject({ items: [] });
  expect(await fs.readdir(directory)).not.toContain("knowledge.sqlite");
  const reference = await request("materials", {
    ...source,
    requestKey: "link",
    kind: "reference",
    body: "",
  });
  expect(reference.ok).toBe(true);
  expect(await reference.json()).toMatchObject({
    kind: "reference",
    body: "",
    sourceUri: "synthetic:chat",
  });
}, 30000);

it("refuses unauthenticated, cross-origin, invalid and oversized requests without writing", async () => {
  const { desktop, request } = await fixture();
  expect((await fetch(`${desktop.origin}/api/materials`)).status).toBe(401);
  expect(
    (
      await fetch(`${desktop.origin}/api/materials`, {
        method: "POST",
        headers: { authorization: `Bearer ${desktop.token}`, origin: "https://example.invalid" },
        body: "{}",
      })
    ).status,
  ).toBe(403);
  expect((await request("materials", { title: "incomplete" })).status).toBe(400);
  expect((await request("materials", { body: "x".repeat(300000) })).status).toBe(413);
  expect((await request("materials?q=" + "a".repeat(101))).status).toBe(400);
  expect(await (await request("materials")).json()).toMatchObject({ items: [] });
  const page = await fetch(desktop.origin);
  expect(page.headers.get("content-security-policy")).toContain("default-src 'self'");
}, 30000);
