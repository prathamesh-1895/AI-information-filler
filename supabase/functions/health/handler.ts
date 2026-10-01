/**
 * `health`: lets a signed-in user check that the backend is reachable and
 * whether an AI provider is configured. It never returns any key.
 */
import { requireUser, type VerifyToken } from '../_shared/auth.ts';
import { gate, json, type Env } from '../_shared/http.ts';

export interface HealthDeps {
  env: Env;
  verifyToken: VerifyToken;
}

const PROVIDER_KEYS: Record<string, string> = {
  gemini: 'GEMINI_API_KEY',
  groq: 'GROQ_API_KEY',
  openrouter: 'OPENROUTER_API_KEY',
  ollama: 'OLLAMA_URL',
};

export function providerConfigured(env: Env): { configured: boolean; provider: string | null } {
  const provider = (env.get('AI_PROVIDER') ?? '').trim().toLowerCase();
  const keyName = PROVIDER_KEYS[provider];
  return {
    configured: Boolean(keyName && env.get(keyName)?.trim()),
    provider: keyName ? provider : null,
  };
}

export async function handleHealth(request: Request, deps: HealthDeps): Promise<Response> {
  const gated = gate(request, deps.env, ['GET', 'POST']);
  if (gated instanceof Response) return gated;
  const user = await requireUser(request, deps.verifyToken, gated.origin);
  if (user instanceof Response) return user;
  const { configured, provider } = providerConfigured(deps.env);
  return json({ ok: true, providerConfigured: configured, provider }, 200, gated.origin);
}
