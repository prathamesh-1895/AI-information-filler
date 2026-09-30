import { describe, expect, it } from 'vitest';
import { editDistance, formatIsoDate, matchOption, parseLooseDate, similarity } from './match';

describe('editDistance / similarity', () => {
  it('computes edit distance', () => {
    expect(editDistance('kitten', 'sitting')).toBe(3);
    expect(editDistance('', 'abc')).toBe(3);
    expect(editDistance('same', 'same')).toBe(0);
  });

  it('scores normalised text', () => {
    expect(similarity('Intermediate', 'intermediate')).toBe(1);
    expect(similarity('Fluent', 'Fluemt')).toBeCloseTo(0.833, 2);
    expect(similarity('', '')).toBe(1);
  });
});

const levels = [
  { value: 'basic', text: 'Basic' },
  { value: 'conversational', text: 'Conversational' },
  { value: 'fluent', text: 'Fluent' },
  { value: 'native_bilingual', text: 'Native or bilingual' },
];

describe('matchOption', () => {
  it.each([
    ['fluent', 'fluent', 'value'],
    ['Conversational', 'conversational', 'text'],
    ['  BASIC ', 'basic', 'text'],
    ['Native', 'native_bilingual', 'prefix'],
    ['Conversationnal', 'conversational', 'fuzzy'],
  ])('%j → %s (%s)', (target, value, how) => {
    expect(matchOption(levels, target)).toMatchObject({ option: { value }, how });
  });

  it.each(['Expert', '', 'Intermediate'])('%j matches nothing', (target) => {
    expect(matchOption(levels, target)).toBeNull();
  });

  it('refuses ambiguous prefix and fuzzy matches', () => {
    const opts = [
      { value: '1', text: 'Mumbai City' },
      { value: '2', text: 'Mumbai Suburban' },
    ];
    expect(matchOption(opts, 'Mumbai')).toBeNull();
    const close = [
      { value: 'a', text: 'Pune East' },
      { value: 'b', text: 'Pune West' },
    ];
    expect(matchOption(close, 'Pune Est')).toBeNull();
  });

  it('matches on option value text when labels differ (country codes)', () => {
    const countries = [
      { value: 'IN', text: 'India' },
      { value: 'US', text: 'United States' },
    ];
    expect(matchOption(countries, 'India')?.option.value).toBe('IN');
    expect(matchOption(countries, 'US')?.option.value).toBe('US');
    expect(matchOption(countries, 'united states')?.option.value).toBe('US');
  });
});

describe('parseLooseDate', () => {
  it.each([
    ['2003-05-14', '2003-05-14'],
    ['2003-5-4', '2003-05-04'],
    ['2026-06', '2026-06'],
    ['14/05/2003', '2003-05-14'],
    ['14-05-2003', '2003-05-14'],
    ['14.05.2003', '2003-05-14'],
    ['05/14/2003', '2003-05-14'],
    ['04/05/2003', '2003-05-04'],
    ['06/2026', '2026-06'],
    ['14 May 2003', '2003-05-14'],
    ['14th May, 2003', '2003-05-14'],
    ['May 14, 2003', '2003-05-14'],
    ['September 2025', '2025-09'],
    ['2003-05-14T00:00:00Z', '2003-05-14'],
  ])('%j → %s', (input, iso) => {
    const parsed = parseLooseDate(input);
    expect(parsed).not.toBeNull();
    expect(formatIsoDate(parsed!)).toBe(iso);
  });

  it.each(['31/02/2003', '2003-13-01', 'yesterday', '14 Smarch 2003', '1850-01-01', ''])(
    '%j is rejected',
    (input) => {
      expect(parseLooseDate(input)).toBeNull();
    },
  );
});
