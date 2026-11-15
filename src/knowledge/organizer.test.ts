import { describe, expect, it } from "vitest";
import type { Material } from "./contract.js";
import { organizationSchema } from "./organization-contract.js";
import { runKnowledgeOrganization, type KnowledgeOrganizationParams } from "./organizer.js";

const material: Material = {
  id: "c85eea8c-1d61-4562-913e-ec65e835739a",
  requestKey: "synthetic-organization",
  revision: 2,
  title: "合成讨论",
  body: "我可能明年读研，还没有决定。小林说他喜欢跑步。",
  sourceUri: "synthetic:discussion",
  author: "synthetic-author",
  submittedBy: "synthetic-operator",
  observedAt: "2026-11-15T00:00:00.000Z",
  recordedAt: "2026-11-15T01:00:00.000Z",
  kind: "text",
  note: "",
};
const organization = {
  topics: ["学习计划"],
  entries: [
    {
      summary: "作者尚未决定是否明年读研。",
      subject: "作者",
      stance: "uncertain",
      quote: "我可能明年读研，还没有决定。",
      timeText: "明年",
    },
  ],
};
const result = (text: string) => ({
  text,
  provider: "ollama",
  model: "synthetic-model",
  usage: { input: 90, output: 50 },
});
const params = (
  overrides: Partial<KnowledgeOrganizationParams> = {},
): KnowledgeOrganizationParams => ({
  material,
  provider: "ollama",
  model: "synthetic-model",
  assertCurrent() {},
  complete: async () => result(JSON.stringify(organization)),
  ...overrides,
});

describe("knowledge organization", () => {
  it("carries the source-owner dispatch check through model preparation", async () => {
    let checked = false;
    await runKnowledgeOrganization(
      params({
        prepareDispatch: async () => {
          checked = true;
        },
        complete: async (request) => {
          expect(request.prepareDispatch).toBeTypeOf("function");
          await request.prepareDispatch?.();
          return result(JSON.stringify(organization));
        },
      }),
    );
    expect(checked).toBe(true);
  });
  it("requires an explicit nonempty model route before inference", async () => {
    let calls = 0;
    await expect(
      runKnowledgeOrganization(
        params({
          model: " ",
          complete: async () => {
            calls++;
            return result(JSON.stringify(organization));
          },
        }),
      ),
    ).rejects.toThrow("explicit provider and model");
    expect(calls).toBe(0);
  });

  it("binds the source version and labels interpretations without changing the material", async () => {
    let calls = 0;
    const organized = await runKnowledgeOrganization(
      params({
        complete: async (request) => {
          calls++;
          expect(request).toMatchObject({
            provider: "ollama",
            model: "synthetic-model",
            thinkLevel: "off",
          });
          expect(request.prompt).toContain(material.body);
          expect(request.streamParams?.maxTokens).toBeGreaterThan(0);
          return result(JSON.stringify(organization));
        },
      }),
    );
    expect(calls).toBe(1);
    expect(organized).toMatchObject({
      status: "organized",
      source: { materialId: material.id, revision: 2, author: material.author },
      organization,
      usage: { input: 90, output: 50 },
    });
    expect(material.body).toBe("我可能明年读研，还没有决定。小林说他喜欢跑步。");
  });

  it.each([
    { ...organization, entries: [{ ...organization.entries[0], quote: "我决定明年读研。" }] },
    { ...organization, entries: [{ ...organization.entries[0], timeText: "2027年" }] },
    { ...organization, entries: [{ ...organization.entries[0], stance: "verified" }] },
    { ...organization, entries: [{ ...organization.entries[0], sourceRevision: 99 }] },
  ])("rejects unsupported evidence, invented times and claimed verification", async (output) => {
    expect(
      await runKnowledgeOrganization(
        params({
          complete: async () => result(JSON.stringify(output)),
        }),
      ),
    ).toMatchObject({ status: "failed", reason: "invalid-output" });
  });

  it("keeps an empty interpretation distinct from a model failure", async () => {
    expect(
      await runKnowledgeOrganization(
        params({
          complete: async () => result('{"topics":[],"entries":[]}'),
        }),
      ),
    ).toMatchObject({ status: "empty", organization: { topics: [], entries: [] } });
    let calls = 0;
    expect(
      await runKnowledgeOrganization(
        params({
          complete: async () => {
            calls++;
            throw new Error("synthetic failure");
          },
        }),
      ),
    ).toMatchObject({ status: "failed", reason: "completion-failed" });
    expect(calls).toBe(1);
  });

  it("does not publish a result after source authority changes during inference", async () => {
    let current = true;
    await expect(
      runKnowledgeOrganization(
        params({
          assertCurrent() {
            if (!current) {
              throw new Error("stale material");
            }
          },
          complete: async () => {
            current = false;
            return result(JSON.stringify(organization));
          },
        }),
      ),
    ).rejects.toThrow("stale material");
  });

  it("propagates cancellation instead of accepting or retrying the result", async () => {
    const controller = new AbortController();
    await expect(
      runKnowledgeOrganization(
        params({
          signal: controller.signal,
          complete: async () => {
            controller.abort(new Error("synthetic cancellation"));
            return result(JSON.stringify(organization));
          },
        }),
      ),
    ).rejects.toThrow("synthetic cancellation");
  });

  it("rejects results from an unexpected model route", async () => {
    expect(
      await runKnowledgeOrganization(
        params({
          complete: async () => ({ ...result(JSON.stringify(organization)), provider: "other" }),
        }),
      ),
    ).toMatchObject({ status: "failed", reason: "unexpected-model" });
  });

  it("skips references and oversized material without calling a model or truncating evidence", async () => {
    let calls = 0;
    const complete: KnowledgeOrganizationParams["complete"] = async () => {
      calls++;
      return result("{}");
    };
    expect(
      await runKnowledgeOrganization(
        params({ material: { ...material, kind: "reference", body: "" }, complete }),
      ),
    ).toMatchObject({ status: "skipped", reason: "no-saved-text" });
    expect(
      await runKnowledgeOrganization(
        params({ material: { ...material, body: "字".repeat(20000) }, complete }),
      ),
    ).toMatchObject({ status: "skipped", reason: "input-too-large" });
    expect(calls).toBe(0);
  });

  it("bounds topics and entries and preserves the four interpretation stances", () => {
    for (const stance of ["explicit", "intent", "uncertain", "other-view"]) {
      expect(
        organizationSchema.safeParse({
          ...organization,
          entries: [{ ...organization.entries[0], stance }],
        }).success,
      ).toBe(true);
    }
    expect(
      organizationSchema.safeParse({ ...organization, topics: Array(10).fill("topic") }).success,
    ).toBe(false);
    expect(
      organizationSchema.safeParse({
        ...organization,
        entries: Array(20).fill(organization.entries[0]),
      }).success,
    ).toBe(false);
  });
});
