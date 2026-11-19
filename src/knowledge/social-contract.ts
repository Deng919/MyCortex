import { createHash } from "node:crypto";
import { z } from "zod";

const id = z.string().trim().min(1).max(160);
const label = z.string().trim().min(1).max(160);
export const entityIdentitySchema = z.strictObject({
  platform: label,
  accountScope: label,
  nativeId: z.string().trim().min(1).max(512),
  nickname: label.optional(),
  remark: label.optional(),
});
export function entityKey(identity: z.output<typeof entityIdentitySchema>): string {
  return `entity:${createHash("sha256")
    .update(JSON.stringify([identity.platform, identity.accountScope, identity.nativeId]))
    .digest("hex")
    .slice(0, 32)}`;
}
export const knowledgeEntitySchema = z
  .strictObject({
    id,
    name: label,
    kind: z.enum(["person", "organization", "project", "assistant", "unknown"]),
    aliases: z.array(label).max(12).optional(),
    identity: entityIdentitySchema.optional(),
  })
  .superRefine((entity, context) => {
    if (entity.identity && entity.id !== entityKey(entity.identity)) {
      context.addIssue({
        code: "custom",
        message: "Entity ID must match its scoped source identity",
        path: ["id"],
      });
    }
  });
export const conversationContextSchema = z.strictObject({
  conversationId: z.string().trim().min(1).max(2048),
  participantIds: z.array(id).min(1).max(24),
  summary: z.string().trim().min(1).max(1000),
  relatedIds: z.array(id).max(12).optional(),
});
export const entryRoles = {
  speakerIds: z.array(id).max(8).optional(),
  addresseeIds: z.array(id).max(8).optional(),
  aboutIds: z.array(id).max(12).optional(),
  relation: z
    .strictObject({
      fromId: id,
      toId: id,
      label,
      basis: z.enum(["remark", "explicit", "inferred"]),
      scopeId: id.optional(),
    })
    .optional(),
};
export type KnowledgeEntity = z.output<typeof knowledgeEntitySchema>;
