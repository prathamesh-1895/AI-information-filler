/**
 * User settings (PLAYBOOK Task 6.4). Nothing here is secret, so it lives in
 * chrome.storage.local. Vault contents never go here.
 */
import { siteOf } from '@filler/core';
import { z } from 'zod';

const fields = {
  /** Minutes of inactivity before the vault locks; 0 = never. */
  autoLockMinutes: z
    .number()
    .int()
    .min(0)
    .max(24 * 60),
  /** Keep the vault unlocked until the browser closes (key held in chrome.storage.session). */
  stayUnlockedForSession: z.boolean(),
  /** How values are typed into pages. */
  typingMode: z.enum(['auto', 'typing']),
  /** Sites where values from the vault are approved automatically (never AI text). */
  trustedSites: z.array(z.string().min(1).max(253)).max(200),
  /** Outline fields on the page during a session. */
  highlight: z.boolean(),
  /** Language for AI-written answers (used from Phase 9). */
  answerLanguage: z.enum(['English', 'Hindi', 'Marathi']),
  /** Extra phrases Filler must never fill, on top of the built-in list. */
  denyPatterns: z.array(z.string().trim().min(1).max(200)).max(200),
  theme: z.enum(['system', 'light', 'dark']),
};

export const SettingsSchema = z.object(fields);
export type Settings = z.infer<typeof SettingsSchema>;

/** A partial update from the panel. No defaults: missing keys stay as they are. */
export const SettingsPatchSchema = z.object(fields).partial().strict();
export type SettingsPatch = z.infer<typeof SettingsPatchSchema>;

export const DEFAULT_SETTINGS: Settings = {
  autoLockMinutes: 15,
  stayUnlockedForSession: false,
  typingMode: 'auto',
  trustedSites: [],
  highlight: true,
  answerLanguage: 'English',
  denyPatterns: [],
  theme: 'system',
};

const STORAGE_KEY = 'filler.settings';

/** Merges stored settings over the defaults, dropping anything invalid. */
export function mergeSettings(stored: unknown): Settings {
  const merged: Record<string, unknown> = { ...DEFAULT_SETTINGS };
  if (stored && typeof stored === 'object') {
    for (const [key, schema] of Object.entries(fields)) {
      const value = (stored as Record<string, unknown>)[key];
      if (value !== undefined && schema.safeParse(value).success) merged[key] = value;
    }
  }
  return SettingsSchema.parse(merged);
}

export async function loadSettings(): Promise<Settings> {
  return mergeSettings((await browser.storage.local.get(STORAGE_KEY))[STORAGE_KEY]);
}

export async function saveSettings(patch: SettingsPatch): Promise<Settings> {
  const next = mergeSettings({ ...(await loadSettings()), ...SettingsPatchSchema.parse(patch) });
  next.trustedSites = [...new Set(next.trustedSites.map(siteOf))];
  next.denyPatterns = [...new Set(next.denyPatterns)];
  await browser.storage.local.set({ [STORAGE_KEY]: next });
  return next;
}

export const isTrusted = (settings: Settings, site: string) =>
  settings.trustedSites.includes(siteOf(site));
