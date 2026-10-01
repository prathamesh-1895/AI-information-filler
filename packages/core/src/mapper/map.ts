/**
 * Rule-based field mapper (PLAYBOOK Task 5.2). Maps a FieldDescriptor to a
 * canonical key and a kind, without AI, in this order:
 * policy → skip rules → field memory → HTML autocomplete → the user's own
 * custom facts (same label) → dictionary → option-set heuristics → unresolved.
 */
import { classifyRisk, type Policy } from '../policy/deny';
import { customKeyFor, getKeyDef, parseKey, type ListGroup } from '../schema/keys';
import type { FieldDescriptor, FieldKind, FieldMemory } from '../schema/records';
import { humaniseIdentifier, isDynamicIdentifier, normaliseLabel } from '../text/normalise';
import { defaultDictionary, type CompiledDictionary } from './dictionary';

export type DatePart = 'day' | 'month' | 'year';

export interface MapResult {
  kind: FieldKind;
  canonicalKey?: string;
  /** For split date fields (Day / Month / Year selects). */
  part?: DatePart;
  confidence: number;
  /** Plain-language explanation shown in the review list. */
  reason: string;
  source:
    | 'policy'
    | 'rule'
    | 'memory'
    | 'autocomplete'
    | 'dictionary'
    | 'custom'
    | 'options'
    | 'ai'
    | 'profile'
    | 'none';
  /** How to ask the user for this field (AI classifications may phrase it better than the label). */
  question?: string;
}

export interface MapContext {
  site: string;
  memory?: ReadonlyMap<string, FieldMemory>;
  /** Keys present in the vault: lets the mapper reuse custom facts and pick list indexes. */
  factKeys?: ReadonlySet<string>;
  /** Vault values for list-item keys (e.g. languages[1].language → "Hindi"), for index matching. */
  factValues?: ReadonlyMap<string, string>;
  dictionary?: CompiledDictionary;
  policy?: Policy;
}

const GROUP_TYPES = new Set(['radio', 'checkbox-group', 'aria-radiogroup', 'aria-checkbox-group']);
const SELECT_TYPES = new Set(['select-one', 'select-multiple', 'aria-listbox', 'aria-combobox']);
const MULTILINE_TYPES = new Set(['textarea', 'contenteditable', 'aria-textbox']);
const SINGLE_CHECK = new Set(['checkbox', 'aria-checkbox']);

/** Keys whose best answer depends on the goal (a pitch, not a fact): treated as open-ended. */
const GOAL_DEPENDENT_KEYS = new Set(['bio.summary_short', 'bio.summary_long']);

const OTHER_TEXT =
  /^(?:other|others|other response|other please specify|please specify|if other(?: please specify)?|specify other)$/;
const PROMO = /\b(?:referral|promo|coupon|discount|voucher|invite|invitation)\s*(?:code|id)?\b/;

const AUTOCOMPLETE: Record<string, string> = {
  name: 'person.name.full',
  'given-name': 'person.name.first',
  'additional-name': 'person.name.middle',
  'family-name': 'person.name.last',
  nickname: 'person.name.display',
  username: 'person.name.display',
  email: 'contact.email',
  tel: 'contact.phone.mobile',
  'tel-national': 'contact.phone.mobile',
  'tel-local': 'contact.phone.mobile',
  'street-address': 'address.line1',
  'address-line1': 'address.line1',
  'address-line2': 'address.line2',
  'address-level3': 'address.district',
  'address-level2': 'address.city',
  'address-level1': 'address.state',
  'postal-code': 'address.postal_code',
  country: 'address.country',
  'country-name': 'address.country',
  bday: 'person.dob',
  sex: 'person.gender',
  url: 'links.website',
  organization: 'experience[].company',
  'organization-title': 'experience[].title',
};
const AUTOCOMPLETE_PARTS: Record<string, DatePart> = {
  'bday-day': 'day',
  'bday-month': 'month',
  'bday-year': 'year',
};

const DATE_PART = /^(?:day|dd|date|month|mm|mon|year|yyyy|yy)$/;
const partOf = (label: string): DatePart | undefined => {
  if (/^(?:day|dd|date)$/.test(label)) return 'day';
  if (/^(?:month|mm|mon)$/.test(label)) return 'month';
  if (/^(?:year|yyyy|yy)$/.test(label)) return 'year';
  return undefined;
};

interface Candidate {
  key: string;
  score: number;
  via: string;
}

function textsOf(field: FieldDescriptor) {
  const ident = (v?: string) =>
    v && !isDynamicIdentifier(v)
      ? normaliseLabel(humaniseIdentifier(v.replace(/\[\d*\]/g, ' ')))
      : '';
  return {
    label: normaliseLabel(field.label),
    placeholder: field.placeholder ? normaliseLabel(field.placeholder) : '',
    name: ident(field.name),
    id: ident(field.domId),
    section: field.sectionHeading ? normaliseLabel(field.sectionHeading) : '',
  };
}

/** Best dictionary match. Scores 0.6–1.0 by how much of the text the pattern covers; context matches get a bonus. */
function dictionaryMatch(field: FieldDescriptor, dict: CompiledDictionary): Candidate | null {
  const t = textsOf(field);
  const sources: Array<[string, string, number]> = [
    [t.label, 'label', 1],
    [t.placeholder, 'placeholder', 0.85],
    [t.name, 'name', 0.8],
    [t.id, 'id', 0.75],
  ];
  const contextText = `${t.section} ${t.label}`;
  let best: Candidate | null = null;

  const consider = (
    key: string,
    re: RegExp,
    text: string,
    via: string,
    factor: number,
    bonus: number,
  ) => {
    const m = re.exec(text);
    if (!m) return;
    const coverage = m[0].trim().length / Math.max(text.length, 1);
    const score = (0.6 + 0.4 * coverage) * factor + bonus;
    if (!best || score > best.score) best = { key, score, via };
  };

  for (const entry of dict.entries) {
    const groupRe = entry.group ? dict.groupContext.get(entry.group) : undefined;
    const inGroupContext = groupRe ? groupRe.test(contextText) : false;
    for (const [text, via, factor] of sources) {
      if (!text) continue;
      for (const re of entry.patterns)
        consider(entry.key, re, text, via, factor, inGroupContext ? 0.15 : 0);
      if (inGroupContext)
        for (const re of entry.contextPatterns)
          consider(entry.key, re, text, `${via}+section`, factor, 0.15);
    }
  }
  return best;
}

const GROUP_WORDS: Record<ListGroup, string> = {
  education: 'education|qualification|degree|school|college',
  experience: 'experience|employment|job|work|company|position|employer',
  projects: 'project',
  certifications: 'certification|certificate',
  languages: 'language',
};

/**
 * Explicit list index: from the name (`education[1][degree]`, `edu_2_name`),
 * or a number right next to the group word in the label or section
 * ("Education 2", "Project 2 title", "Language #3"). A bare number elsewhere
 * ("Step 2 of 3") does not count.
 */
function explicitIndex(field: FieldDescriptor, group: ListGroup): number | undefined {
  const fromName = /\[(\d+)\]|[_-](\d+)(?:[_-]|$)/.exec(field.name ?? '');
  if (fromName) return Number(fromName[1] ?? fromName[2]);
  const re = new RegExp(`\\b(?:${GROUP_WORDS[group]})s?\\s*#?\\s*(\\d{1,2})\\b`, 'i');
  for (const text of [field.sectionHeading ?? '', field.label]) {
    const m = re.exec(text);
    const n = m ? Number(m[1]) : NaN;
    if (n >= 1 && n <= 20) return n - 1;
  }
  return undefined;
}

/** For "English proficiency" style labels: the index of the vault language named in the label. */
function languageIndex(field: FieldDescriptor, ctx: MapContext): number | undefined {
  if (!ctx.factValues) return undefined;
  const label = normaliseLabel(field.label);
  for (const [key, value] of ctx.factValues) {
    const parsed = parseKey(key);
    if (parsed?.template !== 'languages[].language' || parsed.index === undefined) continue;
    const name = normaliseLabel(value);
    if (
      name &&
      new RegExp(`(?:^|\\s)${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:\\s|$)`).test(label)
    )
      return parsed.index;
  }
  return undefined;
}

const COUNTRIES =
  /^(?:india|united states|united kingdom|canada|australia|germany|france|japan|china|singapore|united arab emirates|brazil|nepal|bangladesh|sri lanka)$/;
const STATES =
  /^(?:maharashtra|karnataka|gujarat|tamil nadu|kerala|delhi|uttar pradesh|west bengal|rajasthan|telangana|andhra pradesh|punjab|haryana|madhya pradesh|bihar|goa)$/;
const MONTHS =
  /^(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)$/;

/** Recognises well-known option sets (countries, states, genders, language levels). */
function optionsMatch(field: FieldDescriptor): { key: string; part?: DatePart } | null {
  const texts = (field.options ?? []).map((o) => normaliseLabel(o.text));
  if (texts.length < 2) return null;
  const share = (re: RegExp) => texts.filter((t) => re.test(t)).length / texts.length;
  if (texts.filter((t) => COUNTRIES.test(t)).length >= 5) return { key: 'address.country' };
  if (texts.filter((t) => STATES.test(t)).length >= 5) return { key: 'address.state' };
  if (share(/^(?:male|female|other|non binary|prefer not to say|man|woman)$/) >= 0.66)
    return { key: 'person.gender' };
  if (
    share(
      /^(?:basic|beginner|elementary|conversational|intermediate|fluent|advanced|native(?: or bilingual| bilingual)?|bilingual|professional)$/,
    ) >= 0.75
  )
    return { key: 'languages[].proficiency' };
  if (texts.length >= 12 && share(MONTHS) >= 0.9) return { key: '', part: 'month' };
  return null;
}

function kindFor(field: FieldDescriptor, key: string | undefined): FieldKind {
  if (GROUP_TYPES.has(field.inputType)) return 'choice';
  if (SELECT_TYPES.has(field.inputType)) return key ? 'fact' : 'choice';
  if (key && GOAL_DEPENDENT_KEYS.has(key)) return 'open_ended';
  if (!key && MULTILINE_TYPES.has(field.inputType)) return 'open_ended';
  return 'fact';
}

function result(
  field: FieldDescriptor,
  key: string | undefined,
  confidence: number,
  source: MapResult['source'],
  reason: string,
  part?: DatePart,
): MapResult {
  return {
    kind: kindFor(field, key),
    ...(key ? { canonicalKey: key } : {}),
    ...(part ? { part } : {}),
    confidence: Math.min(1, Math.round(confidence * 100) / 100),
    reason,
    source,
  };
}

const describeKey = (key: string) =>
  getKeyDef(key)?.label ?? key.replace(/^custom\./, '').replace(/_/g, ' ');

const KIND_WORDS: Record<FieldKind, string> = {
  fact: 'a detail about you',
  open_ended: 'a question to answer in your own words',
  choice: 'a choice for you to make',
  skip: 'not needed',
  denied: 'never filled',
};

/** Index for a single field mapped on its own: explicit numbering, else the first item. */
export function concreteKeyFor(template: string, field: FieldDescriptor): string {
  if (!template.includes('[]')) return template;
  return defaultIndex(template, field);
}

function defaultIndex(template: string, field: FieldDescriptor): string {
  const group = template.split('[')[0] as ListGroup;
  return template.replace('[]', `[${explicitIndex(field, group) ?? 0}]`);
}

/** Maps one field. `withIndex` turns `group[]` templates into concrete keys. */
export function mapField(
  field: FieldDescriptor,
  ctx: MapContext,
  withIndex: (template: string, field: FieldDescriptor) => string = defaultIndex,
): MapResult {
  const risk = (ctx.policy ?? { classifyRisk }).classifyRisk(field);
  if (!risk.allowed)
    return { kind: 'denied', confidence: 1, reason: risk.reason, source: 'policy' };

  const t = textsOf(field);
  if (field.inputType === 'file')
    return {
      kind: 'skip',
      confidence: 1,
      reason: 'Filler never attaches files. Attach it yourself.',
      source: 'rule',
    };
  if (SINGLE_CHECK.has(field.inputType)) {
    return {
      kind: 'skip',
      confidence: 1,
      reason: 'Checkboxes like this are your decision, so Filler leaves them to you.',
      source: 'rule',
    };
  }
  if (OTHER_TEXT.test(t.label))
    return {
      kind: 'skip',
      confidence: 0.9,
      reason: 'Only needed if you pick "Other".',
      source: 'rule',
    };
  if (PROMO.test(t.label) || PROMO.test(t.placeholder))
    return {
      kind: 'skip',
      confidence: 0.9,
      reason: 'Optional code. Add one yourself if you have it.',
      source: 'rule',
    };

  const finish = (m: MapResult): MapResult =>
    field.isDisabled
      ? { ...m, kind: 'skip', reason: 'This field is disabled on the page.', confidence: 1 }
      : m;

  // 1. Field memory: this exact field, answered before (or understood by the AI before).
  const memory = ctx.memory?.get(field.signature);
  if (memory?.via === 'ai') {
    const kind = memory.kind ?? kindFor(field, memory.canonicalKey);
    return finish({
      kind,
      ...(memory.canonicalKey ? { canonicalKey: memory.canonicalKey } : {}),
      confidence: 0.8,
      reason: memory.canonicalKey
        ? `Understood earlier by Filler's AI: ${describeKey(memory.canonicalKey)}`
        : `Understood earlier by Filler's AI: ${KIND_WORDS[kind]}`,
      source: 'memory',
    });
  }
  if (memory?.canonicalKey) {
    return finish(
      result(
        field,
        memory.canonicalKey,
        0.99,
        'memory',
        `Remembered from last time: ${describeKey(memory.canonicalKey)}`,
      ),
    );
  }

  // 2. HTML autocomplete hints.
  const tokens = (field.autocomplete ?? '').toLowerCase().split(/\s+/);
  for (const token of tokens) {
    const part = AUTOCOMPLETE_PARTS[token];
    if (part)
      return finish(
        result(
          field,
          'person.dob',
          0.95,
          'autocomplete',
          `The page marks this as birth ${part}`,
          part,
        ),
      );
    const key = AUTOCOMPLETE[token];
    if (key) {
      const concrete = key.includes('[]') ? withIndex(key, field) : key;
      return finish(
        result(field, concrete, 0.95, 'autocomplete', `The page marks this field as "${token}"`),
      );
    }
  }

  const dict = ctx.dictionary ?? defaultDictionary();

  // 3. The user's own custom facts with exactly this label (an answer they gave before, anywhere).
  const custom = customKeyFor(field.label);
  if (ctx.factKeys?.has(custom)) {
    return finish(
      result(field, custom, 0.9, 'custom', `Matches your saved "${describeKey(custom)}"`),
    );
  }

  // 4a. Split dates: "Day" / "Month" / "Year" under a heading like "Date of birth".
  if (DATE_PART.test(t.label) && t.section) {
    const sectionMatch = dictionaryMatch(
      {
        ...field,
        label: field.sectionHeading ?? '',
        placeholder: undefined,
        name: undefined,
        domId: undefined,
      },
      dict,
    );
    const def = sectionMatch ? getKeyDef(sectionMatch.key) : undefined;
    if (sectionMatch && def?.valueType === 'date') {
      const key = sectionMatch.key.includes('[]')
        ? withIndex(sectionMatch.key, field)
        : sectionMatch.key;
      return finish(
        result(
          field,
          key,
          0.85,
          'dictionary',
          `${field.label} of ${def.label.toLowerCase()}`,
          partOf(t.label),
        ),
      );
    }
  }

  // 4b. Dictionary.
  const hit = dictionaryMatch(field, dict);
  if (hit && hit.score >= 0.6) {
    const key = hit.key.includes('[]') ? withIndex(hit.key, field) : hit.key;
    return finish(
      result(
        field,
        key,
        Math.min(0.95, hit.score),
        'dictionary',
        `Looks like ${describeKey(hit.key).toLowerCase()} (from the ${hit.via.replace('+section', ' and section heading')})`,
      ),
    );
  }

  // 5. Option sets.
  const byOptions = optionsMatch(field);
  if (byOptions?.key) {
    const key = byOptions.key.includes('[]') ? withIndex(byOptions.key, field) : byOptions.key;
    return finish(
      result(
        field,
        key,
        0.75,
        'options',
        `Its options look like ${describeKey(byOptions.key).toLowerCase()} values`,
      ),
    );
  }

  return finish(result(field, undefined, 0, 'none', 'Filler does not know this field yet.'));
}

/**
 * Maps every field on a page. List indexes come from explicit numbering
 * (name `[1]`, "Education 2"), a vault language named in the label, or
 * document order among fields of the same list template.
 */
export function mapFields(fields: FieldDescriptor[], ctx: MapContext): Map<string, MapResult> {
  const counters = new Map<string, number>();
  const instanceOf = new Map<string, number>(); // `${group}|${section}` → index
  const results = new Map<string, MapResult>();
  for (const field of fields) {
    const withIndex = (template: string, f: FieldDescriptor): string => {
      const group = template.split('[')[0] as ListGroup;
      let index = template === 'languages[].proficiency' ? languageIndex(f, ctx) : undefined;
      index ??= explicitIndex(f, group);
      if (index === undefined) {
        // Fields of one list item share a section; a new section (or a repeat of a field) is the next item.
        const scope = `${group}|${f.sectionHeading ?? ''}`;
        const seen = instanceOf.get(scope);
        const repeat = `${template}|${f.sectionHeading ?? ''}`;
        const repeats = counters.get(repeat) ?? 0;
        counters.set(repeat, repeats + 1);
        if (seen === undefined) {
          const next = [...instanceOf.entries()].filter(([k]) => k.startsWith(`${group}|`)).length;
          instanceOf.set(scope, next);
          index = next;
        } else {
          index = seen + repeats;
        }
      }
      return template.replace('[]', `[${index}]`);
    };
    results.set(field.id, mapField(field, ctx, withIndex));
  }
  return results;
}
