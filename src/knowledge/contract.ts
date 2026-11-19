import { z } from "zod";
import { organizationRowSchema, type OrganizationRow } from "./organization-contract.js";

export const MAX_BODY_BYTES = 256 * 1024;
export const MAX_EXPORT_BYTES = 32 * 1024 * 1024;
const label = z.string().trim().min(1).max(512);
const body = z
  .string()
  .refine(
    (value) => Buffer.byteLength(value, "utf8") <= MAX_BODY_BYTES,
    "Material body exceeds 256 KiB",
  );
const timestamp = z.iso.datetime({ offset: true });

export const submissionSchema = z
  .strictObject({
    requestKey: label,
    title: z.string().trim().min(1).max(300),
    body,
    sourceUri: z.string().trim().min(1).max(2048),
    author: label,
    submittedBy: label,
    observedAt: timestamp.nullable().default(null),
    kind: z.enum(["text", "reference"]),
  })
  .superRefine((value, ctx) => {
    if (value.kind === "text" && !value.body.trim()) {
      ctx.addIssue({ code: "custom", message: "Text material needs a body" });
    }
    if (value.kind === "reference" && value.body !== "") {
      ctx.addIssue({ code: "custom", message: "A reference stores a URI, not retrieved content" });
    }
  });

export const correctionSchema = z.strictObject({
  title: z.string().trim().min(1).max(300).optional(),
  body: body.refine((value) => value.trim().length > 0, "Correction needs a body"),
  note: z.string().trim().min(1).max(2000),
  submittedBy: label,
});

export const materialRowSchema = z.strictObject({
  id: z.uuid(),
  requestKey: label,
  fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  currentRevision: z.number().int().positive(),
  deletedAt: timestamp.nullable(),
});
export const revisionRowSchema = z.strictObject({
  materialId: z.uuid(),
  revision: z.number().int().positive(),
  title: z.string().trim().min(1).max(300),
  body,
  sourceUri: z.string().trim().min(1).max(2048),
  author: label,
  submittedBy: label,
  observedAt: timestamp.nullable(),
  recordedAt: timestamp,
  kind: z.enum(["text", "reference"]),
  note: z.string().max(2000),
});
const originalBundleSchema = z.strictObject({
  format: z.literal("mycortex.materials"),
  version: z.literal(1),
  exportedAt: timestamp,
  materials: z.array(materialRowSchema).max(10000),
  revisions: z.array(revisionRowSchema).max(100000),
});

export const bundleSchema = z.union([
  originalBundleSchema.extend({
    version: z.literal(2),
    organizations: z.array(organizationRowSchema).max(10000),
  }),
  originalBundleSchema.transform((bundle) => ({
    ...bundle,
    version: 2 as const,
    organizations: [] as OrganizationRow[],
  })),
]);

export type Submission = z.input<typeof submissionSchema>;
export type Correction = z.input<typeof correctionSchema>;
export type MaterialRow = z.output<typeof materialRowSchema>;
export type RevisionRow = z.output<typeof revisionRowSchema>;
export type KnowledgeBundle = z.output<typeof bundleSchema>;
export type Material = Omit<MaterialRow, "fingerprint" | "deletedAt" | "currentRevision"> &
  Omit<RevisionRow, "materialId">;
export type KnowledgeTables = {
  materials: MaterialRow;
  revisions: RevisionRow;
  organizations: OrganizationRow;
};
