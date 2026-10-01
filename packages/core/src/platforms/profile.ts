/**
 * Platform profiles (PLAYBOOK Tasks 11.2–11.3). Filler works on any site with
 * no profile at all; a profile only *adds*: higher confidence for fields a
 * family of sites always phrases the same way, length windows, tips,
 * tone/audience defaults, and extra button texts never to click.
 *
 * Rules a profile can never break:
 *  - it never overrides a denied field, and never maps a field the policy refuses;
 *  - it overrides a mapping only when its rule is more confident;
 *  - its navigation list can only add never-click texts, never allow a click.
 */
import { z } from 'zod';
import type { MapResult } from '../mapper/map';
import { classifyRisk, type Policy } from '../policy/deny';
import { getKeyDef, isValidFactKey } from '../schema/keys';
import type { FieldDescriptor, FieldKind } from '../schema/records';
import { normaliseLabel, siteOf } from '../text/normalise';

export const PLATFORM_FAMILIES = [
  'freelance',
  'jobs',
  'forms',
  'events',
  'personal_details',
] as const;
export type PlatformFamily = (typeof PLATFORM_FAMILIES)[number];

const regex = z
  .string()
  .min(1)
  .max(300)
  .refine(
    (s) => {
      try {
        new RegExp(s, 'iu');
        return true;
      } catch {
        return false;
      }
    },
    { message: 'Not a valid regular expression' },
  );

const key = z
  .string()
  .refine((k) => isValidFactKey(k) || Boolean(getKeyDef(k)), { message: 'Not a canonical key' });

export const PlatformProfileSchema = z
  .object({
    id: z
      .string()
      .regex(/^[a-z0-9-]+$/)
      .max(60),
    name: z.string().min(1).max(80),
    family: z.enum(PLATFORM_FAMILIES),
    /** Site-specific profiles win over family ones on the same page. */
    specific: z.boolean().default(false),
    match: z
      .object({
        /** Hosts (and their subdomains), e.g. "upwork.com", "myworkdayjobs.com". */
        hosts: z.array(z.string().min(3).max(253)).max(40).default([]),
        /** Content signals (page title, headings, labels) for sites with no host rule. */
        signals: z.array(regex).max(30).default([]),
        minSignals: z.number().int().min(1).max(10).default(2),
      })
      .strict(),
    fields: z
      .array(
        z
          .object({
            label: regex,
            section: regex.optional(),
            canonicalKey: key.optional(),
            kind: z.enum(['fact', 'open_ended', 'choice', 'skip']).optional(),
            confidence: z.number().min(0).max(1),
            /** Characters the platform rewards, e.g. an overview of 1,000–5,000. */
            lengthWindow: z
              .tuple([z.number().int().nonnegative(), z.number().int().positive()])
              .optional(),
            tip: z.string().max(200).optional(),
          })
          .strict(),
      )
      .max(80)
      .default([]),
    wizardSteps: z.array(z.string().max(80)).max(20).default([]),
    navigation: z
      .object({ neverClick: z.array(z.string().min(1).max(80)).max(40).default([]) })
      .strict()
      .default({ neverClick: [] }),
    goal: z
      .object({ tone: z.string().max(100).optional(), audience: z.string().max(300).optional() })
      .strict()
      .default({}),
    tips: z.array(z.string().max(240)).max(8).default([]),
  })
  .strict();
export type PlatformProfile = z.infer<typeof PlatformProfileSchema>;

export interface CompiledProfile {
  profile: PlatformProfile;
  signals: RegExp[];
  fields: Array<PlatformProfile['fields'][number] & { labelRe: RegExp; sectionRe?: RegExp }>;
}

/** Validates and compiles profiles. Throws on a malformed one (config errors must not pass silently). */
export function compileProfiles(raw: readonly unknown[]): CompiledProfile[] {
  const seen = new Set<string>();
  return raw.map((r, i) => {
    const parsed = PlatformProfileSchema.safeParse(r);
    if (!parsed.success)
      throw new Error(
        `Platform profile #${i + 1} is invalid: ${parsed.error.issues.map((x) => `${x.path.join('.')}: ${x.message}`).join('; ')}`,
      );
    const p = parsed.data;
    if (seen.has(p.id)) throw new Error(`Duplicate platform profile id "${p.id}"`);
    seen.add(p.id);
    return {
      profile: p,
      signals: p.match.signals.map((s) => new RegExp(s, 'iu')),
      fields: p.fields.map((f) => ({
        ...f,
        labelRe: new RegExp(f.label, 'iu'),
        ...(f.section ? { sectionRe: new RegExp(f.section, 'iu') } : {}),
      })),
    };
  });
}

export interface PageInfo {
  url: string;
  title: string;
  fields: ReadonlyArray<Pick<FieldDescriptor, 'label' | 'sectionHeading'>>;
}

export interface Detected {
  profile: CompiledProfile;
  /** How it was found: by the site's address, or by what the page says. */
  by: 'host' | 'content';
  score: number;
}

const hostMatches = (host: string, pattern: string) => {
  const p = siteOf(pattern);
  return host === p || host.endsWith(`.${p}`);
};

/** The best profile for a page, or none (the generic fallback). */
export function detectProfile(
  profiles: readonly CompiledProfile[],
  page: PageInfo,
): Detected | undefined {
  const host = siteOf(page.url);
  const byHost = profiles
    .filter((c) => c.profile.match.hosts.some((h) => hostMatches(host, h)))
    .sort((a, b) => Number(b.profile.specific) - Number(a.profile.specific));
  if (byHost[0]) return { profile: byHost[0], by: 'host', score: 1 };
  const texts = [page.title, ...page.fields.flatMap((f) => [f.label, f.sectionHeading ?? ''])]
    .map((t) => normaliseLabel(t))
    .filter(Boolean);
  let best: Detected | undefined;
  for (const c of profiles) {
    if (!c.signals.length) continue;
    const hits = c.signals.filter((re) => texts.some((t) => re.test(t))).length;
    if (hits >= c.profile.match.minSignals && (!best || hits > best.score))
      best = { profile: c, by: 'content', score: hits };
  }
  return best;
}

export interface FieldConstraint {
  lengthWindow?: [number, number];
  tip?: string;
}

const RADIOISH = new Set(['radio', 'checkbox-group', 'aria-radiogroup', 'aria-checkbox-group']);

/**
 * Applies a profile to mapper results. Returns new mappings (only where the
 * profile is more confident) and per-field constraints (length windows, tips).
 */
export function applyProfile(
  compiled: CompiledProfile,
  fields: readonly FieldDescriptor[],
  mappings: Readonly<Record<string, MapResult>>,
  policy: Pick<Policy, 'classifyRisk'> = { classifyRisk },
): { mappings: Record<string, MapResult>; constraints: Record<string, FieldConstraint> } {
  const out: Record<string, MapResult> = { ...mappings };
  const constraints: Record<string, FieldConstraint> = {};
  for (const field of fields) {
    const current = mappings[field.id];
    if (!current || current.kind === 'denied' || !policy.classifyRisk(field).allowed) continue;
    const label = normaliseLabel(field.label);
    const section = normaliseLabel(field.sectionHeading ?? '');
    const rule = compiled.fields.find(
      (r) => r.labelRe.test(label) && (!r.sectionRe || r.sectionRe.test(section)),
    );
    if (!rule) continue;
    if (rule.lengthWindow || rule.tip)
      constraints[field.id] = {
        ...(rule.lengthWindow ? { lengthWindow: rule.lengthWindow } : {}),
        ...(rule.tip ? { tip: rule.tip } : {}),
      };
    const stronger = current.source === 'none' || rule.confidence > current.confidence;
    if (!stronger || (!rule.canonicalKey && !rule.kind)) continue;
    let kind: FieldKind = rule.kind ?? current.kind;
    if (kind !== 'skip' && RADIOISH.has(field.inputType)) kind = 'choice';
    // A kind-only rule (e.g. "Category is a choice") also drops a key the rules misread.
    const keyFor = rule.canonicalKey
      ? rule.canonicalKey.replace(
          '[]',
          `[${/\[(\d+)\]/.exec(current.canonicalKey ?? '')?.[1] ?? 0}]`,
        )
      : rule.kind
        ? undefined
        : current.canonicalKey;
    out[field.id] = {
      kind,
      ...(keyFor && kind !== 'skip' ? { canonicalKey: keyFor } : {}),
      confidence: rule.confidence,
      reason: `${compiled.profile.name}: ${rule.tip ?? 'this platform always asks it this way'}`,
      source: 'profile',
    };
  }
  return { mappings: out, constraints };
}

/** True when a button text is on a profile's never-click list (adds to the built-in submit rules). */
export function neverClickByProfile(
  profile: { navigation: { neverClick: readonly string[] } } | undefined,
  text: string,
): boolean {
  if (!profile) return false;
  const t = normaliseLabel(text);
  return profile.navigation.neverClick.some((n) => normaliseLabel(n) === t);
}
