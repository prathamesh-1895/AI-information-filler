/**
 * Background-worker singletons: the encrypted vault, its repositories, the
 * session host and the current settings. Only the background worker imports
 * this module; decrypted values reach no other context except the panel
 * that displays them.
 */
import { AiClient, createAiSeam } from '@filler/ai-client';
import { createPolicy } from '@filler/core';
import { createRepositories, VaultService, type SessionKeyStore } from '@filler/vault';
import {
  endSessionTab,
  fillTab,
  highlightTab,
  observeTab,
  scanTab,
} from '../messaging/background-handler';
import type { SessionStateMessage } from '../messaging/protocol';
import {
  DEFAULT_SETTINGS,
  loadSettings,
  saveSettings,
  type Settings,
  type SettingsPatch,
} from '../settings';
import { CloudAuth } from '../cloud/auth';
import { cloudConfig, supabase } from '../cloud/supabase';
import { CloudSync } from '../cloud/sync-service';
import { SessionHost } from './host';

let settings: Settings = DEFAULT_SETTINGS;
const SESSION_KEY = 'filler.vaultKey';

/**
 * "Stay unlocked for this browser session": the key goes to
 * chrome.storage.session, which is memory-only, cleared when the browser
 * closes and readable by extension pages only. Off by default.
 */
const sessionKeyStore: SessionKeyStore = {
  async get() {
    if (!settings.stayUnlockedForSession) return null;
    const entry = (await browser.storage.session.get(SESSION_KEY))[SESSION_KEY] as
      { key: string; lastActivity: number } | undefined;
    return entry ?? null;
  },
  async set(entry) {
    if (settings.stayUnlockedForSession)
      await browser.storage.session.set({ [SESSION_KEY]: entry });
  },
  async clear() {
    await browser.storage.session.remove(SESSION_KEY);
  },
  enabled: () => settings.stayUnlockedForSession,
};

export const vault = new VaultService({ sessionKeyStore });
export const repos = createRepositories(vault);

export const auth = new CloudAuth(supabase);

const cloudCfg = cloudConfig();
/** Filler's AI Edge Functions, called with the signed-in user's token (Phase 8). */
export const aiClient = new AiClient({
  functionsUrl: cloudCfg ? `${cloudCfg.url}/functions/v1` : null,
  ...(cloudCfg ? { anonKey: cloudCfg.anonKey } : {}),
  getAccessToken: () => auth.accessToken(),
});
export const ai = createAiSeam({
  client: aiClient,
  enabled: () => settings.aiAssist,
  policy: () => createPolicy({ extraPatterns: settings.denyPatterns }),
});

export const host = new SessionHost({
  vault,
  repos,
  ai,
  scanTab,
  fillTab,
  highlightTab,
  observeTab,
  endTab: endSessionTab,
  getSettings: async () => settings,
  publish(tabId, state) {
    const message: SessionStateMessage = { type: 'SESSION_STATE', tabId, state };
    // Only extension pages (the panel) receive runtime messages from the background.
    void browser.runtime.sendMessage(message).catch(() => undefined);
  },
});

vault.onLock(() => void host.broadcast({ type: 'VAULT_LOCKED' }));

export const cloud = new CloudSync(vault, auth, supabase, () => settings.cloudSync);

async function apply(next: Settings): Promise<void> {
  settings = next;
  vault.setAutoLockMinutes(next.autoLockMinutes);
  if (!next.stayUnlockedForSession) await sessionKeyStore.clear();
}

/** Loads settings and, if allowed, restores an unlocked vault after a worker restart. */
export const ready: Promise<void> = loadSettings()
  .then(apply)
  .then(() => vault.resume())
  .then(() => undefined)
  .catch(() => undefined);

export function currentSettings(): Settings {
  return settings;
}

export async function updateSettings(patch: SettingsPatch): Promise<Settings> {
  await ready;
  const next = await saveSettings(patch);
  await apply(next);
  if (patch.aiAssist !== undefined) void ai.refreshStatus(true);
  if (patch.highlight === false) {
    // Clear outlines already on pages.
    await Promise.all(host.tabs().map((tabId) => highlightTab(tabId, [])));
  }
  return next;
}
