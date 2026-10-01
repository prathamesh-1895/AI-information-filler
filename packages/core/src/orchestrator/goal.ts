/**
 * Goal intelligence (PLAYBOOK Task 9.4): free text → a structured Goal, with
 * no AI. The platform comes from the page URL; role, audience and tone are
 * read from phrases like "as a business consultant", "for US small
 * businesses", "friendly". Everything stays editable in the panel, and
 * anything the user set explicitly wins.
 */
import type { Goal } from '../schema/records';
import { siteOf } from '../text/normalise';

const PLATFORMS: Array<[RegExp, string]> = [
  [/(?:^|\.)upwork\.com$/, 'Upwork'],
  [/(?:^|\.)fiverr\.com$/, 'Fiverr'],
  [/(?:^|\.)freelancer\.(?:com|in)$/, 'Freelancer'],
  [/(?:^|\.)toptal\.com$/, 'Toptal'],
  [/(?:^|\.)linkedin\.com$/, 'LinkedIn'],
  [/(?:^|\.)naukri\.com$/, 'Naukri'],
  [/(?:^|\.)indeed\.(?:com|co\.in)$/, 'Indeed'],
  [/(?:^|\.)internshala\.com$/, 'Internshala'],
  [/(?:^|\.)wellfound\.com$/, 'Wellfound'],
  [/(?:^|\.)unstop\.com$/, 'Unstop'],
  [/(?:^|\.)devfolio\.co$/, 'Devfolio'],
  [/(?:^|\.)(?:docs\.google\.com|forms\.gle)$/, 'Google Forms'],
  [/(?:^|\.)typeform\.com$/, 'Typeform'],
  [/(?:^|\.)github\.com$/, 'GitHub'],
];

/** A readable platform name for a URL or host (falls back to the host). */
export function platformOf(url: string): string | undefined {
  const host = siteOf(url);
  if (!host || /^(?:\d+\.){3}\d+$/.test(host) || host === 'localhost') return undefined;
  return PLATFORMS.find(([re]) => re.test(host))?.[1] ?? host;
}

const TONES = [
  'professional',
  'friendly',
  'confident',
  'formal',
  'casual',
  'warm',
  'concise',
  'enthusiastic',
];

const tidy = (s: string) =>
  s
    .replace(/\s+/g, ' ')
    .replace(/^[\s,;:-]+|[\s,;:.!-]+$/g, '')
    .trim();

/** Reads role, audience and tone from a free-text goal. */
export function parseGoalText(text: string): Pick<Goal, 'role' | 'targetAudience' | 'tone'> {
  const out: Pick<Goal, 'role' | 'targetAudience' | 'tone'> = {};
  const t = ` ${text.replace(/\s+/g, ' ')} `;
  const role =
    /\bas an? ([a-z][a-z /&+-]{2,60}?)(?=\s+(?:for|to|targeting|who|with|in|on|at|that)\b|[,.;!]|\s*$)/i.exec(
      t,
    ) ??
    /\b(?:i am|i'm|im) an? ([a-z][a-z /&+-]{2,60}?)(?=\s+(?:for|to|targeting|who|with|in|on|at|that)\b|[,.;!]|\s*$)/i.exec(
      t,
    );
  if (role) out.role = tidy(role[1]!);
  const audience =
    /\b(?:targeting|target|aimed at|for clients? (?:in|from|like)|for)\s+((?:[a-z0-9&-]+\s){0,6}?(?:clients?|customers?|businesses|companies|startups|smbs?|agencies|employers|recruiters|founders|brands))\b/i.exec(
      t,
    );
  if (audience) out.targetAudience = tidy(audience[1]!);
  const tone = TONES.find((w) => new RegExp(`\\b${w}\\b`, 'i').test(t));
  if (tone) out.tone = tone;
  return out;
}

/**
 * Builds the session goal: the user's explicit fields win, then what the text
 * says, then the platform from the URL. Returns undefined when there is no text.
 */
export function parseGoal(goal: Goal | undefined, url: string): Goal | undefined {
  if (!goal) return undefined;
  const parsed = parseGoalText(goal.text);
  const platform = goal.platform ?? platformOf(url);
  return {
    ...parsed,
    ...(platform ? { platform } : {}),
    ...Object.fromEntries(Object.entries(goal).filter(([, v]) => v !== undefined && v !== '')),
  } as Goal;
}
