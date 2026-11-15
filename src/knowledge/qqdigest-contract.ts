import { z } from "zod";
import { MAX_BODY_BYTES } from "./contract.js";

const label = z.string().trim().min(1).max(512);
const body = z
  .string()
  .min(1)
  .refine(
    (value) => Buffer.byteLength(value, "utf8") <= MAX_BODY_BYTES,
    "QQ Digest material body exceeds 256 KiB",
  );
const timestamp = z.iso.datetime({ offset: true });

const candidateSchema = z.strictObject({
  candidateId: z.number().int().positive(),
  candidateRevision: z.number().int().positive(),
  requestKey: z
    .string()
    .regex(/^qqdigest:candidate:[1-9]\d*$/)
    .max(512),
  title: z.string().trim().min(1).max(300),
  candidateType: z.enum(["resource", "experience"]),
  filterReason: z.string().trim().min(1).max(2000),
  groupId: z.number().int().positive(),
  groupName: label,
  messageIds: z.array(label).max(40),
  body,
  sourceUri: z.string().trim().min(1).max(2048),
  author: label,
  observedAt: timestamp,
  context: z.unknown(),
});

export const qqDigestBundleSchema = z
  .strictObject({
    format: z.literal("mycortex.qqdigest"),
    version: z.literal(1),
    exportedAt: timestamp,
    source: z.literal("qq-digest"),
    candidates: z.array(candidateSchema).max(10000),
  })
  .superRefine((bundle, ctx) => {
    const keys = new Set<string>();
    const ids = new Set<number>();
    for (const [index, candidate] of bundle.candidates.entries()) {
      if (keys.has(candidate.requestKey)) {
        ctx.addIssue({
          code: "custom",
          path: ["candidates", index, "requestKey"],
          message: "Duplicate QQ Digest request key",
        });
      }
      if (ids.has(candidate.candidateId)) {
        ctx.addIssue({
          code: "custom",
          path: ["candidates", index, "candidateId"],
          message: "Duplicate QQ Digest candidate ID",
        });
      }
      keys.add(candidate.requestKey);
      ids.add(candidate.candidateId);
      if (candidate.requestKey !== `qqdigest:candidate:${candidate.candidateId}`) {
        ctx.addIssue({
          code: "custom",
          path: ["candidates", index, "requestKey"],
          message: "Request key does not match candidate ID",
        });
      }
    }
  });

export type QqDigestBundle = z.output<typeof qqDigestBundleSchema>;
