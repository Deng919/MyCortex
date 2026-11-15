import { z } from "zod";

/** These labels describe an interpretation of a source, never verified reality. */
export const organizationSchema = z.strictObject({
  topics: z.array(z.string().trim().min(1).max(80)).max(5),
  entries: z
    .array(
      z.strictObject({
        summary: z.string().trim().min(1).max(500),
        subject: z.string().trim().min(1).max(160),
        stance: z.enum(["explicit", "intent", "uncertain", "other-view"]),
        quote: z.string().min(1).max(2000),
        timeText: z.string().min(1).max(160).nullable(),
      }),
    )
    .max(8),
});

export type KnowledgeOrganization = z.output<typeof organizationSchema>;

export const organizationResultSchema = z
  .strictObject({
    status: z.enum(["organized", "empty", "failed", "skipped"]),
    organization: organizationSchema.optional(),
    processor: z.string().trim().min(1).max(512),
  })
  .superRefine((result, context) => {
    if (result.status === "organized" && !result.organization?.entries.length) {
      context.addIssue({
        code: "custom",
        message: "Organized material needs at least one source-backed entry",
      });
    }
    if (result.status !== "organized" && result.organization?.entries.length) {
      context.addIssue({ code: "custom", message: "Only an organized result may contain entries" });
    }
  });

export type OrganizationResult = z.input<typeof organizationResultSchema>;
export type OrganizationStatus = "pending" | OrganizationResult["status"];
export const organizationRowSchema = z.strictObject({
  materialId: z.uuid(),
  sourceRevision: z.number().int().positive(),
  revision: z.number().int().positive(),
  status: z.enum(["pending", "organized", "empty", "failed", "skipped"]),
  organization: z
    .string()
    .max(160 * 1024)
    .nullable(),
  processor: z.string().trim().min(1).max(512).nullable(),
  manual: z.number().int().min(0).max(1),
  updatedAt: z.iso.datetime({ offset: true }),
});
export type OrganizationRow = z.output<typeof organizationRowSchema>;

/** Quotations and expressed time stay anchored to the exact retained source. */
export function validateOrganization(value: unknown, source: string): KnowledgeOrganization {
  const organization = organizationSchema.parse(value);
  for (const entry of organization.entries) {
    if (!source.includes(entry.quote)) {
      throw new Error("Organization quote is not an exact source substring");
    }
    if (entry.timeText !== null && !entry.quote.includes(entry.timeText)) {
      throw new Error("Organization timeText is not an exact source substring");
    }
  }
  return organization;
}
