/**
 * Supabase client for the background worker (PLAYBOOK Task 7.2).
 *
 * Only the project URL and the anon/publishable key are built in; both are
 * public by design (Row Level Security protects the data). No service-role
 * key ever ships in the extension. Without them, cloud features stay off and
 * everything else keeps working.
 */
import { createClient, type SupabaseClient } from '@supabase/supabase-js';

export interface CloudConfig {
  url: string;
  anonKey: string;
}

export function cloudConfig(): CloudConfig | null {
  const url = (import.meta.env.VITE_SUPABASE_URL as string | undefined)?.trim();
  const anonKey = (import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined)?.trim();
  return url && anonKey ? { url: url.replace(/\/+$/, ''), anonKey } : null;
}

/** Auth session storage in chrome.storage.local (extension-only; survives worker restarts). */
const storage = {
  async getItem(key: string) {
    const value = (await browser.storage.local.get(key))[key];
    return typeof value === 'string' ? value : null;
  },
  async setItem(key: string, value: string) {
    await browser.storage.local.set({ [key]: value });
  },
  async removeItem(key: string) {
    await browser.storage.local.remove(key);
  },
};

let client: SupabaseClient | null = null;

export function supabase(): SupabaseClient | null {
  const config = cloudConfig();
  if (!config) return null;
  client ??= createClient(config.url, config.anonKey, {
    auth: {
      storage,
      storageKey: 'filler.auth',
      persistSession: true,
      autoRefreshToken: true,
      detectSessionInUrl: false,
      flowType: 'implicit',
    },
  });
  return client;
}
