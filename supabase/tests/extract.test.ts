import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { ExtractResponseSchema, withoutContacts } from '../functions/_shared/core/index.ts';
import { createGateway } from '../functions/_shared/ai/gateway.ts';
import { EXTRACT_SYSTEM } from '../functions/_shared/ai/extract.ts';
import { handleExtract, type ExtractLog } from '../functions/ai-extract/handler.ts';
import { fakeProviderFetch, type FakeProviderOptions } from './fake-llm.ts';

const EXT = 'chrome-extension://abcdefghijklmnopabcdefghijklmnop';
const ENV = { AI_PROVIDER: 'gemini', GEMINI_API_KEY: 'k', AI_MODEL_SMART: 'smart' };
const resume = (n: string) =>
  readFileSync(new URL(`../../test-fixtures/resumes/${n}.txt`, import.meta.url), 'utf8');

function setup(o: { fake?: FakeProviderOptions; logs?: ExtractLog[] } = {}) {
  const fake = fakeProviderFetch(o.fake ?? {});
  const env = { get: (n: string) => (ENV as Record<string, string>)[n] };
  const call = async (body: unknown) => {
    const res = await handleExtract(
      new Request('https://x/functions/v1/ai-extract', {
        method: 'POST',
        headers: { origin: EXT, authorization: 'Bearer good', 'content-type': 'application/json' },
        body: JSON.stringify(body),
      }),
      {
        env,
        verifyToken: async () => ({ id: 'u1' }),
        gateway: createGateway({ env, fetch: fake.fetch, sleep: async () => undefined }),
        consumeQuota: async () => 'ok',
        recordTokens: async () => undefined,
        log: (l) => o.logs?.push(l),
      },
    );
    return { status: res.status, body: (await res.json()) as Record<string, unknown> };
  };
  return { fake, call };
}

describe('ai-extract function (Task 11.1)', () => {
  it('returns checked details from text that had its contacts removed', async () => {
    const logs: ExtractLog[] = [];
    const { fake, call } = setup({ logs });
    const r = ExtractResponseSchema.parse(
      (await call({ text: withoutContacts(resume('asha-verma')) })).body,
    );
    const keys = r.facts.map((f) => f.key);
    expect(keys).toEqual(
      expect.arrayContaining(['experience[0].company', 'education[1].institution', 'skills']),
    );
    expect(keys.some((k) => k.startsWith('contact.'))).toBe(false);
    expect(fake.calls[0]!.url).toContain('/models/smart:generateContent');
    for (const leak of ['asha.verma@example.com', '98220'])
      expect(fake.calls[0]!.prompt).not.toContain(leak);
    expect(EXTRACT_SYSTEM).toContain('Never guess');
    expect(logs[0]).toMatchObject({ endpoint: 'ai-extract', outcome: 'ok' });
    expect(JSON.stringify(logs)).not.toMatch(/Sahyadri|Asha/);
  });

  it('drops anything not in the text', async () => {
    const r = ExtractResponseSchema.parse(
      (await setup({ fake: { mode: 'inventing' } }).call({ text: resume('rahul-iyer') })).body,
    );
    expect(r.facts.some((f) => f.value === 'Google')).toBe(false);
    expect(r.rejected).toBeGreaterThanOrEqual(1);
  });

  it('refuses tiny or huge texts', async () => {
    const { call } = setup();
    expect((await call({ text: 'short' })).status).toBe(400);
    expect((await call({ text: 'x'.repeat(30_001) })).status).toBe(400);
  });
});
