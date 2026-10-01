import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { allowedOrigin, gate } from '../functions/_shared/http.ts';
import { limitsFor } from '../functions/_shared/quota.ts';
import { handleHealth, providerConfigured } from '../functions/health/handler.ts';
import * as sharedCore from '../functions/_shared/core/index.ts';

const EXT = 'chrome-extension://abcdefghijklmnopabcdefghijklmnop';
const env = (vars: Record<string, string> = {}) => ({ get: (n: string) => vars[n] });
const verify = async (jwt: string) =>
  jwt === 'good-token' ? { id: 'user-1', email: 'a@example.com' } : null;
const req = (init: { method?: string; token?: string; origin?: string | null } = {}) =>
  new Request('https://x.supabase.co/functions/v1/health', {
    method: init.method ?? 'GET',
    headers: {
      ...(init.origin === null ? {} : { origin: init.origin ?? EXT }),
      ...(init.token ? { authorization: `Bearer ${init.token}` } : {}),
    },
  });

describe('health function', () => {
  it('rejects calls without a valid sign-in (401, structured error)', async () => {
    for (const token of [undefined, 'bad-token']) {
      const res = await handleHealth(req(token ? { token } : {}), {
        env: env(),
        verifyToken: verify,
      });
      expect(res.status).toBe(401);
      expect(await res.json()).toMatchObject({
        error: { code: 'UNAUTHENTICATED', message: expect.any(String) },
      });
    }
  });

  it('reports whether a provider is configured, never the key', async () => {
    const secret = 'AIza-super-secret-key';
    const off = await handleHealth(req({ token: 'good-token' }), {
      env: env(),
      verifyToken: verify,
    });
    expect(await off.json()).toMatchObject({ ok: true, providerConfigured: false, provider: null });
    const on = await handleHealth(req({ token: 'good-token' }), {
      env: env({ AI_PROVIDER: 'gemini', GEMINI_API_KEY: secret, AI_MODEL_FAST: 'm' }),
      verifyToken: verify,
    });
    const text = await on.text();
    expect(JSON.parse(text)).toMatchObject({
      ok: true,
      providerConfigured: true,
      provider: 'gemini',
    });
    expect(JSON.parse(text).limits['ai-classify']).toEqual({ maxCalls: 200, maxTokens: 400_000 });
    expect(text).not.toContain(secret);
    expect(on.headers.get('access-control-allow-origin')).toBe(EXT);
  });

  it('treats a provider without its key as not configured', () => {
    expect(providerConfigured(env({ AI_PROVIDER: 'groq' }))).toEqual({
      configured: false,
      provider: 'groq',
    });
    expect(providerConfigured(env({ AI_PROVIDER: 'unknown', GROQ_API_KEY: 'x' }))).toEqual({
      configured: false,
      provider: null,
    });
    // A key without a model is not usable either; a usable fallback counts.
    expect(providerConfigured(env({ AI_PROVIDER: 'gemini', GEMINI_API_KEY: 'k' })).configured).toBe(
      false,
    );
    expect(
      providerConfigured(
        env({ AI_PROVIDER: 'gemini,groq', GROQ_API_KEY: 'q', GROQ_MODEL_FAST: 'llama' }),
      ),
    ).toEqual({ configured: true, provider: 'groq' });
  });

  it('answers CORS preflight for the extension and refuses web pages', async () => {
    const pre = await handleHealth(req({ method: 'OPTIONS' }), { env: env(), verifyToken: verify });
    expect(pre.status).toBe(204);
    expect(pre.headers.get('access-control-allow-headers')).toContain('authorization');
    const evil = await handleHealth(req({ origin: 'https://evil.example', token: 'good-token' }), {
      env: env(),
      verifyToken: verify,
    });
    expect(evil.status).toBe(403);
    expect(evil.headers.get('access-control-allow-origin')).toBeNull();
  });

  it('rejects other methods', async () => {
    const res = await handleHealth(req({ method: 'DELETE', token: 'good-token' }), {
      env: env(),
      verifyToken: verify,
    });
    expect(res.status).toBe(405);
  });
});

describe('shared helpers', () => {
  it('allows only configured origins when ALLOWED_ORIGINS is set', () => {
    expect(allowedOrigin(EXT, env())).toBe(EXT);
    expect(allowedOrigin('chrome-extension://not-an-id', env())).toBeNull();
    expect(
      allowedOrigin(
        EXT,
        env({ ALLOWED_ORIGINS: 'chrome-extension://pppppppppppppppppppppppppppppppp' }),
      ),
    ).toBeNull();
    expect(
      allowedOrigin('https://filler.app', env({ ALLOWED_ORIGINS: 'https://filler.app' })),
    ).toBe('https://filler.app');
    expect(allowedOrigin(null, env())).toBeNull();
  });

  it('lets server-to-server calls (no Origin header) through the gate', () => {
    expect(gate(req({ origin: null }), env(), ['GET'])).toEqual({ origin: null });
  });

  it('reads per-endpoint limits from env with safe defaults', () => {
    expect(limitsFor('ai-generate', env())).toEqual({ maxCalls: 60, maxTokens: 200_000 });
    expect(
      limitsFor(
        'ai-generate',
        env({ LIMIT_AI_GENERATE_CALLS: '5', LIMIT_AI_GENERATE_TOKENS: '1000' }),
      ),
    ).toEqual({ maxCalls: 5, maxTokens: 1000 });
    expect(limitsFor('ai-generate', env({ LIMIT_AI_GENERATE_CALLS: '-3' })).maxCalls).toBe(60);
  });
});

describe('shared core copy', () => {
  it('is in sync with packages/core (run pnpm sync:shared if this fails)', () => {
    expect(() =>
      execFileSync('node', ['../scripts/sync-shared.mjs', '--check'], {
        cwd: new URL('..', import.meta.url),
        stdio: 'pipe',
      }),
    ).not.toThrow();
  });

  it('loads in the function runtime and enforces the same policy', () => {
    expect(sharedCore.classifyRisk({ inputType: 'text', label: 'Aadhaar number' })).toMatchObject({
      allowed: false,
      category: 'aadhaar',
    });
    expect(sharedCore.isValidFactKey('contact.email')).toBe(true);
  });
});
