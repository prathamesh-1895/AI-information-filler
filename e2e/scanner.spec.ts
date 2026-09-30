import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { Frame } from '@playwright/test';
import { normaliseLabel, type FieldDescriptor } from '@filler/core';
import { expect, test } from './fixtures';

/**
 * Scanner accuracy against the fixture library (PLAYBOOK Tasks 3.2–3.4).
 * The built page agent is injected straight into each frame, so this tests
 * the scanner itself; panel.spec.ts covers the extension messaging path.
 */

interface ExpectedField {
  ref: string;
  frame?: string;
  label: string;
  inputType: string;
  labelSource?: string;
  required?: boolean;
  isDisabled?: boolean;
  maxLength?: number;
  pattern?: string;
  min?: string;
  max?: string;
  options?: string[];
  helpText?: string;
  sectionHeading?: string;
  currentValue?: string | string[];
}

interface Expected {
  fixture: string;
  fields: ExpectedField[];
  notDiscovered?: string[];
}

const FIXTURES = [
  'simple-contact',
  'google-form-like',
  'upwork-profile-like',
  'fiverr-seller-like',
  'react-controlled',
  'tricky',
  'job-application-like',
];

const agentPath = fileURLToPath(
  new URL('../apps/extension/.output-e2e/chrome-mv3/page-agent.js', import.meta.url),
);
const loadExpected = (name: string): Expected =>
  JSON.parse(
    readFileSync(new URL(`../test-fixtures/${name}.expected.json`, import.meta.url), 'utf8'),
  );

interface ScannedField extends FieldDescriptor {
  ref: string | null;
  frameFile: string;
}

async function scanFrame(frame: Frame): Promise<{ fields: ScannedField[]; errors: string[] }> {
  await frame.addScriptTag({ path: agentPath });
  const frameFile = new URL(frame.url()).pathname.split('/').pop() ?? '';
  const result = await frame.evaluate(async () => {
    const agent = globalThis.__fillerPageAgent!;
    const scanned = await agent.scan();
    const fields = [];
    for (const field of scanned.fields) {
      const el = await agent.resolve(field);
      fields.push({ ...field, ref: el?.getAttribute('data-fx') ?? null });
    }
    return { fields, errors: scanned.errors };
  });
  return { fields: result.fields.map((f) => ({ ...f, frameFile })), errors: result.errors };
}

async function scanPage(page: import('@playwright/test').Page, name: string) {
  await page.goto(`/${name}.html`);
  await page.waitForLoadState('load');
  const all: ScannedField[] = [];
  const errors: string[] = [];
  for (const frame of page.frames()) {
    if (!frame.url().startsWith('http')) continue;
    const r = await scanFrame(frame);
    all.push(...r.fields);
    errors.push(...r.errors);
  }
  return { fields: all, errors };
}

const labelStats = { total: 0, correct: 0, mismatches: [] as string[] };

for (const name of FIXTURES) {
  test(`scanner: ${name}`, async ({ context }) => {
    const expected = loadExpected(name);
    const page = await context.newPage();
    const { fields, errors } = await scanPage(page, name);
    expect(errors, 'descriptor validation errors').toEqual([]);

    // Discovered set equals the expected set, exactly.
    const refs = fields.map((f) => f.ref);
    expect(refs, 'every scanned field resolves to a tagged element').not.toContain(null);
    expect([...refs].sort()).toEqual(expected.fields.map((f) => f.ref).sort());
    for (const hidden of expected.notDiscovered ?? []) expect(refs).not.toContain(hidden);

    for (const want of expected.fields) {
      const got = fields.find((f) => f.ref === want.ref)!;
      const where = `${name} → ${want.ref}`;
      labelStats.total++;
      if (normaliseLabel(got.label) === normaliseLabel(want.label)) labelStats.correct++;
      else
        labelStats.mismatches.push(
          `${where}: got "${got.label}" (${got.labelSource}), want "${want.label}"`,
        );

      expect(got.inputType, `${where} inputType`).toBe(want.inputType);
      expect(got.required, `${where} required`).toBe(want.required ?? false);
      expect(got.isDisabled, `${where} isDisabled`).toBe(want.isDisabled ?? false);
      expect(got.signature, `${where} signature`).toMatch(/^[0-9a-f]{64}$/);
      if (want.frame) expect(got.frameFile, `${where} frame`).toBe(want.frame);
      if (want.labelSource) expect(got.labelSource, `${where} labelSource`).toBe(want.labelSource);
      if (want.maxLength !== undefined)
        expect(got.maxLength, `${where} maxLength`).toBe(want.maxLength);
      if (want.pattern !== undefined) expect(got.pattern, `${where} pattern`).toBe(want.pattern);
      if (want.min !== undefined) expect(got.min, `${where} min`).toBe(want.min);
      if (want.max !== undefined) expect(got.max, `${where} max`).toBe(want.max);
      if (want.options)
        expect(
          got.options?.map((o) => o.text),
          `${where} options`,
        ).toEqual(want.options);
      if (want.helpText) expect(got.helpText ?? '', `${where} helpText`).toContain(want.helpText);
      if (want.sectionHeading)
        expect(got.sectionHeading, `${where} sectionHeading`).toBe(want.sectionHeading);
      if (want.currentValue !== undefined)
        expect(got.currentValue, `${where} currentValue`).toEqual(want.currentValue);
    }
    // Password values are never read, even when present.
    for (const f of fields.filter((x) => x.inputType === 'password'))
      expect(f.currentValue).toBeUndefined();
  });
}

test.afterAll(() => {
  if (labelStats.mismatches.length)
    console.log(`Label mismatches:\n  ${labelStats.mismatches.join('\n  ')}`);
  console.log(`Label accuracy: ${labelStats.correct}/${labelStats.total}`);
  expect(labelStats.correct / Math.max(labelStats.total, 1)).toBeGreaterThanOrEqual(0.95);
});

test('scanner: signatures are stable across reloads', async ({ context }) => {
  const page = await context.newPage();
  const first = await scanPage(page, 'react-controlled');
  const second = await scanPage(page, 'react-controlled');
  expect(second.fields.map((f) => f.signature)).toEqual(first.fields.map((f) => f.signature));
});

test('scanner: re-finds every field after a React-style re-render with new ids', async ({
  context,
}) => {
  const page = await context.newPage();
  await page.goto('/react-controlled.html');
  await page.addScriptTag({ path: agentPath });
  const result = await page.evaluate(async () => {
    const agent = globalThis.__fillerPageAgent!;
    const { fields } = await agent.scan();
    const before = await Promise.all(fields.map((f) => agent.resolve(f)));
    const idsBefore = before.map((el) => el?.id);
    (window as unknown as { __rerender: () => void }).__rerender();
    const after = await Promise.all(fields.map((f) => agent.resolve(f)));
    return {
      connected: after.map((el) => el?.isConnected ?? false),
      refs: after.map((el) => el?.getAttribute('data-fx') ?? null),
      idsChanged: after.every((el, i) => el?.id !== idsBefore[i] || el?.id === ''),
    };
  });
  expect(result.connected.every(Boolean)).toBe(true);
  expect(result.refs).toEqual(['first', 'last', 'email', 'country', 'newsletter']);
  expect(result.idsChanged).toBe(true);
});

test('scanner: fields revealed later (wizard step 2) are found on rescan', async ({ context }) => {
  const page = await context.newPage();
  await page.goto('/upwork-profile-like.html');
  await page.addScriptTag({ path: agentPath });
  await page.getByRole('button', { name: 'Next' }).click();
  const refs = await page.evaluate(async () => {
    const agent = globalThis.__fillerPageAgent!;
    const { fields } = await agent.scan();
    return Promise.all(fields.map(async (f) => (await agent.resolve(f))?.getAttribute('data-fx')));
  });
  expect(refs).toEqual(['street', 'city', 'zip', 'phone2']);
});
