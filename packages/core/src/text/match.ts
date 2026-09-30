/** Fuzzy matching helpers: option matching for selects/radios and loose date parsing. */
import { normaliseLabel } from './normalise';

/** Levenshtein edit distance (two-row DP). */
export function editDistance(a: string, b: string): number {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  let cur = new Array<number>(b.length + 1);
  for (let i = 1; i <= a.length; i++) {
    cur[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      cur[j] = Math.min((prev[j] ?? 0) + 1, (cur[j - 1] ?? 0) + 1, (prev[j - 1] ?? 0) + cost);
    }
    [prev, cur] = [cur, prev];
  }
  return prev[b.length] ?? 0;
}

/** 1 = identical, 0 = nothing in common; compares normalised text. */
export function similarity(a: string, b: string): number {
  const x = normaliseLabel(a);
  const y = normaliseLabel(b);
  const longest = Math.max(x.length, y.length);
  return longest === 0 ? 1 : 1 - editDistance(x, y) / longest;
}

export interface OptionLike {
  value: string;
  text: string;
}

export type OptionMatch<T extends OptionLike> = {
  option: T;
  how: 'value' | 'text' | 'prefix' | 'fuzzy';
  score: number;
};

export const FUZZY_OPTION_THRESHOLD = 0.85;

/**
 * Picks the option a value refers to: exact value → normalised text →
 * unique whole-word prefix either way ("Native" ↔ "Native or bilingual") →
 * fuzzy (≥ 0.85, and clearly better than the runner-up). Returns null
 * rather than guessing.
 */
export function matchOption<T extends OptionLike>(
  options: readonly T[],
  target: string,
): OptionMatch<T> | null {
  const byValue = options.find((o) => o.value === target);
  if (byValue) return { option: byValue, how: 'value', score: 1 };
  const t = normaliseLabel(target);
  if (!t) return null;
  const byText = options.find((o) => normaliseLabel(o.text) === t || normaliseLabel(o.value) === t);
  if (byText) return { option: byText, how: 'text', score: 1 };

  const prefixed = options.filter((o) => {
    const text = normaliseLabel(o.text);
    return text.startsWith(`${t} `) || t.startsWith(`${text} `);
  });
  if (prefixed.length === 1) return { option: prefixed[0]!, how: 'prefix', score: 0.95 };

  const scored = options
    .map((o) => ({
      option: o,
      score: Math.max(similarity(o.text, target), similarity(o.value, target)),
    }))
    .sort((a, b) => b.score - a.score);
  const [best, second] = scored;
  if (
    best &&
    best.score >= FUZZY_OPTION_THRESHOLD &&
    (!second || best.score - second.score >= 0.05)
  ) {
    return { option: best.option, how: 'fuzzy', score: best.score };
  }
  return null;
}

export interface LooseDate {
  year: number;
  month: number;
  day?: number;
}

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

function monthFromName(name: string): number | undefined {
  const i = MONTHS.indexOf(name.slice(0, 3).toLowerCase());
  return i >= 0 ? i + 1 : undefined;
}

function valid(d: LooseDate): LooseDate | null {
  if (d.year < 1900 || d.year > 2100 || d.month < 1 || d.month > 12) return null;
  if (d.day !== undefined) {
    const days = new Date(Date.UTC(d.year, d.month, 0)).getUTCDate();
    if (d.day < 1 || d.day > days) return null;
  }
  return d;
}

/**
 * Parses common date spellings: 2003-05-14, 2003-05, 14/05/2003, 14-05-2003,
 * 14.05.2003, 14 May 2003, May 14, 2003, May 2003. Numeric d/m/y is read
 * day-first (Indian/European usage) unless the first number cannot be a day.
 */
export function parseLooseDate(input: string): LooseDate | null {
  const s = input.trim();
  let m = /^(\d{4})-(\d{1,2})(?:-(\d{1,2}))?(?:T.*)?$/.exec(s);
  if (m) return valid({ year: +m[1]!, month: +m[2]!, ...(m[3] ? { day: +m[3] } : {}) });
  m = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/.exec(s);
  if (m) {
    const a = +m[1]!;
    const b = +m[2]!;
    const dayFirst = valid({ year: +m[3]!, month: b, day: a });
    return dayFirst ?? valid({ year: +m[3]!, month: a, day: b });
  }
  m = /^(\d{1,2})[/.-](\d{4})$/.exec(s);
  if (m) return valid({ year: +m[2]!, month: +m[1]! });
  m = /^(\d{1,2})(?:st|nd|rd|th)?\s+([a-z]+)\.?,?\s+(\d{4})$/i.exec(s);
  if (m) {
    const month = monthFromName(m[2]!);
    return month ? valid({ year: +m[3]!, month, day: +m[1]! }) : null;
  }
  m = /^([a-z]+)\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})$/i.exec(s);
  if (m) {
    const month = monthFromName(m[1]!);
    return month ? valid({ year: +m[3]!, month, day: +m[2]! }) : null;
  }
  m = /^([a-z]+)\.?,?\s+(\d{4})$/i.exec(s);
  if (m) {
    const month = monthFromName(m[1]!);
    return month ? valid({ year: +m[2]!, month }) : null;
  }
  return null;
}

const pad = (n: number) => String(n).padStart(2, '0');

/** `yyyy-mm-dd` (needs a day) or `yyyy-mm` (month precision). */
export function formatIsoDate(d: LooseDate): string {
  return d.day === undefined
    ? `${d.year}-${pad(d.month)}`
    : `${d.year}-${pad(d.month)}-${pad(d.day)}`;
}
