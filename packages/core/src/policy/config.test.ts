import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { DenyListConfigSchema, policyFromConfig } from './config';

describe('deny-list config', () => {
  it('ships a valid config/deny-list.json', () => {
    const json: unknown = JSON.parse(
      readFileSync(new URL('../../../../config/deny-list.json', import.meta.url), 'utf8'),
    );
    expect(DenyListConfigSchema.safeParse(json).success).toBe(true);
  });

  it('applies user phrases and rejects malformed config', () => {
    const policy = policyFromConfig({ extraPatterns: ['blood group'] });
    expect(policy.classifyRisk({ inputType: 'text', label: 'Blood Group' })).toMatchObject({
      allowed: false,
    });
    expect(() => policyFromConfig({ extraPatterns: 'blood group' })).toThrow();
    expect(() => policyFromConfig({ extraPatterns: [''] })).toThrow();
  });
});
