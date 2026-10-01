import { describe, expect, it } from 'vitest';
import type { MapResult } from '../mapper/map';
import type { FieldDescriptor, PlanItem } from '../schema/records';
import {
  initialState,
  reduce,
  UserEventSchema,
  type Effect,
  type SessionEvent,
  type SessionState,
} from './session';

const at = '2026-10-01T10:00:00.000Z';
const field = (
  id: string,
  label: string,
  over: Partial<FieldDescriptor> = {},
): FieldDescriptor => ({
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
  signature: id.padEnd(64, '0').replace(/[^0-9a-f]/g, 'a'),
  ...over,
});
const fields = [
  field('0:f0', 'Full name'),
  field('0:f1', 'Date of birth'),
  field('0:f2', 'Password', { inputType: 'password' }),
];

const mapping = (over: Partial<MapResult>): MapResult => ({
  kind: 'fact',
  confidence: 0.9,
  reason: 'r',
  source: 'dictionary',
  ...over,
});
const plan: PlanItem[] = [
  {
    fieldId: '0:f0',
    kind: 'fact',
    canonicalKey: 'person.name.full',
    value: 'Priya Sharma',
    source: 'vault',
    confidence: 0.9,
    status: 'pending',
    reason: 'From your vault',
  },
  {
    fieldId: '0:f1',
    kind: 'fact',
    canonicalKey: 'person.dob',
    confidence: 0,
    status: 'pending',
    reason: 'Not in vault',
    question: 'What should I put for “Date of birth”?',
  },
  {
    fieldId: '0:f2',
    kind: 'denied',
    confidence: 1,
    status: 'skipped',
    reason: 'Passwords are never filled',
  },
];

function run(events: SessionEvent[], from: SessionState = initialState()) {
  let state = from;
  const effects: Effect[][] = [];
  for (const e of events) {
    const t = reduce(state, e);
    state = t.state;
    effects.push(t.effects);
  }
  return { state, effects, last: effects.at(-1) ?? [] };
}

const toReview = (): SessionEvent[] => [
  { type: 'START', id: 's1', tabId: 7, at },
  { type: 'SCANNED', url: 'https://www.example.com/apply', title: 'Apply', fields, at },
  {
    type: 'MAPPED',
    mappings: {
      '0:f0': mapping({ canonicalKey: 'person.name.full' }),
      '0:f1': mapping({ canonicalKey: 'person.dob' }),
      '0:f2': mapping({ kind: 'denied' }),
    },
  },
  { type: 'PLANNED', items: plan },
];

describe('happy path', () => {
  it('START → SCANNING with a SCAN effect', () => {
    const { state, last } = run([{ type: 'START', id: 's1', tabId: 7, at }]);
    expect(state.phase).toBe('SCANNING');
    expect(last).toEqual([{ type: 'SCAN' }]);
  });

  it('SCANNED → MAPPING → PLANNING → AWAITING_REVIEW with the right effects', () => {
    const { state, effects } = run(toReview());
    expect(effects[1]).toEqual([{ type: 'MAP', fieldIds: ['0:f0', '0:f1', '0:f2'] }]);
    expect(effects[2]).toEqual([{ type: 'PLAN', fieldIds: ['0:f0', '0:f1', '0:f2'] }]);
    expect(state.phase).toBe('AWAITING_REVIEW');
    expect(state.site).toBe('example.com');
    expect(state.pages).toHaveLength(1);
    expect(effects[3]![0]).toEqual({
      type: 'HIGHLIGHT',
      items: [
        { fieldId: '0:f0', state: 'vault', title: 'Full name' },
        { fieldId: '0:f1', state: 'input', title: 'Date of birth' },
        { fieldId: '0:f2', state: 'denied', title: 'Password' },
      ],
    });
  });

  it('answer (saved) → approve vault → fill → verify → READY_TO_SUBMIT', () => {
    const r = run([
      ...toReview(),
      { type: 'ANSWER', fieldId: '0:f1', value: '14/05/2003', save: true },
      { type: 'APPROVE_ALL_VAULT' },
      { type: 'FILL' },
    ]);
    expect(r.effects[4]![0]).toMatchObject({
      type: 'SAVE_ANSWER',
      key: 'person.dob',
      value: '14/05/2003',
      site: 'example.com',
      signature: fields[1]!.signature,
    });
    expect(r.state.phase).toBe('FILLING');
    expect(r.last).toEqual([
      {
        type: 'FILL',
        items: [
          {
            fieldId: '0:f0',
            selector: '#0:f0',
            signature: fields[0]!.signature,
            value: 'Priya Sharma',
          },
          {
            fieldId: '0:f1',
            selector: '#0:f1',
            signature: fields[1]!.signature,
            value: '14/05/2003',
          },
        ],
      },
    ]);
    const done = run(
      [
        {
          type: 'FILL_RESULTS',
          results: [
            { fieldId: '0:f0', status: 'filled' },
            { fieldId: '0:f1', status: 'filled' },
          ],
        },
      ],
      r.state,
    );
    expect(done.state.phase).toBe('READY_TO_SUBMIT');
    expect(done.state.used).toEqual({
      'person.name.full': 'Priya Sharma',
      'person.dob': '14/05/2003',
    });
  });

  it('a one-off answer is used but not saved; unknown labels get custom keys', () => {
    const extra = field('0:f3', 'Team name');
    const r = run([
      ...toReview(),
      {
        type: 'FIELDS_CHANGED',
        url: 'https://www.example.com/apply',
        added: [extra],
        removed: [],
        at,
      },
      { type: 'MAPPED', mappings: { '0:f3': mapping({ source: 'none' }) } },
      {
        type: 'PLANNED',
        items: [
          {
            fieldId: '0:f3',
            kind: 'fact',
            confidence: 0,
            status: 'pending',
            reason: 'unknown',
            question: 'q',
          },
        ],
      },
      { type: 'ANSWER', fieldId: '0:f3', value: 'Rocket', save: true },
    ]);
    expect(r.last[0]).toMatchObject({ type: 'SAVE_ANSWER', key: 'custom.team_name' });
    const once = run(
      [{ type: 'ANSWER', fieldId: '0:f1', value: '2003-05-14', save: false }],
      r.state,
    );
    expect(once.last.some((e) => e.type === 'SAVE_ANSWER')).toBe(false);
    expect(once.state.plan.find((p) => p.fieldId === '0:f1')).toMatchObject({
      status: 'approved',
      source: 'user',
      reason: expect.stringContaining('not saved'),
    });
  });

  it('a failed fill keeps the page in review with the reason', () => {
    const r = run([
      ...toReview(),
      { type: 'APPROVE', fieldIds: ['0:f0'] },
      { type: 'FILL' },
      {
        type: 'FILL_RESULTS',
        results: [{ fieldId: '0:f0', status: 'failed', error: 'Option not found' }],
      },
    ]);
    expect(r.state.plan[0]).toMatchObject({ status: 'failed', reason: 'Option not found' });
    expect(r.state.phase).toBe('AWAITING_REVIEW'); // the date question is still open
  });
});

describe('safety and guards', () => {
  it('never fills denied or unapproved items', () => {
    const r = run([...toReview(), { type: 'FILL' }]);
    expect(r.last).toEqual([]); // nothing approved yet
    const tried = run(
      [
        { type: 'ANSWER', fieldId: '0:f2', value: 'hunter2', save: true },
        { type: 'EDIT', fieldId: '0:f2', value: 'x' },
      ],
      r.state,
    );
    expect(tried.effects.flat()).toEqual([]);
    expect(tried.state.plan[2]).toMatchObject({ kind: 'denied', status: 'skipped' });
  });

  it('only fills the requested fields when asked to', () => {
    const r = run([
      ...toReview(),
      { type: 'ANSWER', fieldId: '0:f1', value: 'x', save: false },
      { type: 'APPROVE_ALL_VAULT' },
      { type: 'FILL', fieldIds: ['0:f1'] },
    ]);
    expect(r.last[0]).toMatchObject({ type: 'FILL', items: [{ fieldId: '0:f1' }] });
  });

  it('a rejected answer goes back to a question', () => {
    const r = run([
      ...toReview(),
      { type: 'ANSWER', fieldId: '0:f1', value: '4111 1111 1111 1111', save: true },
      { type: 'ANSWER_REJECTED', fieldId: '0:f1', reason: 'This looks like a card number.' },
    ]);
    expect(r.state.plan[1]).toMatchObject({
      status: 'pending',
      reason: 'This looks like a card number.',
      question: expect.any(String),
    });
    expect(r.state.plan[1]!.value).toBeUndefined();
  });

  it('ignores events after the session ended', () => {
    const r = run([...toReview(), { type: 'END' }]);
    expect(r.state.phase).toBe('ENDED');
    expect(r.last).toEqual([{ type: 'END_PAGE' }]);
    const after = run(
      [{ type: 'FILL' }, { type: 'SCANNED', url: 'x', title: '', fields: [], at }],
      r.state,
    );
    expect(after.state).toBe(r.state);
    expect(after.effects.flat()).toEqual([]);
  });

  it('validates user events at the boundary', () => {
    expect(
      UserEventSchema.safeParse({ type: 'ANSWER', fieldId: '0:f1', value: 'x', save: true })
        .success,
    ).toBe(true);
    expect(UserEventSchema.safeParse({ type: 'FILL_RESULTS', results: [] }).success).toBe(false); // system-only
    expect(
      UserEventSchema.safeParse({ type: 'ANSWER', fieldId: '0:f1', value: { a: 1 }, save: true })
        .success,
    ).toBe(false);
  });
});

describe('errors and interruptions', () => {
  it('scan failure → ERROR; rescan recovers', () => {
    const r = run([
      { type: 'START', id: 's', tabId: 1, at },
      { type: 'SCAN_FAILED', code: 'NO_PERMISSION', message: 'Needs permission' },
    ]);
    expect(r.state).toMatchObject({ phase: 'ERROR', error: { code: 'NO_PERMISSION' } });
    const again = run([{ type: 'RESCAN' }], r.state);
    expect(again.state.phase).toBe('SCANNING');
    expect(again.last).toEqual([{ type: 'SCAN' }]);
  });

  it('vault locked mid-session hides vault values; unlocking re-plans everything not answered by the user', () => {
    const r = run([
      ...toReview(),
      { type: 'ANSWER', fieldId: '0:f1', value: '14/05/2003', save: false },
      { type: 'VAULT_LOCKED' },
    ]);
    expect(r.state.phase).toBe('ERROR');
    expect(r.state.plan[0]!.value).toBeUndefined();
    expect(r.state.plan[1]!.value).toBe('14/05/2003'); // the user's own answer stays
    const u = run([{ type: 'VAULT_UNLOCKED' }], r.state);
    expect(u.state.phase).toBe('MAPPING');
    expect(u.last).toEqual([{ type: 'MAP', fieldIds: ['0:f0', '0:f2'] }]);
  });

  it('new wizard fields are mapped; removed ones leave the plan', () => {
    const r = run([
      ...toReview(),
      {
        type: 'FIELDS_CHANGED',
        url: 'https://www.example.com/apply/2',
        added: [field('0:f9', 'City')],
        removed: ['0:f0'],
        at,
      },
    ]);
    expect(r.state.fields.map((f) => f.id)).toEqual(['0:f1', '0:f2', '0:f9']);
    expect(r.state.plan.map((p) => p.fieldId)).toEqual(['0:f1', '0:f2']);
    expect(r.state.pages).toHaveLength(2);
    expect(r.last).toEqual([{ type: 'MAP', fieldIds: ['0:f9'] }]);
  });

  it('same-site navigation rescans; leaving the site ends the session', () => {
    const base = run(toReview()).state;
    expect(
      run([{ type: 'NAVIGATED', url: 'https://example.com/apply?step=2', at }], base).state.phase,
    ).toBe('SCANNING');
    const left = run([{ type: 'NAVIGATED', url: 'https://other.org/', at }], base);
    expect(left.state).toMatchObject({
      phase: 'ENDED',
      endReason: expect.stringContaining('left the site'),
    });
  });

  it('tab closed mid-fill ends the session without trying to reach the page', () => {
    const r = run([
      ...toReview(),
      { type: 'APPROVE_ALL_VAULT' },
      { type: 'FILL' },
      { type: 'TAB_CLOSED' },
    ]);
    expect(r.state.phase).toBe('ENDED');
    expect(r.last).toEqual([]);
  });

  it('skipping the last open questions makes the page ready', () => {
    const r = run([
      ...toReview(),
      { type: 'APPROVE_ALL_VAULT' },
      { type: 'FILL' },
      { type: 'FILL_RESULTS', results: [{ fieldId: '0:f0', status: 'filled' }] },
      { type: 'SKIP', fieldId: '0:f1' },
    ]);
    expect(r.state.phase).toBe('READY_TO_SUBMIT');
  });
});
