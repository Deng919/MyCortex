import { z } from "zod";
import { projectProfileSchema } from "./project-contract.js";
import { conversationContextSchema, entryRoles, knowledgeEntitySchema } from "./social-contract.js";

/** These labels describe an interpretation of a source, never verified reality. */
export const organizationSchema = z
  .strictObject({
    topics: z.array(z.string().trim().min(1).max(80)).max(5),
    privacyLevel: z.enum(["normal", "personal", "highly-sensitive"]).optional(),
    entities: z.array(knowledgeEntitySchema).max(24).optional(),
    context: conversationContextSchema.optional(),
    relevance: z.enum(["current", "background", "historical"]).optional(),
    projectProfile: projectProfileSchema.optional(),
    entries: z
      .array(
        z.strictObject({
          summary: z.string().trim().min(1).max(500),
          subject: z.string().trim().min(1).max(160),
          stance: z.enum(["explicit", "intent", "uncertain", "other-view"]),
          quote: z.string().min(1).max(2000),
          timeText: z.string().min(1).max(160).nullable(),
          ...entryRoles,
        }),
      )
      .max(8),
  })
  .superRefine((organization, context) => {
    const entities = organization.entities ?? [];
    const ids = new Set(entities.map((entity) => entity.id));
    if (ids.size !== entities.length) {
      context.addIssue({ code: "custom", message: "Duplicate entity identity" });
    }
    const references = [
      ...(organization.context?.participantIds ?? []),
      ...(organization.context?.relatedIds ?? []),
      ...organization.entries.flatMap((entry) => [
        ...(entry.speakerIds ?? []),
        ...(entry.addresseeIds ?? []),
        ...(entry.aboutIds ?? []),
        ...(entry.relation
          ? [
              entry.relation.fromId,
              entry.relation.toId,
              ...(entry.relation.scopeId ? [entry.relation.scopeId] : []),
            ]
          : []),
      ]),
    ];
    if (references.some((reference) => !ids.has(reference))) {
      context.addIssue({ code: "custom", message: "Knowledge references an unknown entity" });
    }
    if (
      organization.projectProfile &&
      !entities.some(
        (entity) =>
          entity.id === organization.projectProfile?.entityId && entity.kind === "project",
      )
    ) {
      context.addIssue({
        code: "custom",
        message: "Project profile must reference a project entity",
      });
    }
  });

/** Dialogue identity survives edits; claims and relationship interpretations do not. */
export function organizationMetadata(organization: KnowledgeOrganization | null) {
  if (!organization) {
    return {};
  }
  return {
    ...(organization.privacyLevel ? { privacyLevel: organization.privacyLevel } : {}),
    ...(organization.entities ? { entities: organization.entities } : {}),
    ...(organization.context ? { context: organization.context } : {}),
    ...(organization.relevance ? { relevance: organization.relevance } : {}),
    ...(organization.projectProfile ? { projectProfile: organization.projectProfile } : {}),
  };
}

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
