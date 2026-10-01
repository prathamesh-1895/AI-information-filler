/**
 * Per-user and global daily limits for AI endpoints, counted atomically in
 * Postgres by `public.consume_ai_call` and `public.record_ai_tokens`
 * (service role only). Limits come from env so they can change without a
 * deploy; defaults suit a free tier.
 */
import type { Env } from './http.ts';

export interface QuotaLimits {
  maxCalls: number;
  /** 0 = no token limit. */
  maxTokens: number;
}

export const QUOTA_ENDPOINTS = ['ai-classify', 'ai-generate', 'ai-vision', 'ai-extract'] as const;

const DEFAULTS: Record<string, QuotaLimits> = {
  'ai-classify': { maxCalls: 200, maxTokens: 400_000 },
  'ai-generate': { maxCalls: 60, maxTokens: 200_000 },
  'ai-vision': { maxCalls: 20, maxTokens: 200_000 },
  'ai-extract': { maxCalls: 10, maxTokens: 100_000 },
  health: { maxCalls: 500, maxTokens: 0 },
};

const GLOBAL_DEFAULT: QuotaLimits = { maxCalls: 2_000, maxTokens: 4_000_000 };

function read(env: Env, prefix: string, base: QuotaLimits): QuotaLimits {
  const calls = Number(env.get(`${prefix}_CALLS`));
  const tokens = Number(env.get(`${prefix}_TOKENS`));
  return {
    maxCalls: Number.isFinite(calls) && calls > 0 ? calls : base.maxCalls,
    maxTokens: Number.isFinite(tokens) && tokens >= 0 ? tokens : base.maxTokens,
  };
}

/** Per-user daily limits for one endpoint (`LIMIT_AI_CLASSIFY_CALLS`, `…_TOKENS`). */
export function limitsFor(endpoint: string, env: Env): QuotaLimits {
  const base = DEFAULTS[endpoint] ?? { maxCalls: 50, maxTokens: 100_000 };
  return read(env, `LIMIT_${endpoint.replace(/-/g, '_').toUpperCase()}`, base);
}

/** Limits across all users together (`LIMIT_GLOBAL_CALLS`, `LIMIT_GLOBAL_TOKENS`). */
export function globalLimits(env: Env): QuotaLimits {
  return read(env, 'LIMIT_GLOBAL', GLOBAL_DEFAULT);
}

export type QuotaVerdict = 'ok' | 'user_limit' | 'global_limit';

/** Checks both limits and, when allowed, counts one call (`consume_ai_call`). */
export type ConsumeQuota = (args: {
  userId: string;
  endpoint: string;
  limits: QuotaLimits;
  global: QuotaLimits;
}) => Promise<QuotaVerdict>;

/** Adds the tokens a call really used (`record_ai_tokens`). */
export type RecordTokens = (args: {
  userId: string;
  endpoint: string;
  tokens: number;
}) => Promise<void>;

export const LIMIT_MESSAGES: Record<Exclude<QuotaVerdict, 'ok'>, string> = {
  user_limit:
    "You've reached today's AI limit. Filler keeps working in offline mode and asks you instead. The limit resets tomorrow.",
  global_limit:
    "Filler's shared AI allowance is used up for today. Filler keeps working in offline mode and asks you instead.",
};
