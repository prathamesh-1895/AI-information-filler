import { describe, expect, it } from 'vitest';
import type { FieldDescriptor, HistoryEntry, PlanItem } from '../schema/records';
import { historyItems, reusableValues, sessionSummary } from './history';
import { initialState, reduce, type SessionState } from './session';

const at = '2026-10-01T00:00:00.000Z';
const field = (id: string, label: string, sig: string): FieldDescriptor => ({
  id,
  frameId: 0,
  selector: `#${id}`,
  tag: 'input',
  inputType: 'text',
  label,
  labelSource: 'label-for',
  required: false,
  isVisible: true,
  isDisabled: false,
  signature: sig.repeat(64),
});

function state(plan: PlanItem[]): SessionState {
  let s = reduce(initialState(), { type: 'START', id: 's2', tabId: 1, at }).state;
  s = reduce(s, {
    type: 'SCANNED',
    url: 'https://x.com/form',
    title: 'Form',
    fields: [
      field('a', 'Message', 'a'),
      field('b', 'City', 'b'),
      field('c', 'Card number', 'c'),
      field('d', 'Team', 'd'),
    ],
    at,
  }).state;
  s = reduce(s, { type: 'MAPPED', mappings: {} }).state;
  return reduce(s, { type: 'PLANNED', items: plan }).state;
}

const last: HistoryEntry = {
  id: 's1',
  site: 'x.com',
  url: 'https://x.com/form',
  title: 'Form',
  startedAt: at,
  endedAt: at,
  items: [
    { label: 'Message', signature: 'a'.repeat(64), value: 'Call me', status: 'filled' },
    { label: 'team', signature: 'f'.repeat(64), value: 'Owls', status: 'filled' },
    { label: 'Card number', signature: 'c'.repeat(64), status: 'never' },
  ],
};

describe('session history (Task 11.4)', () => {
  const pending = (fieldId: string, kind: PlanItem['kind'] = 'fact'): PlanItem => ({
    fieldId,
    kind,
    confidence: 0,
    status: kind === 'denied' ? 'skipped' : 'pending',
    reason: '',
    ...(kind === 'denied' ? {} : { question: 'q' }),
  });

  it('records outcomes per field, values only for filled ones', () => {
    const s = state([
      {
        fieldId: 'a',
        kind: 'open_ended',
        confidence: 1,
        status: 'filled',
        reason: '',
        value: 'Hi',
        source: 'user',
      },
      {
        fieldId: 'b',
        kind: 'fact',
        confidence: 1,
        status: 'approved',
        reason: '',
        value: 'Pune',
        canonicalKey: 'address.city',
      },
      pending('c', 'denied'),
    ]);
    expect(historyItems(s)).toEqual([
      {
        label: 'Message',
        signature: 'a'.repeat(64),
        value: 'Hi',
        status: 'filled',
        source: 'user',
      },
      { label: 'City', signature: 'b'.repeat(64), key: 'address.city', status: 'not_filled' },
      { label: 'Card number', signature: 'c'.repeat(64), status: 'never' },
    ]);
  });

  it('re-uses last answers by signature or label, never for denied or answered fields', () => {
    const s = state([
      pending('a'),
      { ...pending('b'), value: 'Pune', status: 'pending' },
      pending('c', 'denied'),
      pending('d'),
    ]);
    expect(reusableValues(s, last)).toEqual({ a: 'Call me', d: 'Owls' });
    const reused = reduce(s, {
      type: 'REUSE',
      values: { a: 'Call me', c: '4111' },
      from: '1 Oct',
    }).state;
    expect(reused.plan.find((p) => p.fieldId === 'a')).toMatchObject({
      value: 'Call me',
      source: 'memory',
      status: 'pending',
      reason: 'From your last session here (1 Oct)',
    });
    expect(reused.plan.find((p) => p.fieldId === 'c')).not.toHaveProperty('value');
  });

  it('summarises a session with the caller choosing how values show', () => {
    const s = state([
      {
        fieldId: 'a',
        kind: 'open_ended',
        confidence: 1,
        status: 'filled',
        reason: '',
        value: 'Hi',
      },
      pending('b'),
      pending('c', 'denied'),
    ]);
    expect(sessionSummary(s, (p) => `<${String(p.value)}>`)).toBe(
      [
        'Form',
        'https://x.com/form',
        '',
        'Filled:',
        '- Message: <Hi>',
        '',
        'Still to answer:',
        '- City',
        '',
        'Never filled by Filler:',
        '- Card number',
      ].join('\n'),
    );
  });
});
