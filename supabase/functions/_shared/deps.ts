/**
 * Deployed implementations of the function dependencies (Deno only): token
 * verification, quota, token accounting and the classification cache, all
 * through a service-role client that never leaves the server.
 */
import { createClient } from '@supabase/supabase-js';
import type { VerifyToken } from './auth.ts';
import type { ConsumeQuota, QuotaVerdict, RecordTokens } from './quota.ts';

export const admin = createClient(
  Deno.env.get('SUPABASE_URL') ?? '',
  Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '',
  { auth: { persistSession: false, autoRefreshToken: false } },
);

export const verifyToken: VerifyToken = async (jwt) => {
  const { data, error } = await admin.auth.getUser(jwt);
  return error || !data.user
    ? null
    : { id: data.user.id, ...(data.user.email ? { email: data.user.email } : {}) };
};

export const consumeQuota: ConsumeQuota = async ({ userId, endpoint, limits, global }) => {
  const { data, error } = await admin.rpc('consume_ai_call', {
    p_user: userId,
    p_endpoint: endpoint,
    p_max_calls: limits.maxCalls,
    p_max_tokens: limits.maxTokens,
    p_global_max_calls: global.maxCalls,
    p_global_max_tokens: global.maxTokens,
  });
  // If the quota check itself fails, refuse rather than spend the shared key unmetered.
  if (error) return 'global_limit';
  return (data as QuotaVerdict) ?? 'global_limit';
};

export const recordTokens: RecordTokens = async ({ userId, endpoint, tokens }) => {
  await admin.rpc('record_ai_tokens', { p_user: userId, p_endpoint: endpoint, p_tokens: tokens });
};

export const cache = {
  async get(hash: string): Promise<unknown> {
    const { data } = await admin.from('ai_cache').select('response').eq('hash', hash).maybeSingle();
    return (data as { response?: unknown } | null)?.response ?? null;
  },
  async set(hash: string, endpoint: string, value: unknown): Promise<void> {
    await admin.from('ai_cache').upsert({ hash, endpoint, response: value });
  },
};

/** Metadata-only structured log line (Supabase function logs). */
export const log = (entry: object) => console.log(JSON.stringify({ fn: 'ai', ...entry }));
