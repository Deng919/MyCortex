import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { startKnowledgeDesktop } from "./desktop-server.js";

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

it("manages full originals and version conflicts through HTTP and the existing store worker", async () => {
  const { request } = await fixture();
  expect(await (await request("materials")).json()).toMatchObject({ items: [] });
  const body = "卷积测试" + "长文".repeat(9000);
  const draft = {
    requestKey: "desktop-lifecycle",
    title: "合成学习笔记",
    body,
    sourceUri: "synthetic:desktop",
    author: "synthetic-user",
    kind: "text",
  };
  const saved = await (await request("materials", draft)).json();
  expect(saved).toMatchObject({ body, revision: 1 });
  expect(await (await request("materials", draft)).json()).toMatchObject({ id: saved.id });
  expect(await (await request("materials?q=卷积")).json()).toMatchObject({
    items: [{ id: saved.id }],
  });
  expect(await (await request(`materials/${saved.id}`)).json()).toMatchObject({ body });
  const changed = await request(`materials/${saved.id}/correct`, {
    expectedRevision: 1,
    body: "合成纠正：学习拉普拉斯变换。",
    note: "改正计划",
  });
  expect(await changed.json()).toMatchObject({ revision: 2, body: "合成纠正：学习拉普拉斯变换。" });
  expect((await request(`materials/${saved.id}/delete`, { expectedRevision: 1 })).status).toBe(409);
  expect(await (await request(`materials/${saved.id}/history`)).json()).toHaveLength(2);
  expect(await (await request(`materials/${saved.id}?revision=1`)).json()).toMatchObject({ body });
  expect((await request(`materials/${saved.id}/delete`, { expectedRevision: 2 })).ok).toBe(true);
  expect(await (await request("materials")).json()).toMatchObject({ items: [] });
  expect((await request(`materials/${saved.id}`)).status).toBe(404);
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
