import path from "node:path";
import { z } from "zod";

export const KnowledgeCapabilitySchema = z.enum(["read", "submit", "manage", "organize"]);
export type KnowledgeCapability = z.infer<typeof KnowledgeCapabilitySchema>;

/** Connection keys are host-assigned session/connector identities, never model arguments. */
export const KnowledgeConfigSchema = z.strictObject({
  directory: z.string().min(1).refine(path.isAbsolute, "Knowledge directory must be absolute"),
  connections: z.record(z.string().min(1).max(512), z.array(KnowledgeCapabilitySchema)),
  fileRoots: z
    .array(z.string().min(1).refine(path.isAbsolute, "File roots must be absolute"))
    .max(20)
    .optional(),
  processing: z
    .strictObject({
      provider: z.string().trim().min(1),
      model: z.string().trim().min(1),
      maxOutputTokens: z.number().int().min(64).max(2000).optional(),
      timeoutMs: z.number().int().min(1000).max(60000).optional(),
    })
    .optional(),
});
