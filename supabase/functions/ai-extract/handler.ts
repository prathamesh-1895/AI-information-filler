/**
 * `ai-extract` (PLAYBOOK Task 11.1): résumé text (contacts already removed on
 * the device) → candidate vault details. Smart model, temperature 0. Nothing
 * is cached or stored and only metadata is logged.
 */
import { requireUser, type VerifyToken } from '../_shared/auth.ts';
import { ExtractRequestSchema, type ExtractResponse } from '../_shared/core/index.ts';
import { AiUnavailableError, type Gateway } from '../_shared/ai/gateway.ts';
import { runExtract } from '../_shared/ai/extract.ts';
import { fail, gate, json, type Env } from '../_shared/http.ts';
import {
  globalLimits,
  limitsFor,
  LIMIT_MESSAGES,
  type ConsumeQuota,
  type RecordTokens,
} from '../_shared/quota.ts';

export const ENDPOINT = 'ai-extract';

export interface ExtractLog {
  endpoint: string;
  chars: number;
  facts: number;
  rejected: number;
  inputTokens: number;
  outputTokens: number;
  latencyMs: number;
  provider: string | null;
  outcome: 'ok' | 'rate_limited' | 'not_configured' | 'unavailable' | 'bad_request';
}

export interface ExtractDeps {
  env: Env;
  verifyToken: VerifyToken;
  gateway: Pick<Gateway, 'complete' | 'configured'>;
  consumeQuota: ConsumeQuota;
  recordTokens: RecordTokens;
  log?: (entry: ExtractLog) => void;
  now?: () => number;
}

export async function handleExtract(request: Request, deps: ExtractDeps): Promise<Response> {
  const now = deps.now ?? Date.now;
  const started = now();
  const gated = gate(request, deps.env, ['POST']);
  if (gated instanceof Response) return gated;
  const origin = gated.origin;
  const user = await requireUser(request, deps.verifyToken, origin);
  if (user instanceof Response) return user;

  const meta: ExtractLog = {
    endpoint: ENDPOINT,
    chars: 0,
    facts: 0,
    rejected: 0,
    inputTokens: 0,
    outputTokens: 0,
    latencyMs: 0,
    provider: null,
    outcome: 'ok',
  };
  const done = (response: Response, outcome: ExtractLog['outcome']) => {
    deps.log?.({ ...meta, outcome, latencyMs: now() - started });
    return response;
  };

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return done(fail('BAD_REQUEST', 'The request body must be JSON.', origin), 'bad_request');
  }
  const parsed = ExtractRequestSchema.safeParse(body);
  if (!parsed.success)
    return done(
      fail(
        'BAD_REQUEST',
        `Invalid extract request: ${parsed.error.issues[0]?.message ?? ''}`,
        origin,
      ),
      'bad_request',
    );
  const input = parsed.data;
  meta.chars = input.text.length;
  if (!deps.gateway.configured('smart'))
    return done(
      fail(
        'AI_NOT_CONFIGURED',
        'AI is not set up on the server yet. Filler works in offline mode.',
        origin,
      ),
      'not_configured',
    );

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
    const run = await runExtract(deps.gateway, input.text);
    meta.inputTokens = run.usage.inputTokens;
    meta.outputTokens = run.usage.outputTokens;
    meta.provider = run.provider;
    meta.facts = run.response.facts.length;
    meta.rejected = run.response.rejected;
    const response: ExtractResponse = {
      ...run.response,
      provider: run.provider,
      usage: run.usage,
    };
    return done(json(response, 200, origin), 'ok');
  } catch (error) {
    if (error instanceof AiUnavailableError) {
      const code = error.reason === 'not_configured' ? 'AI_NOT_CONFIGURED' : 'PROVIDER_UNAVAILABLE';
      return done(
        fail(
          code,
          error.reason === 'too_large'
            ? 'The text is too long for the AI. Paste a shorter part.'
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
