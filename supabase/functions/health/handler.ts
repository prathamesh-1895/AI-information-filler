/**
 * `health`: lets a signed-in user check that the backend is reachable,
 * whether an AI provider is configured, and today's per-user AI limits.
 * It never returns any key.
 */
import { requireUser, type VerifyToken } from '../_shared/auth.ts';
import { modelFor, providerOrder } from '../_shared/ai/gateway.ts';
import { PROVIDER_SECRET } from '../_shared/ai/providers.ts';
import { gate, json, type Env } from '../_shared/http.ts';
import { limitsFor, QUOTA_ENDPOINTS, type QuotaLimits } from '../_shared/quota.ts';

export interface HealthDeps {
  env: Env;
  verifyToken: VerifyToken;
}

/**
 * Configured = at least one provider in AI_PROVIDER has its key (or Ollama URL)
 * and a fast model. `provider` is the first usable one, else the first named.
 */
export function providerConfigured(env: Env): { configured: boolean; provider: string | null } {
  const order = providerOrder(env);
  const usable = order.find(
    (p, i) =>
      Boolean(env.get(PROVIDER_SECRET[p])?.trim()) && Boolean(modelFor(env, p, 'fast', i === 0)),
  );
  return { configured: Boolean(usable), provider: usable ?? order[0] ?? null };
}

export async function handleHealth(request: Request, deps: HealthDeps): Promise<Response> {
  const gated = gate(request, deps.env, ['GET', 'POST']);
  if (gated instanceof Response) return gated;
  const user = await requireUser(request, deps.verifyToken, gated.origin);
  if (user instanceof Response) return user;
  const { configured, provider } = providerConfigured(deps.env);
  const limits: Record<string, QuotaLimits> = {};
  for (const endpoint of QUOTA_ENDPOINTS) limits[endpoint] = limitsFor(endpoint, deps.env);
  return json({ ok: true, providerConfigured: configured, provider, limits }, 200, gated.origin);
}
