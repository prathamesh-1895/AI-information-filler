/**
 * Settings → AI (PLAYBOOK Task 8.5): the connection check and today's usage.
 * Both use the signed-in user's own token; usage rows come straight from
 * `ai_usage`, which RLS lets each user read for themselves only.
 */
import type { AiClient, CloudAiSeam } from '@filler/ai-client';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { AiTestResult, AiUsage } from '../messaging/protocol';

const SAMPLE_FIELD = {
  id: 'connection-check',
  inputType: 'text',
  label: 'Favourite colour',
  required: false,
};

/** Calls `health`, then a one-field classify, and reports what happened in plain words. */
export async function testAiConnection(
  client: AiClient,
  seam: CloudAiSeam,
  now: () => number = () => Date.now(),
): Promise<AiTestResult> {
  const started = now();
  const done = (ok: boolean, message: string, provider: string | null = null): AiTestResult => ({
    ok,
    message,
    provider,
    latencyMs: Math.max(0, now() - started),
  });
  const health = await client.health();
  await seam.refreshStatus(true);
  if (!health.ok) return done(false, health.message);
  if (!health.data.providerConfigured)
    return done(
      false,
      'Filler’s server is reachable, but no AI provider is set up on it yet. Filler works in offline mode.',
      health.data.provider,
    );
  const result = await client.classify({ fields: [SAMPLE_FIELD], page: { host: 'filler.test' } });
  if (!result.ok) return done(false, result.message, health.data.provider);
  const answer = result.data.results[0];
  const seconds = ((now() - started) / 1000).toFixed(1);
  return done(
    true,
    answer
      ? `AI is working (${result.data.provider ?? health.data.provider}, ${seconds} s). It read “Favourite colour” as ${answer.kind === 'open_ended' ? 'a written answer' : `a ${answer.kind}`}.`
      : `The AI answered in ${seconds} s but gave nothing usable for the test field.`,
    result.data.provider ?? health.data.provider,
  );
}

/** UTC day, matching Postgres `current_date` on Supabase. */
export const todayUtc = (date = new Date()) => date.toISOString().slice(0, 10);

export async function aiUsageToday(
  supabase: SupabaseClient | null,
  client: AiClient,
): Promise<AiUsage> {
  if (!supabase) throw new Error('Cloud features are not set up in this build of Filler.');
  const day = todayUtc();
  const [{ data, error }, health] = await Promise.all([
    supabase.from('ai_usage').select('endpoint, calls, tokens').eq('day', day),
    client.health(),
  ]);
  if (error) throw new Error(`Could not read AI usage: ${error.message}`);
  const limits = health.ok ? (health.data.limits ?? {}) : {};
  const rows = (data ?? []) as Array<{ endpoint: string; calls: number; tokens: number }>;
  const names = [...new Set([...Object.keys(limits), ...rows.map((r) => r.endpoint)])].filter(
    (e) => e !== 'health',
  );
  return {
    day,
    endpoints: names.sort().map((endpoint) => {
      const row = rows.find((r) => r.endpoint === endpoint);
      const limit = limits[endpoint];
      return {
        endpoint,
        calls: row?.calls ?? 0,
        tokens: row?.tokens ?? 0,
        ...(limit ? { maxCalls: limit.maxCalls, maxTokens: limit.maxTokens } : {}),
      };
    }),
  };
}
