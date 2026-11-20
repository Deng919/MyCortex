import { z } from "zod";

const label = z.string().trim().min(1).max(512);
const id = z.string().trim().min(1).max(160);

export const projectProfileSchema = z.strictObject({
  entityId: id,
  name: label,
  purpose: z.string().trim().min(1).max(2000),
  status: z.enum(["active", "paused", "archived"]),
  locations: z
    .array(
      z.strictObject({
        kind: z.enum(["workspace", "entrypoint", "docs", "data"]),
        path: z.string().trim().min(1).max(4096),
        note: z.string().trim().min(1).max(512).optional(),
      }),
    )
    .max(12),
  capabilities: z
    .array(
      z.strictObject({
        name: label,
        summary: z.string().trim().min(1).max(1000),
        entrypoint: z
          .strictObject({
            kind: z.enum(["cli", "script", "skill", "mcp", "path"]),
            value: label,
          })
          .optional(),
        usage: z.string().trim().min(1).max(2000).optional(),
      }),
    )
    .max(24),
  design: z.string().trim().min(1).max(4000).optional(),
  dependencies: z.array(label).max(24).optional(),
  limitations: z.array(z.string().trim().min(1).max(1000)).max(24).optional(),
  verifiedAt: z.iso.datetime({ offset: true }).nullable().optional(),
});

export type ProjectProfile = z.output<typeof projectProfileSchema>;
