/**
 * Per-user daily limits for AI endpoints, counted atomically in Postgres by
 * `public.consume_ai_quota` (service role only). Limits come from env so they
 * can change without a deploy; defaults suit a free tier.
 */
import type { Env } from './http.ts';

export interface QuotaLimits {
  maxCalls: number;
  maxTokens: number;
}

const DEFAULTS: Record<string, QuotaLimits> = {
  'ai-classify': { maxCalls: 200, maxTokens: 400_000 },
  'ai-generate': { maxCalls: 60, maxTokens: 200_000 },
  'ai-vision': { maxCalls: 20, maxTokens: 200_000 },
  'ai-extract': { maxCalls: 10, maxTokens: 100_000 },
  health: { maxCalls: 500, maxTokens: 0 },
};

export function limitsFor(endpoint: string, env: Env): QuotaLimits {
  const base = DEFAULTS[endpoint] ?? { maxCalls: 50, maxTokens: 100_000 };
  const key = endpoint.replace(/-/g, '_').toUpperCase();
  const calls = Number(env.get(`LIMIT_${key}_CALLS`));
  const tokens = Number(env.get(`LIMIT_${key}_TOKENS`));
  return {
    maxCalls: Number.isFinite(calls) && calls > 0 ? calls : base.maxCalls,
    maxTokens: Number.isFinite(tokens) && tokens >= 0 ? tokens : base.maxTokens,
  };
}

/** Calls the Postgres function; resolves true when the call is within today's limit. */
export type ConsumeQuota = (
  args: { userId: string; endpoint: string; tokens: number } & QuotaLimits,
) => Promise<boolean>;
