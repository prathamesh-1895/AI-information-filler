import { z } from 'zod';
import { createPolicy, type Policy } from './deny';

/** Shape of `config/deny-list.json` and of the user's own additions in Settings. */
export const DenyListConfigSchema = z.object({
  $comment: z.string().optional(),
  extraPatterns: z.array(z.string().trim().min(1).max(200)).max(500),
});
export type DenyListConfig = z.infer<typeof DenyListConfigSchema>;

/** Builds a policy from untrusted config JSON. Invalid config throws rather than silently loosening rules. */
export function policyFromConfig(json: unknown): Policy {
  return createPolicy({ extraPatterns: DenyListConfigSchema.parse(json).extraPatterns });
}
