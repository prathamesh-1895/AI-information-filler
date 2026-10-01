/**
 * `generate` wire contract and the draft checks (PLAYBOOK Task 9.2), shared
 * by the Edge Function and the client. A draft must:
 *  - fit the field (maxLength, and exactly one allowed option for choices);
 *  - only cite facts that were sent;
 *  - invent nothing: every proper noun and number in it must appear in what
 *    Filler sent (facts, filled values, goal, the question, earlier answers,
 *    the user's hint);
 *  - contain no links the user did not provide.
 */
import { z } from 'zod';
import { AiFieldSchema, AiUsageSchema } from './contract';

export const GENERATE_PROMPT_VERSION = 'generate-v1';

const text = (max: number) => z.string().max(max);

export const GenerateFieldSchema = AiFieldSchema.extend({
  options: z.array(text(200)).max(100).optional(),
  /** The length the platform rewards (from a platform profile), e.g. [1000, 5000]. */
  lengthWindow: z.tuple([z.number().int().nonnegative(), z.number().int().positive()]).optional(),
});

export const GenerateGoalSchema = z
  .object({
    text: text(500).optional(),
    platform: text(253).optional(),
    role: text(200).optional(),
    audience: text(300).optional(),
    tone: text(100).optional(),
    language: text(50).optional(),
  })
  .strict();
export type GenerateGoal = z.infer<typeof GenerateGoalSchema>;

const FactEntrySchema = z
  .object({ key: text(80), value: z.union([text(4_000), z.array(text(500)).max(60)]) })
  .strict();

export const GenerateRequestSchema = z
  .object({
    field: GenerateFieldSchema,
    page: z.object({ host: text(253) }).strict(),
    goal: GenerateGoalSchema,
    /** The selected facts (public only, chosen on the device). */
    facts: z.array(FactEntrySchema).max(60),
    /** Values already used in this session, for consistency. */
    filled: z.array(FactEntrySchema).max(40),
    /** Up to three approved answers to similar questions, for style. */
    examples: z.array(z.object({ question: text(500), answer: text(6_000) }).strict()).max(3),
    /** The user's instruction for a regenerate ("shorter", "mention my GST project"). */
    hint: text(300).optional(),
  })
  .strict();
export type GenerateRequest = z.infer<typeof GenerateRequestSchema>;

/** What the model must return. */
export const DraftOutputSchema = z
  .object({
    value: z.string().max(20_000),
    alternatives: z.array(z.string().max(20_000)).max(2),
    usedFacts: z.array(z.string().max(80)).max(60),
    needsInput: z.array(z.string().max(200)).max(3),
  })
  .strict();
export type DraftOutput = z.infer<typeof DraftOutputSchema>;

export const GenerateResponseSchema = z.object({
  /** Absent when the AI needs more information or could not write a safe draft. */
  value: z.string().optional(),
  alternatives: z.array(z.string()),
  usedFacts: z.array(z.string()),
  needsInput: z.array(z.string()),
  charCount: z.number().int().nonnegative(),
  /** Why no draft came back, when that happens. */
  problem: z.string().optional(),
  provider: z.string().nullable(),
  usage: AiUsageSchema,
});
export type GenerateResponse = z.infer<typeof GenerateResponseSchema>;

// ------------------------------------------------------------------ checks

/** Capitalised words that are not names. */
const COMMON = new Set(
  `i i'm i've i'd i'll im ive a an the my me we our you your he she they it this that these those
  and or but so if as at by for from in into of on to with without over under about after before
  hi hello dear thanks thank regards sincerely best yes no also then there here what why how when
  where who which while since because although though however therefore moreover furthermore
  currently today now recently previously together additionally besides finally firstly secondly
  monday tuesday wednesday thursday friday saturday sunday january february march april may june
  july august september october november december english hindi marathi
  clients customers businesses teams companies people projects results every each many most some all
  one two three both whether let start outside beyond within across through during until unless
  just only still even well good great strong small large new key core plus`.split(/\s+/),
);

const SENTENCE_START = /(?:^|[.!?:;]\s+|\n\s*|[-•*]\s+|"\s*)$/;

/** Endings of ordinary words that often open a sentence ("Helping", "Recently", "Clients"). */
const ORDINARY_ENDING =
  /(?:ing|ed|ly|ness|ment|ments|tion|tions|sion|ers|ies|ful|ous|ive|able|ally)$/i;

/**
 * Proper-noun-like tokens: capitalised words, acronyms and numbers. A
 * capitalised word that opens a sentence only counts when it does not look
 * like an ordinary word ("Google hired me" counts, "Helping clients" does
 * not). Hyphenated parts are checked on their own ("Ex-Microsoft").
 */
export function claimsIn(value: string): string[] {
  const out = new Set<string>();
  const re = /[A-Za-z][A-Za-z0-9&+#.'’]*|\d+(?:[.,]\d+)*%?/g;
  for (const m of value.matchAll(re)) {
    const raw = m[0].replace(/[.'’]+$/, '').replace(/['’]s$/, '');
    const before = value.slice(0, m.index);
    if (/^\d/.test(raw)) {
      out.add(raw.replace(/%$/, ''));
      continue;
    }
    const isAcronym = /^[A-Z0-9&+#.]{2,}$/.test(raw) && /[A-Z]/.test(raw);
    if (!isAcronym && !/^[A-Z]/.test(raw)) continue;
    if (COMMON.has(raw.toLowerCase())) continue;
    const afterHyphen = /-$/.test(before);
    if (!isAcronym && !afterHyphen && SENTENCE_START.test(before) && ORDINARY_ENDING.test(raw))
      continue;
    if (!isAcronym && !afterHyphen && SENTENCE_START.test(before) && raw.length <= 3) continue;
    out.add(raw);
  }
  return [...out];
}

/** All the text Filler sent: anything a draft says must come from here. */
export function sourceText(req: GenerateRequest): string {
  const values = (entries: GenerateRequest['facts']) =>
    entries.map((f) => (Array.isArray(f.value) ? f.value.join(' ') : f.value));
  return [
    req.field.label,
    req.field.helpText ?? '',
    req.field.placeholder ?? '',
    req.field.sectionHeading ?? '',
    ...(req.field.options ?? []),
    ...Object.values(req.goal),
    req.page.host,
    req.hint ?? '',
    ...values(req.facts),
    ...values(req.filled),
    ...req.examples.flatMap((e) => [e.question, e.answer]),
  ].join('\n');
}

const fold = (s: string) => s.toLowerCase().replace(/[’']/g, "'");

/** Claims in `value` that appear nowhere in what was sent (case-insensitive, word-bounded). */
export function inventedClaims(value: string, source: string): string[] {
  const haystack = fold(source);
  return claimsIn(value).filter((claim) => {
    const needle = fold(claim).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return !new RegExp(`(?:^|[^a-z0-9])${needle}(?:$|[^a-z0-9])`).test(haystack);
  });
}

const URL_RE = /\bhttps?:\/\/\S+|\bwww\.\S+/gi;

export type DraftCheck = { ok: true; value: string } | { ok: false; problems: string[] };

/** Checks one draft text against the request. Choice values are normalised to the exact option. */
export function checkDraft(value: string, req: GenerateRequest): DraftCheck {
  const problems: string[] = [];
  let out = value.trim();
  if (!out) return { ok: false, problems: ['empty draft'] };
  const options = req.field.options ?? [];
  if (options.length) {
    const match = options.find((o) => o.trim().toLowerCase() === out.toLowerCase());
    if (!match) problems.push(`"${out.slice(0, 60)}" is not one of the allowed options`);
    else out = match;
  }
  const max = req.field.maxLength;
  if (max !== undefined && out.length > max)
    problems.push(`too long: ${out.length} characters, the field allows ${max}`);
  const source = sourceText(req);
  const invented = inventedClaims(out, source);
  if (invented.length)
    problems.push(`mentions things not in the facts: ${invented.slice(0, 6).join(', ')}`);
  const links = (out.match(URL_RE) ?? []).filter((u) => !source.includes(u.replace(/[).,]+$/, '')));
  if (links.length) problems.push('contains a link the person did not provide');
  return problems.length ? { ok: false, problems } : { ok: true, value: out };
}

export interface CheckedDraft {
  value?: string;
  alternatives: string[];
  usedFacts: string[];
  needsInput: string[];
  /** Problems with the main value, when it was rejected. */
  problems: string[];
}

/**
 * Checks a whole model reply: the main value, each alternative (bad ones are
 * dropped; a good alternative is promoted if the main value fails), and the
 * cited facts (only keys that were sent).
 */
export function checkDraftOutput(out: DraftOutput, req: GenerateRequest): CheckedDraft {
  const sent = new Set(req.facts.map((f) => f.key));
  const usedFacts = [...new Set(out.usedFacts.filter((k) => sent.has(k)))];
  const needsInput = out.needsInput
    .map((q) => q.trim())
    .filter(Boolean)
    .slice(0, 3);
  const main = out.value.trim() ? checkDraft(out.value, req) : null;
  const alternatives = out.alternatives
    .map((a) => checkDraft(a, req))
    .flatMap((c) => (c.ok ? [c.value] : []));
  if (main?.ok)
    return {
      value: main.value,
      alternatives: alternatives.filter((a) => a !== main.value),
      usedFacts,
      needsInput,
      problems: [],
    };
  const [promoted, ...rest] = alternatives;
  return {
    ...(promoted ? { value: promoted } : {}),
    alternatives: rest,
    usedFacts,
    needsInput,
    problems: main && !main.ok ? main.problems : [],
  };
}
