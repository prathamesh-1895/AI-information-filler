import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { FieldDescriptor } from '../schema/records';
import { mapFields } from './map';

/**
 * Mapping accuracy on real scanner output (test-fixtures/__scans__, written by
 * e2e/scan-snapshots.spec.ts) against each fixture's expected kind + key.
 * PLAYBOOK Task 5.2 target: ≥ 85% with no AI, and no denied field mapped.
 */

interface Expected {
  ref: string;
  kind: string;
  canonicalKey: string | null;
}

const fixtureDir = new URL('../../../../test-fixtures/', import.meta.url);
const read = <T>(path: string): T =>
  JSON.parse(readFileSync(new URL(path, fixtureDir), 'utf8')) as T;

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
  ].map((n) => ({
    scan: n,
    expected: () => read<{ fields: Expected[] }>(`${n}.expected.json`).fields,
  })),
  {
    scan: 'upwork-profile-like.step2',
    expected: () =>
      read<{ laterSteps: Record<string, Expected[]> }>('upwork-profile-like.expected.json')
        .laterSteps['2']!,
  },
  {
    scan: 'upwork-profile-like.modal',
    expected: () =>
      read<{ laterSteps: Record<string, Expected[]> }>('upwork-profile-like.expected.json')
        .laterSteps.modal!,
  },
];

const rows: Array<{ where: string; ok: boolean; got: string; want: string }> = [];

for (const c of CASES) {
  it(`maps ${c.scan}`, () => {
    const scanned = read<Array<FieldDescriptor & { ref: string }>>(`__scans__/${c.scan}.json`).map(
      (f, i) => ({ ...f, id: `f${i}` }),
    );
    const results = mapFields(scanned, { site: '127.0.0.1' });
    for (const want of c.expected()) {
      const field = scanned.find((f) => f.ref === want.ref);
      expect(field, `${c.scan}: ${want.ref} scanned`).toBeDefined();
      const got = results.get(field!.id)!;
      if (want.kind === 'denied')
        expect(got.kind, `${c.scan}: ${want.ref} must be denied`).toBe('denied');
      if (got.kind === 'denied') expect(got.canonicalKey).toBeUndefined();
      const ok = got.kind === want.kind && (got.canonicalKey ?? null) === want.canonicalKey;
      rows.push({
        where: `${c.scan} → ${want.ref} ("${field!.label}")`,
        ok,
        got: `${got.kind} ${got.canonicalKey ?? '∅'} (${got.source})`,
        want: `${want.kind} ${want.canonicalKey ?? '∅'}`,
      });
    }
  });
}

describe('accuracy', () => {
  it('meets the Phase 5 target (≥ 85% kind + key, no AI)', () => {
    const correct = rows.filter((r) => r.ok).length;
    const misses = rows
      .filter((r) => !r.ok)
      .map((r) => `  ${r.where}: got ${r.got}, want ${r.want}`);
    console.log(
      `Mapping accuracy: ${correct}/${rows.length} (${((100 * correct) / rows.length).toFixed(1)}%)${misses.length ? `\n${misses.join('\n')}` : ''}`,
    );
    expect(rows.length).toBeGreaterThan(80);
    expect(correct / rows.length).toBeGreaterThanOrEqual(0.85);
  });
});
