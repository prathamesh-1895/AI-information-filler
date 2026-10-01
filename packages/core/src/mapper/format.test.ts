import { describe, expect, it } from 'vitest';
import type { Fact, FactValue, FieldDescriptor } from '../schema/records';
import { formatDateText, formatForField, formatPhone, type FormatResult } from './format';
import type { MapResult } from './map';

const field = (over: Partial<FieldDescriptor> = {}): FieldDescriptor => ({
  id: 'f0',
  frameId: 0,
  selector: '#x',
  tag: 'input',
  inputType: 'text',
  label: 'Field',
  labelSource: 'label-for',
  required: false,
  isVisible: true,
  isDisabled: false,
  signature: 'a'.repeat(64),
  ...over,
});

const vault =
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

const map = (canonicalKey: string, part?: MapResult['part']): MapResult => ({
  kind: 'fact',
  canonicalKey,
  ...(part ? { part } : {}),
  confidence: 1,
  reason: '',
  source: 'dictionary',
});

const value = (r: FormatResult) => (r.ok ? r.value : `ASK: ${r.reason}`);

const facts = vault({
  'person.name.full': 'Priya Rajesh Sharma',
  'contact.phone.mobile': '+91 98765 43210',
  'person.dob': '14/05/2003',
  'address.country': 'India',
  'address.state': 'MH',
  skills: ['SQL', 'Excel', 'Power BI'],
  'preferences.hourly_rate': '₹1,500 / hr',
  'links.linkedin': 'linkedin.com/in/priya',
  'languages[0].proficiency': 'Fluent',
  'bio.headline': 'Business Consultant for Growing SMBs',
  'education[0].end': 'June 2026',
  'person.gender': 'Female',
});

describe('names', () => {
  it.each([
    ['person.name.first', 'Priya'],
    ['person.name.middle', 'Rajesh'],
    ['person.name.last', 'Sharma'],
    ['person.name.full', 'Priya Rajesh Sharma'],
  ])('%s → %s', (key, want) => expect(value(formatForField(field(), map(key), facts))).toBe(want));

  it('joins first and last into a full name', () => {
    const v = vault({ 'person.name.first': 'Priya', 'person.name.last': 'Sharma' });
    expect(formatForField(field(), map('person.name.full'), v)).toEqual({
      ok: true,
      value: 'Priya Sharma',
      note: 'Joined from your first and last name',
    });
  });

  it('does not invent a last name from a single-word full name', () => {
    const v = vault({ 'person.name.full': 'Priya' });
    expect(formatForField(field(), map('person.name.last'), v).ok).toBe(false);
  });
});

describe('phones', () => {
  it.each([
    [{}, '+91 98765 43210'],
    [{ maxLength: 10 }, '9876543210'],
    [{ pattern: '[0-9]{10}' }, '9876543210'],
    [{ placeholder: '+91 98765 43210' }, '+919876543210'],
    [{ placeholder: '98765 43210' }, '9876543210'],
    [{ maxLength: 13 }, '+919876543210'],
  ])('%j → %s', (over, want) => expect(formatPhone('+91 98765 43210', over)).toBe(want));

  it('handles a leading trunk zero and refuses junk', () => {
    expect(formatPhone('09876543210', { maxLength: 10 })).toBe('9876543210');
    expect(formatPhone('call me', {})).toBeNull();
    expect(formatPhone('98765', { maxLength: 10 })).toBeNull();
  });

  it('formats tel inputs and asks when nothing fits', () => {
    expect(
      value(
        formatForField(
          field({ inputType: 'tel', maxLength: 10 }),
          map('contact.phone.mobile'),
          facts,
        ),
      ),
    ).toBe('9876543210');
    expect(
      formatForField(field({ inputType: 'tel', maxLength: 6 }), map('contact.phone.mobile'), facts)
        .ok,
    ).toBe(false);
  });
});

describe('dates', () => {
  it.each([
    [{ inputType: 'date' }, 'person.dob', '2003-05-14'],
    [{ inputType: 'month' }, 'education[0].end', '2026-06'],
    [{ placeholder: 'DD/MM/YYYY' }, 'person.dob', '14/05/2003'],
    [{ placeholder: 'mm-dd-yyyy' }, 'person.dob', '05-14-2003'],
    [{ placeholder: 'YYYY-MM-DD' }, 'person.dob', '2003-05-14'],
    [{ placeholder: 'MM/YYYY' }, 'education[0].end', '06/2026'],
    [{}, 'person.dob', '14/05/2003'],
  ])('%j %s → %s', (over, key, want) =>
    expect(value(formatForField(field(over as Partial<FieldDescriptor>), map(key), facts))).toBe(
      want,
    ),
  );

  it('needs a full date for date inputs', () => {
    expect(
      formatForField(field({ inputType: 'date' }), map('education[0].end'), facts),
    ).toMatchObject({ ok: false });
  });

  it('fills split day / month / year selects from their options', () => {
    const days = Array.from({ length: 31 }, (_, i) => ({
      value: String(i + 1),
      text: String(i + 1),
    }));
    const monthNames = ['January', 'February', 'March', 'April', 'May', 'June'].map((t, i) => ({
      value: String(i + 1),
      text: t,
    }));
    const monthShort = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun'].map((t) => ({
      value: t.toLowerCase(),
      text: t,
    }));
    const years = ['2002', '2003', '2004'].map((y) => ({ value: y, text: y }));
    const sel = (options: { value: string; text: string }[]) =>
      field({ inputType: 'select-one', options });
    expect(value(formatForField(sel(days), map('person.dob', 'day'), facts))).toBe('14');
    expect(value(formatForField(sel(monthNames), map('person.dob', 'month'), facts))).toBe('5');
    expect(value(formatForField(sel(monthShort), map('person.dob', 'month'), facts))).toBe('may');
    expect(value(formatForField(sel(years), map('person.dob', 'year'), facts))).toBe('2003');
    expect(formatForField(sel(years.slice(0, 1)), map('person.dob', 'year'), facts).ok).toBe(false);
    expect(value(formatForField(field(), map('person.dob', 'month'), facts))).toBe('05');
  });

  it('formats text dates by hint', () => {
    expect(formatDateText({ year: 2003, month: 5, day: 4 }, 'dd.mm.yyyy')).toBe('04.05.2003');
    expect(formatDateText({ year: 2003, month: 5 }, 'dd/mm/yyyy')).toBeNull();
    expect(formatDateText({ year: 2003, month: 5, day: 4 }, 'no hint')).toBeNull();
  });
});

describe('options', () => {
  const countries = [
    { value: 'IN', text: 'India' },
    { value: 'US', text: 'United States' },
  ];
  const states = [
    { value: 'Maharashtra', text: 'Maharashtra' },
    { value: 'Gujarat', text: 'Gujarat' },
  ];
  it.each([
    [countries, 'address.country', 'IN'],
    [[{ value: 'india', text: 'INDIA' }], 'address.country', 'india'],
    [states, 'address.state', 'Maharashtra'],
    [
      [
        { value: 'MH', text: 'MH' },
        { value: 'GJ', text: 'GJ' },
      ],
      'address.state',
      'MH',
    ],
    [
      [
        { value: 'f', text: 'Female' },
        { value: 'm', text: 'Male' },
      ],
      'person.gender',
      'f',
    ],
    [
      [
        { value: 'basic', text: 'Basic' },
        { value: 'fluent', text: 'Fluent' },
      ],
      'languages[0].proficiency',
      'fluent',
    ],
  ])('%j %s → %s', (options, key, want) => {
    expect(
      value(formatForField(field({ inputType: 'select-one', options }), map(key), facts)),
    ).toBe(want);
  });

  it('maps country names to codes and aliases', () => {
    const v = vault({ 'address.country': 'USA' });
    expect(
      value(
        formatForField(
          field({ inputType: 'select-one', options: countries }),
          map('address.country'),
          v,
        ),
      ),
    ).toBe('US');
  });

  it('picks the matching subset for checkbox groups', () => {
    const options = ['Excel', 'SQL', 'Python'].map((t) => ({ value: t, text: t }));
    expect(
      value(
        formatForField(field({ inputType: 'aria-checkbox-group', options }), map('skills'), facts),
      ),
    ).toEqual(['SQL', 'Excel']);
    const none = ['Go', 'Rust'].map((t) => ({ value: t, text: t }));
    expect(
      formatForField(field({ inputType: 'checkbox-group', options: none }), map('skills'), facts)
        .ok,
    ).toBe(false);
  });

  it('asks when the saved value is not an option', () => {
    const r = formatForField(
      field({ inputType: 'select-one', options: countries }),
      map('address.state'),
      facts,
    );
    expect(r).toMatchObject({ ok: false, question: 'What should I put for “Field”?' });
  });
});

describe('lists, numbers, urls, lengths', () => {
  it('turns lists into tags or text', () => {
    expect(value(formatForField(field({ inputType: 'tags' }), map('skills'), facts))).toEqual([
      'SQL',
      'Excel',
      'Power BI',
    ]);
    expect(value(formatForField(field(), map('skills'), facts))).toBe('SQL, Excel, Power BI');
  });

  it('extracts numbers for number inputs only', () => {
    expect(
      value(formatForField(field({ inputType: 'number' }), map('preferences.hourly_rate'), facts)),
    ).toBe('1500');
    expect(value(formatForField(field(), map('preferences.hourly_rate'), facts))).toBe(
      '₹1,500 / hr',
    );
  });

  it('adds a scheme to links in url inputs', () => {
    expect(value(formatForField(field({ inputType: 'url' }), map('links.linkedin'), facts))).toBe(
      'https://linkedin.com/in/priya',
    );
    expect(value(formatForField(field(), map('links.linkedin'), facts))).toBe(
      'linkedin.com/in/priya',
    );
  });

  it('never truncates; asks instead', () => {
    const r = formatForField(field({ maxLength: 10 }), map('bio.headline'), facts);
    expect(r).toMatchObject({ ok: false, reason: expect.stringContaining('allows 10') });
  });

  it('asks for missing and unmapped facts', () => {
    expect(formatForField(field({ label: 'GitHub' }), map('links.github'), facts)).toMatchObject({
      ok: false,
      question: 'What should I put for “GitHub”?',
      reason: 'Your vault has no github yet.',
    });
    expect(
      formatForField(field(), { kind: 'fact', confidence: 0, reason: '', source: 'none' }, facts)
        .ok,
    ).toBe(false);
  });
});
