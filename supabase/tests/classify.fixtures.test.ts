import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  ClassifyResponseSchema,
  fromClassified,
  isRegistryKey,
  mapFields,
  toAiField,
  type FieldDescriptor,
  type MapResult,
} from '../functions/_shared/core/index.ts';
import { createGateway } from '../functions/_shared/ai/gateway.ts';
import { handleClassify } from '../functions/ai-classify/handler.ts';
import { fakeProviderFetch } from './fake-llm.ts';

/**
 * PLAYBOOK Task 8.3 DONE: rules + classify on every fixture reach ≥ 95%
 * correct kind and ≥ 90% correct key. The model is the scripted fake
 * (test-fixtures/__ai__/classify-answers.json) behind the real function,
 * envelope, guard and client conversion. Custom (`custom.*`) keys are the
 * user's own names, so only registry keys are scored.
 */

interface Expected {
  ref: string;
  kind: string;
  canonicalKey: string | null;
}

const dir = new URL('../../test-fixtures/', import.meta.url);
const read = <T>(path: string): T => JSON.parse(readFileSync(new URL(path, dir), 'utf8')) as T;
const later = (name: string, step: string) => () =>
  read<{ laterSteps: Record<string, Expected[]> }>(`${name}.expected.json`).laterSteps[step]!;

const CASES: Array<{ scan: string; expected: () => Expected[] }> = [
  ...[
    'simple-contact',
    'google-form-like',
    'upwork-profile-like',
    'fiverr-seller-like',
    'react-controlled',
    'tricky',
    'job-application-like',
    'fill-lab',
    'ai-understanding',
  ].map((n) => ({
    scan: n,
    expected: () => read<{ fields: Expected[] }>(`${n}.expected.json`).fields,
  })),
  { scan: 'upwork-profile-like.step2', expected: later('upwork-profile-like', '2') },
  { scan: 'upwork-profile-like.modal', expected: later('upwork-profile-like', 'modal') },
];

const env = {
  get: (n: string) =>
    ({ AI_PROVIDER: 'gemini', GEMINI_API_KEY: 'test', AI_MODEL_FAST: 'fast' })[n] as
      string | undefined,
};

async function classify(fields: FieldDescriptor[]): Promise<Map<string, MapResult>> {
  const out = new Map<string, MapResult>();
  if (!fields.length) return out;
  const res = await handleClassify(
    new Request('https://x/functions/v1/ai-classify', {
      method: 'POST',
      headers: { authorization: 'Bearer t', 'content-type': 'application/json' },
      body: JSON.stringify({ fields: fields.map(toAiField), page: { host: '127.0.0.1' } }),
    }),
    {
      env,
      verifyToken: async () => ({ id: 'u' }),
      gateway: createGateway({ env, fetch: fakeProviderFetch().fetch }),
      consumeQuota: async () => 'ok',
      recordTokens: async () => undefined,
    },
  );
  const body = ClassifyResponseSchema.parse(await res.json());
  for (const item of body.results) {
    const field = fields.find((f) => f.id === item.id)!;
    const mapped = fromClassified(field, item);
    if (mapped) out.set(field.id, mapped);
  }
  return out;
}

const rows: Array<{
  where: string;
  kindOk: boolean;
  keyOk: boolean;
  got: string;
  want: string;
  viaAi: boolean;
}> = [];
const scored = (key: string | undefined) =>
  key && isRegistryKey(key.replace(/\[\d+\]/, '[]')) ? key : null;

for (const c of CASES) {
  it(`rules + classify: ${c.scan}`, async () => {
    const fields = read<Array<FieldDescriptor & { ref: string }>>(`__scans__/${c.scan}.json`).map(
      (f, i) => ({
        ...f,
        id: `0:f${i}`,
      }),
    );
    const results = mapFields(fields, { site: '127.0.0.1' });
    const byAi = await classify(fields.filter((f) => results.get(f.id)?.source === 'none'));
    for (const [id, m] of byAi) results.set(id, m);
    for (const want of c.expected()) {
      const field = fields.find((f) => f.ref === want.ref)!;
      expect(field, `${c.scan}: ${want.ref}`).toBeDefined();
      const got = results.get(field.id)!;
      if (want.kind === 'denied') expect(got.kind).toBe('denied');
      rows.push({
        where: `${c.scan} → ${want.ref} ("${field.label}")`,
        kindOk: got.kind === want.kind,
        keyOk: scored(got.canonicalKey) === want.canonicalKey,
        got: `${got.kind} ${got.canonicalKey ?? '∅'} (${got.source})`,
        want: `${want.kind} ${want.canonicalKey ?? '∅'}`,
        viaAi: got.source === 'ai',
      });
    }
  });
}

describe('accuracy', () => {
  it('meets the Phase 8 target (≥ 95% kind, ≥ 90% key)', () => {
    const kinds = rows.filter((r) => r.kindOk).length;
    const keys = rows.filter((r) => r.keyOk).length;
    const ai = rows.filter((r) => r.viaAi).length;
    const misses = rows
      .filter((r) => !r.kindOk || !r.keyOk)
      .map((r) => `  ${r.where}: got ${r.got}, want ${r.want}`);
    console.log(
      `Rules + classify on ${rows.length} fields (${ai} answered by the AI): kind ${kinds}/${rows.length} (${((100 * kinds) / rows.length).toFixed(1)}%), key ${keys}/${rows.length} (${((100 * keys) / rows.length).toFixed(1)}%)${misses.length ? `\n${misses.join('\n')}` : ''}`,
    );
    expect(ai).toBeGreaterThanOrEqual(20);
    expect(kinds / rows.length).toBeGreaterThanOrEqual(0.95);
    expect(keys / rows.length).toBeGreaterThanOrEqual(0.9);
  });
});
