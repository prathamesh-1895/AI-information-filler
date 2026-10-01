import { describe, expect, it } from 'vitest';
import type { MapResult } from '../mapper/map';
import type { Fact, FactValue, FieldDescriptor } from '../schema/records';
import { offlineAi, type AiSeam } from './ai';
import { buildPlan, planField, type PlanDeps } from './plan';

const field = (label: string, over: Partial<FieldDescriptor> = {}): FieldDescriptor => ({
  id: `f-${label}`,
  frameId: 0,
  selector: '#x',
  tag: 'input',
  inputType: 'text',
  label,
  labelSource: 'label-for',
  required: false,
  isVisible: true,
  isDisabled: false,
  signature: 'a'.repeat(64),
  ...over,
});
const m = (over: Partial<MapResult>): MapResult => ({
  kind: 'fact',
  confidence: 0.9,
  reason: 'Looks like it',
  source: 'dictionary',
  ...over,
});
const lookup =
  (facts: Record<string, FactValue>) =>
  (key: string): Fact | undefined =>
    key in facts
      ? {
          key,
          value: facts[key]!,
          sensitivity: 'public',
          source: 'user',
          updatedAt: '2026-10-01T00:00:00.000Z',
        }
      : undefined;
const deps = (facts: Record<string, FactValue>, ai: AiSeam = offlineAi): PlanDeps => ({
  lookup: lookup(facts),
  ai,
  aiContext: { site: 'x.com', filled: {} },
});

describe('planField', () => {
  it('uses vault values (source vault or memory) and waits for approval', async () => {
    expect(
      await planField(
        field('City'),
        m({ canonicalKey: 'address.city' }),
        deps({ 'address.city': 'Pune' }),
      ),
    ).toMatchObject({
      value: 'Pune',
      source: 'vault',
      status: 'pending',
      reason: 'From your vault: City',
    });
    expect(
      await planField(
        field('City'),
        m({ canonicalKey: 'address.city', source: 'memory' }),
        deps({ 'address.city': 'Pune' }),
      ),
    ).toMatchObject({ source: 'memory' });
  });

  it('asks once when the vault lacks the fact', async () => {
    const item = await planField(field('GitHub'), m({ canonicalKey: 'links.github' }), deps({}));
    expect(item).toMatchObject({
      status: 'pending',
      question: 'What should I put for “GitHub”?',
      reason: 'Your vault has no github yet.',
    });
    expect(item.value).toBeUndefined();
  });

  it('skips denied and skip fields with their reasons', async () => {
    expect(
      await planField(field('Password'), m({ kind: 'denied', reason: 'Never' }), deps({})),
    ).toMatchObject({ status: 'skipped', kind: 'denied', reason: 'Never' });
    expect(
      await planField(field('CV'), m({ kind: 'skip', reason: 'Attach it yourself' }), deps({})),
    ).toMatchObject({ status: 'skipped' });
  });

  it('uses a saved overview as a draft, else asks (offline) or takes the AI draft', async () => {
    const overview = field('Profile overview', { inputType: 'textarea' });
    const mapping = m({ kind: 'open_ended', canonicalKey: 'bio.summary_long' });
    expect(
      await planField(overview, mapping, deps({ 'bio.summary_long': 'I help SMBs.' })),
    ).toMatchObject({ value: 'I help SMBs.', source: 'vault' });
    expect(await planField(overview, mapping, deps({}))).toMatchObject({
      question: expect.any(String),
      reason: expect.stringContaining('Offline'),
    });
    const fakeAi: AiSeam = {
      ...offlineAi,
      mode: 'ai',
      generateAnswer: async () => ({ value: 'Drafted', reason: 'AI draft' }),
    };
    expect(await planField(overview, mapping, deps({}, fakeAi))).toMatchObject({
      value: 'Drafted',
      source: 'ai',
      status: 'pending',
    });
  });

  it('leaves fields the page already answered when Filler has nothing to add', async () => {
    expect(
      await planField(
        field('Team', { currentValue: 'Rocket' }),
        m({ source: 'none', confidence: 0 }),
        deps({}),
      ),
    ).toMatchObject({
      status: 'skipped',
      reason: 'Already answered on the page.',
    });
  });
});

describe('buildPlan', () => {
  it('plans fields in page order and ignores fields without a mapping', async () => {
    const a = field('City', { id: 'a' });
    const b = field('Unknown', { id: 'b' });
    const c = field('Not mapped yet', { id: 'c' });
    const plan = await buildPlan(
      [a, b, c],
      new Map([
        ['a', m({ canonicalKey: 'address.city' })],
        ['b', m({ source: 'none' })],
      ]),
      deps({ 'address.city': 'Pune' }),
    );
    expect(plan.map((p) => [p.fieldId, p.value ?? p.question])).toEqual([
      ['a', 'Pune'],
      ['b', 'What should I put for “Unknown”?'],
    ]);
  });
});
