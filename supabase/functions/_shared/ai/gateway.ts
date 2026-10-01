/**
 * The AI gateway (PLAYBOOK Task 8.1): one `complete()` for every caller.
 *
 * Configuration (Supabase secrets, never code):
 *   AI_PROVIDER        primary provider, or a comma list for fallback order ("gemini,groq")
 *   <P>_API_KEY        each provider's key (OLLAMA_URL for Ollama)
 *   AI_MODEL_FAST / AI_MODEL_SMART / AI_MODEL_VISION   models for the primary provider
 *   <P>_MODEL_FAST …   per-provider models (needed for fallbacks; override AI_MODEL_* too)
 *   AI_TIMEOUT_MS, AI_MAX_OUTPUT_TOKENS, AI_MAX_INPUT_CHARS   limits
 *
 * Behaviour: per-attempt timeout; retry with exponential backoff on 429, 5xx,
 * timeouts and network errors; then the next configured provider. A provider
 * missing a key or a model for the tier is skipped. Adding a provider means a
 * new adapter in providers.ts; no caller changes.
 */
import type { Env } from '../http.ts';
import { createAdapter, PROVIDER_SECRET } from './providers.ts';
import {
  PROVIDER_NAMES,
  ProviderError,
  type CompleteRequest,
  type CompleteResult,
  type FetchLike,
  type ProviderAdapter,
  type ProviderName,
  type Tier,
} from './types.ts';

export interface CallLog {
  provider: string;
  model: string;
  tier: Tier;
  attempt: number;
  latencyMs: number;
  outcome: 'ok' | 'error';
  status?: number;
  inputTokens?: number;
  outputTokens?: number;
}

export interface GatewayDeps {
  env: Env;
  fetch: FetchLike;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  /** Metadata only: never prompts or replies. */
  log?: (entry: CallLog) => void;
  /** Adapter factory (tests inject fakes). */
  adapter?: (name: ProviderName, secret: string, fetchFn: FetchLike) => ProviderAdapter;
}

export interface Route {
  adapter: ProviderAdapter;
  model: string;
}

export class AiUnavailableError extends Error {
  // A plain field, not a parameter property: Node's type stripping (used by the e2e mock) can't run those.
  readonly reason: 'not_configured' | 'unavailable' | 'too_large';

  constructor(message: string, reason: AiUnavailableError['reason']) {
    super(message);
    this.name = 'AiUnavailableError';
    this.reason = reason;
  }
}

const num = (env: Env, name: string, fallback: number) => {
  const n = Number(env.get(name));
  return Number.isFinite(n) && n > 0 ? n : fallback;
};

/** Configured provider order (unknown names are ignored). */
export function providerOrder(env: Env): ProviderName[] {
  const names = (env.get('AI_PROVIDER') ?? '')
    .split(',')
    .map((n) => n.trim().toLowerCase())
    .filter((n): n is ProviderName => (PROVIDER_NAMES as readonly string[]).includes(n));
  return [...new Set(names)];
}

/** Model for a provider and tier: `<P>_MODEL_<TIER>`, else `AI_MODEL_<TIER>` for the primary only. */
export function modelFor(
  env: Env,
  provider: ProviderName,
  tier: Tier,
  primary: boolean,
): string | null {
  const own = env.get(`${provider.toUpperCase()}_MODEL_${tier.toUpperCase()}`)?.trim();
  if (own) return own;
  const shared = primary ? env.get(`AI_MODEL_${tier.toUpperCase()}`)?.trim() : undefined;
  return shared || null;
}

export function createGateway(deps: GatewayDeps) {
  const env = deps.env;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const now = deps.now ?? (() => Date.now());
  const make = deps.adapter ?? createAdapter;
  const timeoutMs = num(env, 'AI_TIMEOUT_MS', 20_000);
  const maxOutput = num(env, 'AI_MAX_OUTPUT_TOKENS', 4096);
  const maxInputChars = num(env, 'AI_MAX_INPUT_CHARS', 60_000);
  const retries = Math.min(4, Math.floor(num(env, 'AI_RETRIES', 2)));

  function routes(tier: Tier): Route[] {
    const order = providerOrder(env);
    const out: Route[] = [];
    order.forEach((name, i) => {
      const secret = env.get(PROVIDER_SECRET[name])?.trim();
      const model = modelFor(env, name, tier, i === 0);
      if (secret && model) out.push({ adapter: make(name, secret, deps.fetch), model });
    });
    return out;
  }

  async function attempt(route: Route, req: CompleteRequest, tier: Tier, n: number) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const started = now();
    try {
      const reply = await route.adapter.complete(req, route.model, controller.signal);
      deps.log?.({
        provider: route.adapter.name,
        model: route.model,
        tier,
        attempt: n,
        latencyMs: now() - started,
        outcome: 'ok',
        inputTokens: reply.usage.inputTokens,
        outputTokens: reply.usage.outputTokens,
      });
      return reply;
    } catch (error) {
      deps.log?.({
        provider: route.adapter.name,
        model: route.model,
        tier,
        attempt: n,
        latencyMs: now() - started,
        outcome: 'error',
        ...(error instanceof ProviderError && error.status ? { status: error.status } : {}),
      });
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    /** True when at least one provider has a key and a model for this tier. */
    configured(tier: Tier = 'fast'): boolean {
      return routes(tier).length > 0;
    },

    async complete(req: CompleteRequest, tier: Tier): Promise<CompleteResult> {
      const chain = routes(tier);
      if (!chain.length)
        throw new AiUnavailableError('No AI provider is set up on the server.', 'not_configured');
      const size = req.system.length + req.messages.reduce((sum, m) => sum + m.content.length, 0);
      if (size > maxInputChars)
        throw new AiUnavailableError('The request is too large for the AI.', 'too_large');
      const capped: CompleteRequest = { ...req, maxTokens: Math.min(req.maxTokens, maxOutput) };

      let last: unknown;
      for (const route of chain) {
        for (let n = 0; n <= retries; n++) {
          try {
            const reply = await attempt(route, capped, tier, n + 1);
            return { ...reply, provider: route.adapter.name, model: route.model };
          } catch (error) {
            last = error;
            const retryable = error instanceof ProviderError && error.retryable;
            if (!retryable || n === retries) break;
            const backoff = 500 * 2 ** n + Math.floor(Math.random() * 250);
            const hinted = error instanceof ProviderError ? error.retryAfterMs : undefined;
            await sleep(Math.min(8_000, Math.max(backoff, hinted ?? 0)));
          }
        }
      }
      throw new AiUnavailableError(
        `Every AI provider failed (${last instanceof Error ? last.message : 'unknown error'}).`,
        'unavailable',
      );
    },
  };
}

export type Gateway = ReturnType<typeof createGateway>;
