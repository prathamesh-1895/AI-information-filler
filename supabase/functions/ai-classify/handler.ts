/**
 * `ai-classify` (PLAYBOOK Task 8.3): what is each unresolved field asking?
 *
 * Input: up to 120 minimised field descriptors (no values), page host/title,
 * goal. Output per field: kind, canonicalKey?, newKeySuggestion?, confidence,
 * reason, question. Fast model, temperature 0, ≤ 40 fields per model call.
 * Chunks are cached by a hash of what was sent (descriptors, host, goal,
 * prompt version, provider chain); the cache holds classifications only, no
 * personal data. Quota is checked before any model call; cache hits are free.
 */
import { requireUser, type VerifyToken } from '../_shared/auth.ts';
import {
  CLASSIFY_PROMPT_VERSION,
  ClassifiedFieldSchema,
  ClassifyRequestSchema,
  guardAll,
  type AiField,
  type ClassifiedField,
  type ClassifyResponse,
} from '../_shared/core/index.ts';
import {
  AiUnavailableError,
  providerOrder,
  modelFor,
  type Gateway,
} from '../_shared/ai/gateway.ts';
import { allowedFields, chunk, classifyChunk, sanitiseField } from '../_shared/ai/envelope.ts';
import { fail, gate, json, type Env } from '../_shared/http.ts';
import {
  globalLimits,
  limitsFor,
  LIMIT_MESSAGES,
  type ConsumeQuota,
  type RecordTokens,
} from '../_shared/quota.ts';
import { z } from 'zod';

export const ENDPOINT = 'ai-classify';

export interface AiCache {
  get(hash: string): Promise<unknown>;
  set(hash: string, endpoint: string, value: unknown): Promise<void>;
}

export interface RequestLog {
  endpoint: string;
  fields: number;
  chunks: number;
  cachedChunks: number;
  rejected: number;
  inputTokens: number;
  outputTokens: number;
  latencyMs: number;
  provider: string | null;
  outcome: 'ok' | 'rate_limited' | 'not_configured' | 'unavailable' | 'bad_request';
}

export interface ClassifyDeps {
  env: Env;
  verifyToken: VerifyToken;
  gateway: Pick<Gateway, 'complete' | 'configured'>;
  consumeQuota: ConsumeQuota;
  recordTokens: RecordTokens;
  cache?: AiCache;
  /** Request metadata only: never field text or replies. */
  log?: (entry: RequestLog) => void;
  now?: () => number;
}

async function sha256(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

const CachedSchema = z.array(ClassifiedFieldSchema);

export async function handleClassify(request: Request, deps: ClassifyDeps): Promise<Response> {
  const started = (deps.now ?? Date.now)();
  const gated = gate(request, deps.env, ['POST']);
  if (gated instanceof Response) return gated;
  const origin = gated.origin;
  const user = await requireUser(request, deps.verifyToken, origin);
  if (user instanceof Response) return user;

  const meta: RequestLog = {
    endpoint: ENDPOINT,
    fields: 0,
    chunks: 0,
    cachedChunks: 0,
    rejected: 0,
    inputTokens: 0,
    outputTokens: 0,
    latencyMs: 0,
    provider: null,
    outcome: 'ok',
  };
  const done = (response: Response, outcome: RequestLog['outcome']) => {
    deps.log?.({ ...meta, outcome, latencyMs: (deps.now ?? Date.now)() - started });
    return response;
  };

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return done(fail('BAD_REQUEST', 'The request body must be JSON.', origin), 'bad_request');
  }
  const parsed = ClassifyRequestSchema.safeParse(body);
  if (!parsed.success)
    return done(
      fail(
        'BAD_REQUEST',
        `Invalid classify request: ${parsed.error.issues[0]?.message ?? ''}`,
        origin,
      ),
      'bad_request',
    );
  const input = parsed.data;
  if (!deps.gateway.configured('fast'))
    return done(
      fail(
        'AI_NOT_CONFIGURED',
        'AI is not set up on the server yet. Filler works in offline mode.',
        origin,
      ),
      'not_configured',
    );

  // Deny-listed fields never reach the model; everything else is re-redacted here.
  const fields = allowedFields(input.fields.map(sanitiseField));
  const chunks = chunk(fields);
  meta.fields = fields.length;
  meta.chunks = chunks.length;

  const chain = providerOrder(deps.env)
    .map((p, i) => `${p}:${modelFor(deps.env, p, 'fast', i === 0) ?? ''}`)
    .join(',');
  const page = { host: input.page.host, ...(input.page.title ? { title: input.page.title } : {}) };
  const hashes = await Promise.all(
    chunks.map((c) =>
      sha256(
        JSON.stringify({
          v: CLASSIFY_PROMPT_VERSION,
          chain,
          page,
          goal: input.goal ?? null,
          fields: c,
        }),
      ),
    ),
  );

  const results: ClassifiedField[] = [];
  let rejected = input.fields.length - fields.length;
  const pending: Array<{ fields: AiField[]; hash: string }> = [];
  for (const [i, c] of chunks.entries()) {
    const hit = deps.cache ? await deps.cache.get(hashes[i]!).catch(() => null) : null;
    const cached = hit ? CachedSchema.safeParse(hit) : null;
    if (cached?.success) {
      // Cached entries are checked again, exactly like fresh ones.
      const checked = guardAll(cached.data, new Map(c.map((f) => [f.id, f])));
      results.push(...checked.results);
      meta.cachedChunks++;
    } else {
      pending.push({ fields: c, hash: hashes[i]! });
    }
  }

  let provider: string | null = null;
  if (pending.length) {
    const verdict = await deps.consumeQuota({
      userId: user.id,
      endpoint: ENDPOINT,
      limits: limitsFor(ENDPOINT, deps.env),
      global: globalLimits(deps.env),
    });
    if (verdict !== 'ok')
      return done(
        fail('RATE_LIMITED', LIMIT_MESSAGES[verdict], origin, {
          scope: verdict === 'user_limit' ? 'user' : 'global',
        }),
        'rate_limited',
      );

    try {
      for (const p of pending) {
        const run = await classifyChunk(deps.gateway, p.fields, page, input.goal);
        meta.inputTokens += run.usage.inputTokens;
        meta.outputTokens += run.usage.outputTokens;
        provider = run.provider ?? provider;
        rejected += run.rejected;
        results.push(...run.results);
        if (deps.cache && run.results.length)
          await deps.cache.set(p.hash, ENDPOINT, run.results).catch(() => undefined);
      }
    } catch (error) {
      if (error instanceof AiUnavailableError) {
        const code =
          error.reason === 'not_configured' ? 'AI_NOT_CONFIGURED' : 'PROVIDER_UNAVAILABLE';
        return done(
          fail(
            code,
            error.reason === 'too_large'
              ? 'Too much page text for the AI at once.'
              : 'The AI provider is not answering right now. Filler works in offline mode.',
            origin,
          ),
          error.reason === 'not_configured' ? 'not_configured' : 'unavailable',
        );
      }
      throw error;
    } finally {
      const tokens = meta.inputTokens + meta.outputTokens;
      if (tokens > 0)
        await deps
          .recordTokens({ userId: user.id, endpoint: ENDPOINT, tokens })
          .catch(() => undefined);
    }
  }

  meta.rejected = rejected;
  meta.provider = provider;
  const response: ClassifyResponse = {
    results,
    rejected,
    cached: pending.length === 0,
    provider,
    usage: { inputTokens: meta.inputTokens, outputTokens: meta.outputTokens },
  };
  return done(json(response, 200, origin), 'ok');
}
