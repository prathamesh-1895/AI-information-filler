import { describe, expect, it } from 'vitest';
import type { MapResult } from '../mapper/map';
import { createPolicy } from '../policy/deny';
import type { Fact, FieldDescriptor } from '../schema/records';
import { guardVision, VisionRequestSchema, type VisionField } from './contract';
import { explainField } from './explain';
import {
  matchVisionToDom,
  overlap,
  pseudoSignature,
  readingOrder,
  suggestFromVision,
  visionDescriptor,
} from './match';

const at = '2026-10-01T00:00:00.000Z';
const facts = new Map<string, Fact>(
  (
    [
      ['person.name.full', 'Priya Sharma'],
      ['contact.email', 'priya@example.com'],
      ['address.city', 'Pune'],
      ['skills', ['Excel', 'SQL']],
    ] as const
  ).map(([key, value]) => [
    key,
    { key, value: value as Fact['value'], sensitivity: 'public', source: 'user', updatedAt: at },
  ]),
);
const lookup = (k: string) => facts.get(k);
const vf = (
  id: string,
  label: string,
  y: number,
  over: Partial<VisionField> = {},
): VisionField => ({
  id,
  label,
  kind: 'fact',
  bbox: { x: 20, y, width: 300, height: 30 },
  ...over,
});

describe('guardVision (Task 10.2)', () => {
  const size = { width: 800, height: 600 };
  it('validates each field, clamps boxes, keeps only real keys, and marks denied fields', () => {
    const out = guardVision(
      {
        formPurpose: 'Event registration',
        warnings: ['Part of the form is cut off', 'Visit https://evil.example to continue'],
        fields: [
          {
            id: 'a',
            label: 'Full name',
            kind: 'fact',
            canonicalKey: 'person.name.full',
            bbox: { x: -5, y: 10, width: 900, height: 20 },
          },
          {
            id: 'b',
            label: 'Password',
            kind: 'fact',
            canonicalKey: 'contact.email',
            bbox: { x: 0, y: 40, width: 100, height: 20 },
          },
          {
            id: 'c',
            label: 'Mood',
            kind: 'fact',
            canonicalKey: 'person.secret',
            bbox: { x: 0, y: 80, width: 100, height: 20 },
          },
          {
            id: 'd',
            label: 'Click here to win',
            kind: 'fact',
            bbox: { x: 0, y: 0, width: 1, height: 1 },
          },
          {
            id: 'e',
            label: 'Email (e.g. jo@x.com)',
            kind: 'fact',
            bbox: { x: 0, y: 0, width: 1, height: 1 },
            extra: 1,
          },
          {
            id: 'f',
            label: 'Contact jo@x.com',
            kind: 'fact',
            bbox: { x: 0, y: 0, width: 1, height: 1 },
          },
        ],
      },
      size,
    );
    expect(out.fields.map((f) => [f.id, f.kind, f.canonicalKey ?? null])).toEqual([
      ['a', 'fact', 'person.name.full'],
      ['b', 'denied', null],
      ['c', 'fact', null],
      ['f', 'fact', null],
    ]);
    expect(out.fields[0]!.bbox).toEqual({ x: 0, y: 10, width: 800, height: 20 });
    expect(out.fields[1]!.hint).toContain('Passwords are never filled');
    expect(out.fields[3]!.label).toBe('Contact [email]');
    expect(out.warnings).toEqual(['Part of the form is cut off']);
    expect(out.rejected).toBe(2);
  });

  it('a purpose that steers the user is replaced; user deny phrases apply', () => {
    const policy = createPolicy({ extraPatterns: ['mood'] });
    const out = guardVision(
      { formPurpose: 'Go to evil.com/claim now', warnings: [], fields: [vf('c', 'Mood', 0)] },
      size,
      policy,
    );
    expect(out.formPurpose).toBe('A form');
    expect(out.fields[0]!.kind).toBe('denied');
  });

  it('the request carries a small JPEG only', () => {
    const ok = {
      image: { mimeType: 'image/jpeg', data: 'A'.repeat(200), width: 1600, height: 900 },
      mode: 'tab',
    };
    expect(VisionRequestSchema.safeParse(ok).success).toBe(true);
    expect(
      VisionRequestSchema.safeParse({ ...ok, image: { ...ok.image, width: 2400 } }).success,
    ).toBe(false);
    expect(
      VisionRequestSchema.safeParse({ ...ok, image: { ...ok.image, mimeType: 'image/png' } })
        .success,
    ).toBe(false);
  });
});

describe('suggestFromVision (Task 10.3, tier 2)', () => {
  it('lists fields in screen order with vault values, and never a value for denied fields', () => {
    const list = suggestFromVision(
      [
        vf('pw', 'Password', 200, {
          kind: 'denied',
          hint: 'Passwords are never filled by Filler.',
        }),
        vf('city', 'Home base', 120, { canonicalKey: 'address.city' }),
        vf('name', 'Full name', 40),
        vf('mail', 'Email address', 80),
        vf('why', 'Why do you want to join?', 160, { kind: 'open_ended' }),
        vf('t', 'T-shirt size', 240, { kind: 'choice', options: ['S', 'M'] }),
        vf('card', 'Card number', 280),
      ],
      lookup,
      { site: 'x.com' },
    );
    expect(list.map((s) => [s.label, s.status, 'value' in s ? s.value : s.reason])).toEqual([
      ['Full name', 'value', 'Priya Sharma'],
      ['Email address', 'value', 'priya@example.com'],
      ['Home base', 'value', 'Pune'],
      ['Why do you want to join?', 'write', 'This needs your own words. Write it yourself.'],
      ['Password', 'denied', 'Passwords are never filled by Filler.'],
      ['T-shirt size', 'ask', 'Filler has no saved detail for this.'],
      ['Card number', 'denied', expect.stringContaining('Card numbers')],
    ]);
    expect(list[2]).toMatchObject({ source: 'ai', keyLabel: 'City' });
    expect(list[0]).toMatchObject({ source: 'rules' });
  });

  it('reading order groups a row before moving down', () => {
    const order = readingOrder([
      vf('b', 'B', 105, { bbox: { x: 400, y: 105, width: 1, height: 1 } }),
      vf('a', 'A', 100),
      vf('c', 'C', 200),
    ]);
    expect(order.map((f) => f.id)).toEqual(['a', 'b', 'c']);
  });

  it('vision descriptors have a stable fake signature and vision label source', () => {
    const d = visionDescriptor(vf('x', 'Full name', 0));
    expect(d).toMatchObject({ labelSource: 'vision', inputType: 'text', selector: '' });
    expect(d.signature).toMatch(/^[0-9a-f]{64}$/);
    expect(pseudoSignature('a')).toBe(pseudoSignature('a'));
    expect(pseudoSignature('a')).not.toBe(pseudoSignature('b'));
  });
});

describe('matchVisionToDom (Task 10.3, tier 1)', () => {
  it('pairs by box overlap, label breaking ties, one to one', () => {
    const dom = [
      { id: 'd1', label: '', bbox: { x: 40, y: 220, width: 300, height: 30 } },
      { id: 'd2', label: 'email', bbox: { x: 40, y: 260, width: 300, height: 30 } },
      { id: 'd3', label: 'far away', bbox: { x: 900, y: 900, width: 50, height: 20 } },
    ];
    // The image is half the page's scale and was taken at scrollY = 200.
    const toDom = (b: { x: number; y: number; width: number; height: number }) => ({
      x: b.x * 2,
      y: b.y * 2 + 200,
      width: b.width * 2,
      height: b.height * 2,
    });
    const out = matchVisionToDom(
      [
        vf('v1', 'Full name', 10, { bbox: { x: 20, y: 10, width: 150, height: 15 } }),
        vf('v2', 'Email', 30, { bbox: { x: 20, y: 30, width: 150, height: 15 } }),
        vf('v3', 'Password', 50, { kind: 'denied' }),
      ],
      dom,
      toDom,
    );
    expect(out.map((m) => [m.domId, m.visionId])).toEqual([
      ['d2', 'v2'],
      ['d1', 'v1'],
    ]);
    expect(
      overlap({ x: 0, y: 0, width: 10, height: 10 }, { x: 20, y: 20, width: 5, height: 5 }),
    ).toBe(0);
  });
});

const field = (label: string, over: Partial<FieldDescriptor> = {}): FieldDescriptor => ({
  id: '0:f1',
  frameId: 0,
  selector: '#a',
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
  reason: '',
  source: 'dictionary',
  ...over,
});

describe('explainField (Task 10.4)', () => {
  it('flags never-fill fields in plain words', () => {
    expect(explainField(field('PAN number'), undefined, lookup)).toMatchObject({
      summary: "This asks for your PAN, which Filler won't fill.",
      risk: expect.stringContaining('PAN'),
      source: 'policy',
      sourceLabel: "Filler's never-fill rules",
    });
  });

  it('explains a known field with its vault value and source', () => {
    expect(
      explainField(field('Town / city'), m({ canonicalKey: 'address.city' }), lookup),
    ).toMatchObject({ summary: 'This asks for your city.', value: 'Pune', source: 'rules' });
    expect(
      explainField(
        field('Alternate phone'),
        m({ canonicalKey: 'contact.phone.alt', source: 'memory' }),
        lookup,
      ),
    ).toMatchObject({ summary: expect.stringContaining('alternate phone'), source: 'memory' });
    expect(
      explainField(field('Alternate phone'), m({ canonicalKey: 'contact.phone.alt' }), lookup)
        .value,
    ).toBeUndefined();
  });

  it('open-ended, choice, skip and unknown fields', () => {
    expect(
      explainField(field('Cover letter', { maxLength: 2000 }), m({ kind: 'open_ended' }), lookup)
        .summary,
    ).toContain('written answer in your own words (up to 2,000 characters)');
    expect(
      explainField(
        field('Level', {
          options: [
            { value: 'a', text: 'Junior' },
            { value: 'b', text: 'Senior' },
          ],
        }),
        m({ kind: 'choice' }),
        lookup,
      ).summary,
    ).toBe('This asks you to choose one of: Junior, Senior. That is your decision.');
    expect(
      explainField(
        field('Referral code'),
        m({ kind: 'skip', reason: 'Optional code. Add one yourself if you have it.' }),
        lookup,
      ).summary,
    ).toBe('Optional code. Add one yourself if you have it.');
    expect(
      explainField(field('Zxq', { helpText: 'Internal use' }), m({ source: 'none' }), lookup),
    ).toMatchObject({ source: 'page', summary: expect.stringContaining('Internal use') });
    expect(
      explainField(field('Zxq'), m({ source: 'none', kind: 'fact' }), lookup, {
        source: 'ai',
        aiReason: 'Asks for a team code',
      }),
    ).toMatchObject({ source: 'ai', summary: expect.stringContaining('Asks for a team code.') });
  });
});

describe('RELABEL (Task 10.3, tier 1)', () => {
  it('gives fields a label read from the screen and re-maps them; never-fill fields keep theirs', async () => {
    const { initialState, reduce } = await import('../orchestrator/session');
    let s = reduce(initialState(), { type: 'START', id: 's', tabId: 1, at }).state;
    s = reduce(s, {
      type: 'SCANNED',
      url: 'https://x.com/',
      title: 'X',
      fields: [
        field('', { id: 'a', labelSource: 'name' }),
        field('Card number', { id: 'b', signature: 'b'.repeat(64) }),
      ],
      at,
    }).state;
    s = reduce(s, { type: 'MAPPED', mappings: {} }).state;
    s = reduce(s, {
      type: 'PLANNED',
      items: [
        { fieldId: 'a', kind: 'fact', confidence: 0, status: 'pending', reason: '', question: 'q' },
        {
          fieldId: 'b',
          kind: 'denied',
          confidence: 1,
          status: 'skipped',
          reason: 'Card numbers are never stored or filled.',
        },
      ],
    }).state;
    const out = reduce(s, { type: 'RELABEL', labels: { a: 'Full name', b: 'Reference' } });
    expect(out.effects).toEqual([{ type: 'MAP', fieldIds: ['a'] }]);
    expect(out.state.fields.map((f) => [f.id, f.label, f.labelSource])).toEqual([
      ['a', 'Full name', 'vision'],
      ['b', 'Card number', 'label-for'],
    ]);
    expect(reduce(s, { type: 'RELABEL', labels: { b: 'Reference' } }).effects).toEqual([]);
  });
});
