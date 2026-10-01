/**
 * Cloud sync in the background worker (PLAYBOOK Task 7.3): "Sync now",
 * automatic sync shortly after local changes (when enabled), and the two
 * recovery choices when the cloud holds a different vault.
 */
import { VaultSync, type SyncResult, type VaultService } from '@filler/vault';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { CloudAuth } from './auth';
import { SupabaseTransport } from './transport';

export interface SyncStatus {
  enabled: boolean;
  signedIn: boolean;
  syncing: boolean;
  lastAt?: string;
  last?: SyncResult;
  error?: string;
}

const DEVICE_KEY = 'filler.deviceId';
const AUTO_SYNC_DELAY_MS = 3_000;

export class CloudSync {
  private syncing = false;
  private lastAt: string | undefined;
  private last: SyncResult | undefined;
  private error: string | undefined;
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly vault: VaultService,
    private readonly auth: CloudAuth,
    private readonly client: () => SupabaseClient | null,
    private readonly enabled: () => boolean,
  ) {
    vault.onChange(() => this.schedule());
  }

  async status(): Promise<SyncStatus> {
    const auth = await this.auth.status();
    return {
      enabled: this.enabled(),
      signedIn: auth.signedIn,
      syncing: this.syncing,
      ...(this.lastAt ? { lastAt: this.lastAt } : {}),
      ...(this.last ? { last: this.last } : {}),
      ...(this.error ? { error: this.error } : {}),
    };
  }

  /** Debounced automatic sync after local edits, only when the user turned sync on and is signed in. */
  schedule(): void {
    if (!this.enabled()) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.auth
        .status()
        .then((s) => (s.signedIn && this.vault.isUnlocked() ? this.syncNow() : undefined));
    }, AUTO_SYNC_DELAY_MS);
  }

  syncNow(): Promise<SyncResult> {
    return this.run((sync) => sync.sync());
  }

  /** Replace this device's vault with the cloud copy (also how a new device restores). */
  useCloudCopy(passphrase: string): Promise<SyncResult> {
    return this.run((sync) => sync.useCloudCopy(passphrase), { needsUnlocked: false });
  }

  replaceCloudCopy(): Promise<SyncResult> {
    return this.run((sync) => sync.replaceCloudCopy());
  }

  private async run(
    fn: (sync: VaultSync) => Promise<SyncResult>,
    opts = { needsUnlocked: true },
  ): Promise<SyncResult> {
    const client = this.client();
    if (!client) throw new Error('Cloud features are not set up in this build of Filler.');
    if (!(await this.auth.status()).signedIn) throw new Error('Sign in to sync your vault.');
    if (opts.needsUnlocked && !this.vault.isUnlocked())
      throw new Error('Unlock your vault to sync it.');
    if (this.syncing) throw new Error('A sync is already running.');
    this.syncing = true;
    try {
      const result = await fn(
        new VaultSync(this.vault, new SupabaseTransport(client), await deviceId()),
      );
      this.last = result;
      this.error = undefined;
      this.lastAt = new Date().toISOString();
      return result;
    } catch (error) {
      this.error = error instanceof Error ? error.message : String(error);
      throw error;
    } finally {
      this.syncing = false;
    }
  }
}

async function deviceId(): Promise<string> {
  const existing = (await browser.storage.local.get(DEVICE_KEY))[DEVICE_KEY];
  if (typeof existing === 'string' && existing) return existing;
  const id = `ext-${globalThis.crypto.randomUUID().slice(0, 13)}`;
  await browser.storage.local.set({ [DEVICE_KEY]: id });
  return id;
}
