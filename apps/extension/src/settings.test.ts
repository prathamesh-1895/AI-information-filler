import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS, isTrusted, mergeSettings, SettingsPatchSchema } from './settings';

describe('settings', () => {
  it('fills defaults and drops invalid stored values one by one', () => {
    expect(mergeSettings(undefined)).toEqual(DEFAULT_SETTINGS);
    expect(
      mergeSettings({ highlight: false, autoLockMinutes: -5, typingMode: 'warp', junk: 1 }),
    ).toEqual({
      ...DEFAULT_SETTINGS,
      highlight: false,
    });
  });

  it('patches never reset other settings to defaults', () => {
    const patch = SettingsPatchSchema.parse({ highlight: false });
    expect(patch).toEqual({ highlight: false });
    expect(SettingsPatchSchema.safeParse({ unknownSetting: true }).success).toBe(false);
  });

  it('matches trusted sites by host, ignoring www', () => {
    const s = { ...DEFAULT_SETTINGS, trustedSites: ['upwork.com'] };
    expect(isTrusted(s, 'https://www.upwork.com/nx/profile')).toBe(true);
    expect(isTrusted(s, 'fiverr.com')).toBe(false);
  });
});
