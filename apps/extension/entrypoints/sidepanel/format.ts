/** Display helpers for the panel. */
import { getKeyDef, type FactValue, type PlanItem, type Sensitivity } from '@filler/core';
import type { Tone } from '@filler/ui';

export const keyLabel = (key: string) =>
  getKeyDef(key)?.label ??
  key
    .replace(/^custom\./, '')
    .replace(/_/g, ' ')
    .replace(/^\w/, (c) => c.toUpperCase());

/** Registry sensitivity for a key; custom keys are public. */
export const sensitivityOf = (key: string | undefined): Sensitivity =>
  (key && getKeyDef(key)?.sensitivity) || 'public';

export const asText = (value: FactValue | undefined) =>
  value === undefined ? '' : Array.isArray(value) ? value.join(', ') : value;

/** "priya@example.com" → "pr••••@example.com"; "+91 98765 43210" → "•••••••••3210". */
export function mask(value: string): string {
  const at = value.indexOf('@');
  if (at > 0) return `${value.slice(0, Math.min(2, at))}••••${value.slice(at)}`;
  if (value.length <= 4) return '••••';
  return `${'•'.repeat(Math.min(value.length - 4, 12))}${value.slice(-4)}`;
}

export const SOURCE: Record<NonNullable<PlanItem['source']>, { label: string; tone: Tone }> = {
  vault: { label: 'Vault', tone: 'green' },
  memory: { label: 'Remembered', tone: 'green' },
  user: { label: 'You', tone: 'blue' },
  ai: { label: 'AI draft', tone: 'amber' },
};

export const STATUS: Record<PlanItem['status'], { label: string; tone: Tone }> = {
  pending: { label: 'Needs approval', tone: 'neutral' },
  approved: { label: 'Approved', tone: 'blue' },
  edited: { label: 'Edited', tone: 'blue' },
  skipped: { label: 'Skipped', tone: 'neutral' },
  filled: { label: '✓ Filled', tone: 'green' },
  failed: { label: '! Failed', tone: 'red' },
};

export const PHASE: Record<string, string> = {
  IDLE: 'Not started',
  SCANNING: 'Reading the page…',
  MAPPING: 'Working out what each field asks…',
  PLANNING: 'Preparing your answers…',
  AWAITING_REVIEW: 'Ready for your review',
  FILLING: 'Filling…',
  VERIFYING: 'Checking what the page accepted…',
  READY_TO_SUBMIT: 'Done. Review the page and press Submit yourself.',
  ERROR: 'Needs your attention',
  ENDED: 'Session ended',
};

/** Passphrase strength, 0–4, from length and variety (no network, no dictionary download). */
export function passphraseStrength(p: string): { score: 0 | 1 | 2 | 3 | 4; label: string } {
  if (p.length < 8) return { score: 0, label: 'Too short' };
  let score = 0;
  if (p.length >= 12) score++;
  if (p.length >= 16) score++;
  const kinds = [/[a-z]/, /[A-Z]/, /\d/, /[^A-Za-z0-9]/].filter((re) => re.test(p)).length;
  if (kinds >= 2) score++;
  if (kinds >= 3 || /\s/.test(p.trim())) score++;
  if (/^(.)\1+$/.test(p) || /^(?:password|12345678|qwertyui)/i.test(p)) score = 0;
  const s = Math.min(4, score) as 0 | 1 | 2 | 3 | 4;
  return { score: s, label: ['Weak', 'Fair', 'Good', 'Strong', 'Very strong'][s]! };
}
