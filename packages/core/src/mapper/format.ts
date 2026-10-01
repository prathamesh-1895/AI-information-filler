/**
 * Value formatting (PLAYBOOK Task 5.3): adapts a vault value to the shape a
 * field wants (name parts, phone with/without country code, date formats,
 * option values, codes vs names, lists, numbers, URLs). Never invents: when a
 * value cannot be adapted it returns a question for the user instead.
 */
import { getKeyDef } from '../schema/keys';
import type { Fact, FactValue, FieldDescriptor, FieldOption } from '../schema/records';
import { formatIsoDate, matchOption, parseLooseDate, type LooseDate } from '../text/match';
import { normaliseLabel } from '../text/normalise';
import type { MapResult } from './map';

export type FactLookup = (key: string) => Fact | undefined;

export type FormatResult =
  { ok: true; value: FactValue; note?: string } | { ok: false; reason: string; question: string };

const MULTI = new Set(['checkbox-group', 'aria-checkbox-group', 'select-multiple', 'tags']);
const OPTION_TYPES = new Set([
  'select-one',
  'select-multiple',
  'radio',
  'checkbox-group',
  'aria-radiogroup',
  'aria-checkbox-group',
  'aria-listbox',
  'aria-combobox',
]);

export const questionFor = (field: Pick<FieldDescriptor, 'label'>) =>
  `What should I put for “${field.label}”?`;

const ask = (field: FieldDescriptor, reason: string): FormatResult => ({
  ok: false,
  reason,
  question: questionFor(field),
});

// ------------------------------------------------------------ derivations

function nameParts(full: string): { first: string; middle: string; last: string } {
  const parts = full.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 1) return { first: parts[0]!, middle: '', last: '' };
  return { first: parts[0] ?? '', middle: parts.slice(1, -1).join(' '), last: parts.at(-1) ?? '' };
}

/** Values that can be derived from other facts (only exact, lossless derivations). */
function derive(key: string, lookup: FactLookup): { value: string; note: string } | null {
  const text = (k: string) => {
    const v = lookup(k)?.value;
    return typeof v === 'string' && v.trim() ? v.trim() : undefined;
  };
  const full = text('person.name.full');
  if (
    full &&
    (key === 'person.name.first' || key === 'person.name.last' || key === 'person.name.middle')
  ) {
    const parts = nameParts(full);
    const value =
      key === 'person.name.first'
        ? parts.first
        : key === 'person.name.last'
          ? parts.last
          : parts.middle;
    return value ? { value, note: 'Taken from your full name' } : null;
  }
  if (key === 'person.name.full') {
    const joined = [text('person.name.first'), text('person.name.middle'), text('person.name.last')]
      .filter(Boolean)
      .join(' ');
    if (text('person.name.first') && text('person.name.last'))
      return { value: joined, note: 'Joined from your first and last name' };
  }
  return null;
}

// ------------------------------------------------------------------ phones

/** Picks the phone spelling that satisfies the field's pattern / length / placeholder. */
export function formatPhone(
  raw: string,
  field: Pick<FieldDescriptor, 'maxLength' | 'pattern' | 'placeholder'>,
): string | null {
  const trimmed = raw.trim();
  const digits = trimmed.replace(/\D/g, '');
  if (digits.length < 6) return null;
  const national =
    digits.length === 12 && digits.startsWith('91')
      ? digits.slice(2)
      : digits.length === 11 && digits.startsWith('0')
        ? digits.slice(1)
        : digits;
  const international =
    digits.length > 10 ? `+${digits}` : trimmed.startsWith('+') ? trimmed : null;
  const candidates = [
    ...new Set([trimmed, international, national, digits].filter((c): c is string => Boolean(c))),
  ];

  let pattern: RegExp | null = null;
  if (field.pattern) {
    try {
      pattern = new RegExp(`^(?:${field.pattern})$`, 'u');
    } catch {
      pattern = null;
    }
  }
  const fits = (c: string) =>
    (!field.maxLength || c.length <= field.maxLength) && (!pattern || pattern.test(c));
  // A placeholder like "+91 98765 43210" asks for the international form; "98765 43210" for the national one.
  const ph = field.placeholder ?? '';
  const order = /^\s*\+/.test(ph)
    ? [international, trimmed, national]
    : /\d{5}/.test(ph)
      ? [national, trimmed]
      : field.maxLength || pattern
        ? [international, national, trimmed, digits]
        : [trimmed];
  for (const c of order) if (c && fits(c)) return c;
  return candidates.find(fits) ?? null;
}

// ------------------------------------------------------------------- dates

const MONTH_NAMES = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];
const pad = (n: number) => String(n).padStart(2, '0');

/** Text formats hinted by placeholder or pattern, e.g. "DD/MM/YYYY". */
export function formatDateText(d: LooseDate, hint: string): string | null {
  const h = hint.toLowerCase();
  const m = /(dd|mm|yyyy|yy)([\s/.-])(dd|mm|yyyy|yy)(?:\2(dd|mm|yyyy|yy))?/.exec(h);
  if (!m) return null;
  const sep = m[2]!;
  const parts = [m[1], m[3], m[4]].filter((p): p is string => Boolean(p));
  if (parts.includes('dd') && d.day === undefined) return null;
  return parts
    .map((p) =>
      p === 'dd'
        ? pad(d.day!)
        : p === 'mm'
          ? pad(d.month)
          : p === 'yy'
            ? String(d.year).slice(-2)
            : String(d.year),
    )
    .join(sep);
}

/** Value for a Day / Month / Year field, matched to its options when it has them. */
function datePart(
  d: LooseDate,
  part: 'day' | 'month' | 'year',
  options?: FieldOption[],
): string | null {
  const n = part === 'day' ? d.day : part === 'month' ? d.month : d.year;
  if (n === undefined) return null;
  if (!options?.length) return part === 'year' ? String(n) : pad(n);
  const byNumber = options.find((o) => Number(o.value) === n || Number(o.text) === n);
  if (byNumber) return byNumber.value;
  if (part === 'month') {
    const name = MONTH_NAMES[n - 1]!;
    const match = matchOption(options, name) ?? matchOption(options, name.slice(0, 3));
    if (match) return match.option.value;
  }
  return null;
}

// ----------------------------------------------------- countries and states

const COUNTRY_CODES: Record<string, string> = {
  IN: 'India',
  US: 'United States',
  GB: 'United Kingdom',
  CA: 'Canada',
  AU: 'Australia',
  DE: 'Germany',
  FR: 'France',
  JP: 'Japan',
  CN: 'China',
  SG: 'Singapore',
  AE: 'United Arab Emirates',
  BR: 'Brazil',
  NP: 'Nepal',
  BD: 'Bangladesh',
  LK: 'Sri Lanka',
  NZ: 'New Zealand',
  IE: 'Ireland',
  NL: 'Netherlands',
  IT: 'Italy',
  ES: 'Spain',
  ZA: 'South Africa',
};
const COUNTRY_ALIASES: Record<string, string> = {
  usa: 'United States',
  'united states of america': 'United States',
  us: 'United States',
  uk: 'United Kingdom',
  'great britain': 'United Kingdom',
  uae: 'United Arab Emirates',
  bharat: 'India',
};
const STATE_CODES: Record<string, string> = {
  MH: 'Maharashtra',
  KA: 'Karnataka',
  GJ: 'Gujarat',
  TN: 'Tamil Nadu',
  KL: 'Kerala',
  DL: 'Delhi',
  UP: 'Uttar Pradesh',
  WB: 'West Bengal',
  RJ: 'Rajasthan',
  TG: 'Telangana',
  TS: 'Telangana',
  AP: 'Andhra Pradesh',
  PB: 'Punjab',
  HR: 'Haryana',
  MP: 'Madhya Pradesh',
  BR: 'Bihar',
  GA: 'Goa',
  OD: 'Odisha',
  OR: 'Odisha',
  JH: 'Jharkhand',
  AS: 'Assam',
  CT: 'Chhattisgarh',
};

/** Other spellings of a value that options might use (code ↔ name). */
function alternates(key: string | undefined, value: string): string[] {
  const v = value.trim();
  const out: string[] = [];
  const table =
    key === 'address.country' ? COUNTRY_CODES : key === 'address.state' ? STATE_CODES : null;
  if (!table) return out;
  const upper = v.toUpperCase();
  if (table[upper]) out.push(table[upper]);
  const alias = key === 'address.country' ? COUNTRY_ALIASES[normaliseLabel(v)] : undefined;
  if (alias) out.push(alias);
  for (const [code, name] of Object.entries(table))
    if (normaliseLabel(name) === normaliseLabel(alias ?? v)) out.push(code);
  return out;
}

function pickOption(
  options: FieldOption[],
  value: string,
  key: string | undefined,
): FieldOption | null {
  for (const candidate of [value, ...alternates(key, value)]) {
    const m = matchOption(options, candidate);
    if (m) return m.option;
  }
  return null;
}

// -------------------------------------------------------------------- main

const asList = (v: FactValue) =>
  (Array.isArray(v) ? v : v.split(/\s*[,;\n]\s*/)).map((s) => s.trim()).filter(Boolean);

/**
 * Formats the vault value for `mapping.canonicalKey` to fit `field`.
 * `lookup` reads facts from the (unlocked) vault.
 */
export function formatForField(
  field: FieldDescriptor,
  mapping: MapResult,
  lookup: FactLookup,
): FormatResult {
  const key = mapping.canonicalKey;
  if (!key) return ask(field, 'Filler does not know this field yet.');
  const def = getKeyDef(key);
  const label = def?.label ?? key.replace(/^custom\./, '').replace(/_/g, ' ');

  let raw: FactValue | undefined = lookup(key)?.value;
  let note: string | undefined;
  if (
    raw === undefined ||
    (typeof raw === 'string' && !raw.trim()) ||
    (Array.isArray(raw) && !raw.length)
  ) {
    const derived = derive(key, lookup);
    if (!derived) return ask(field, `Your vault has no ${label.toLowerCase()} yet.`);
    raw = derived.value;
    note = derived.note;
  }
  const done = (value: FactValue): FormatResult => ({ ok: true, value, ...(note ? { note } : {}) });
  const text = Array.isArray(raw) ? raw.join(', ') : raw.trim();

  // Split date fields.
  if (mapping.part) {
    const d = parseLooseDate(text);
    const v = d ? datePart(d, mapping.part, field.options) : null;
    return v
      ? done(v)
      : ask(
          field,
          `Your saved ${label.toLowerCase()} (“${text}”) does not fit this ${mapping.part} field.`,
        );
  }

  // Native date-like inputs.
  if (field.inputType === 'date' || field.inputType === 'month') {
    const d = parseLooseDate(text);
    if (!d)
      return ask(
        field,
        `Your saved ${label.toLowerCase()} (“${text}”) is not a date Filler understands.`,
      );
    if (field.inputType === 'date' && d.day === undefined)
      return ask(field, `This field needs a full date; your saved value is “${text}”.`);
    return done(formatIsoDate(field.inputType === 'month' ? { year: d.year, month: d.month } : d));
  }

  // Fields with a fixed set of options.
  if (OPTION_TYPES.has(field.inputType) && field.options?.length) {
    const options = field.options;
    if (MULTI.has(field.inputType)) {
      const picked = asList(raw)
        .map((v) => pickOption(options, v, key))
        .filter((o): o is FieldOption => o !== null);
      const values = [...new Set(picked.map((o) => o.value))];
      return values.length
        ? done(values)
        : ask(field, `None of your saved ${label.toLowerCase()} are options here.`);
    }
    const option = pickOption(options, text, key);
    return option
      ? done(option.value)
      : ask(
          field,
          `Your saved ${label.toLowerCase()} is “${text}”, which is not one of the options here.`,
        );
  }

  if (field.inputType === 'tags') return done(asList(raw));

  // Phones.
  if (field.inputType === 'tel' || def?.valueType === 'phone') {
    const phone = formatPhone(text, field);
    return phone
      ? done(phone)
      : ask(field, `Your saved ${label.toLowerCase()} does not fit this field's format.`);
  }

  // Dates typed as text, e.g. placeholder "DD/MM/YYYY".
  if (def?.valueType === 'date') {
    const d = parseLooseDate(text);
    const hinted = d
      ? formatDateText(
          d,
          `${field.placeholder ?? ''} ${field.pattern ?? ''} ${field.helpText ?? ''}`,
        )
      : null;
    if (hinted) return done(hinted);
  }

  // Numbers: "₹1,500 / hr" → "1500" for number inputs.
  if (field.inputType === 'number') {
    const m = /-?\d[\d,]*(?:\.\d+)?/.exec(text);
    return m
      ? done(m[0].replace(/,/g, ''))
      : ask(field, `Your saved ${label.toLowerCase()} (“${text}”) is not a number.`);
  }

  // URLs need a scheme in url inputs.
  if (field.inputType === 'url' && text && !/^[a-z][a-z0-9+.-]*:\/\//i.test(text))
    return done(`https://${text}`);

  // Single text field: lists become comma-separated text.
  const value = Array.isArray(raw) ? raw.join(', ') : raw;
  if (field.maxLength && value.length > field.maxLength) {
    return ask(
      field,
      `Your saved ${label.toLowerCase()} is ${value.length} characters, but this field allows ${field.maxLength}.`,
    );
  }
  return done(value);
}
