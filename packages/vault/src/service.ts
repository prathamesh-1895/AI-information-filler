/**
 * VaultService owns the vault key and its lifecycle: create, unlock, lock,
 * auto-lock, passphrase change, encrypted backup and wipe.
 *
 * The AES key is a non-extractable CryptoKey held only in memory. In an MV3
 * service worker that memory disappears when the worker is killed, so a fresh
 * VaultService always starts locked (never half-open). Users can opt into
 * "stay unlocked for this browser session" by passing a SessionKeyStore
 * (backed by chrome.storage.session in the extension). That keeps raw key
 * bytes outside the worker until the browser closes, which is weaker than
 * memory-only and is off by default.
 */
import { z } from 'zod';
import {
  DEFAULT_KDF_ITERATIONS,
  MIN_KDF_ITERATIONS,
  MIN_PASSPHRASE_LENGTH,
  SALT_BYTES,
  checkVerifier,
  createVerifier,
  decryptJson,
  deriveKeyBytes,
  encryptJson,
  fromBase64,
  importAesKey,
  randomBytes,
  toBase64,
} from './crypto';
import {
  DATA_TABLES,
  openVaultDb,
  type DataTable,
  type EncryptedRow,
  type VaultDb,
  type VaultMetaRow,
} from './db';
import {
  BackupFormatError,
  VaultExistsError,
  VaultLockedError,
  VaultNotInitializedError,
  WeakPassphraseError,
} from './errors';

export type VaultStatus = 'uninitialized' | 'locked' | 'unlocked';

/** Where "stay unlocked for this browser session" keeps key bytes. */
export interface SessionKeyStore {
  get(): Promise<{ key: string; lastActivity: number } | null>;
  set(entry: { key: string; lastActivity: number }): Promise<void>;
  clear(): Promise<void>;
  /** When this returns false the vault keeps no copy of the key bytes at all. */
  enabled?(): boolean;
}

export interface VaultServiceOptions {
  db?: VaultDb;
  dbName?: string;
  /** PBKDF2 iterations for new vaults and passphrase changes. */
  kdfIterations?: number;
  /** Allows iterations below MIN_KDF_ITERATIONS. Tests only. */
  allowWeakKdfForTests?: boolean;
  /** Minutes of inactivity before auto-lock. 0 disables. Default 15. */
  autoLockMinutes?: number;
  now?: () => number;
  sessionKeyStore?: SessionKeyStore;
}

const BlobSchema = z.object({ iv: z.string().min(1), ciphertext: z.string().min(1) });
const RowSchema = BlobSchema.extend({ id: z.string().min(1), updatedAt: z.string() });

export const BackupSchema = z.object({
  format: z.literal('filler-backup'),
  formatVersion: z.literal(1),
  exportedAt: z.string(),
  kdf: z.object({ salt: z.string().min(1), iterations: z.number().int().positive() }),
  verifier: BlobSchema,
  tables: z.object({
    facts: z.array(RowSchema),
    documents: z.array(RowSchema),
    fieldMemory: z.array(RowSchema),
    answers: z.array(RowSchema),
  }),
});
export type Backup = z.infer<typeof BackupSchema>;

const aadFor = (table: DataTable, id: string) => `${table}/${id}`;

export class VaultService {
  readonly db: VaultDb;
  private key: CryptoKey | null = null;
  private lastActivity = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private queue: Promise<unknown> = Promise.resolve();
  private readonly iterations: number;
  private autoLockMs: number;
  private readonly now: () => number;
  private readonly sessionKeyStore: SessionKeyStore | undefined;
  private readonly lockListeners = new Set<() => void>();

  constructor(options: VaultServiceOptions = {}) {
    this.db = options.db ?? openVaultDb(options.dbName);
    this.iterations = options.kdfIterations ?? DEFAULT_KDF_ITERATIONS;
    if (this.iterations < MIN_KDF_ITERATIONS && !options.allowWeakKdfForTests) {
      throw new Error(`PBKDF2 iterations must be at least ${MIN_KDF_ITERATIONS}`);
    }
    this.autoLockMs = (options.autoLockMinutes ?? 15) * 60_000;
    this.now = options.now ?? (() => Date.now());
    this.sessionKeyStore = options.sessionKeyStore;
  }

  // ---------------------------------------------------------------- lifecycle

  async status(): Promise<VaultStatus> {
    if (!(await this.db.meta.get('vault'))) return 'uninitialized';
    return this.isUnlocked() ? 'unlocked' : 'locked';
  }

  isUnlocked(): boolean {
    this.expireIfIdle();
    return this.key !== null;
  }

  /** Creates a new, empty vault and leaves it unlocked. */
  create(passphrase: string): Promise<void> {
    return this.exclusive(async () => {
      assertPassphrase(passphrase);
      if (await this.db.meta.get('vault')) throw new VaultExistsError();
      const salt = randomBytes(SALT_BYTES);
      const raw = await deriveKeyBytes(passphrase, salt, this.iterations);
      const key = await importAesKey(raw);
      const at = new Date(this.now()).toISOString();
      await this.db.meta.add({
        id: 'vault',
        formatVersion: 1,
        salt: toBase64(salt),
        iterations: this.iterations,
        verifier: await createVerifier(key),
        createdAt: at,
        updatedAt: at,
      });
      await this.setKey(key, raw);
    });
  }

  /** Unlocks with the passphrase. Throws WrongPassphraseError on a bad passphrase. */
  async unlock(passphrase: string): Promise<void> {
    const meta = await this.requireMeta();
    const raw = await deriveKeyBytes(passphrase, fromBase64(meta.salt), meta.iterations);
    const key = await importAesKey(raw);
    await checkVerifier(key, meta.verifier);
    await this.setKey(key, raw);
  }

  /**
   * Restores an unlocked state from the session key store after a service
   * worker restart. Returns false (and stays locked) if there is nothing
   * valid to restore or the session has been idle too long.
   */
  async resume(): Promise<boolean> {
    if (this.key) return true;
    const entry = await this.sessionKeyStore?.get();
    const meta = await this.db.meta.get('vault');
    if (!entry || !meta) return false;
    if (this.autoLockMs > 0 && this.now() - entry.lastActivity >= this.autoLockMs) {
      await this.sessionKeyStore?.clear();
      return false;
    }
    try {
      const raw = fromBase64(entry.key);
      const key = await importAesKey(raw);
      await checkVerifier(key, meta.verifier);
      await this.setKey(key, raw);
      return true;
    } catch {
      await this.sessionKeyStore?.clear();
      return false;
    }
  }

  lock(): void {
    this.key = null;
    this.sessionKeyB64 = null;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    void this.sessionKeyStore?.clear();
    for (const listener of this.lockListeners) listener();
  }

  /** Subscribes to lock events (manual or automatic). Returns an unsubscribe function. */
  onLock(listener: () => void): () => void {
    this.lockListeners.add(listener);
    return () => this.lockListeners.delete(listener);
  }

  /** Changes the idle timeout (0 = never) and restarts the timer from now. */
  setAutoLockMinutes(minutes: number): void {
    if (!Number.isFinite(minutes) || minutes < 0)
      throw new Error(`Invalid auto-lock minutes: ${minutes}`);
    this.autoLockMs = minutes * 60_000;
    if (this.key) {
      this.lastActivity = this.now();
      this.schedule();
    }
  }

  /** Records user activity, postponing auto-lock. */
  touch(): void {
    if (!this.key) return;
    this.lastActivity = this.now();
    this.schedule();
    void this.persistSession();
  }

  /** Re-encrypts every record under a new passphrase and salt, atomically. */
  changePassphrase(oldPassphrase: string, newPassphrase: string): Promise<void> {
    return this.exclusive(async () => {
      assertPassphrase(newPassphrase);
      const meta = await this.requireMeta();
      const oldKey = await importAesKey(
        await deriveKeyBytes(oldPassphrase, fromBase64(meta.salt), meta.iterations),
      );
      await checkVerifier(oldKey, meta.verifier);

      const salt = randomBytes(SALT_BYTES);
      const newRaw = await deriveKeyBytes(newPassphrase, salt, this.iterations);
      const newKey = await importAesKey(newRaw);

      // Crypto runs outside the IndexedDB transaction (awaiting WebCrypto inside
      // one lets it auto-commit). Any decryption failure aborts before writing.
      const rewritten = new Map<DataTable, EncryptedRow[]>();
      for (const table of DATA_TABLES) {
        const rows = await this.db[table].toArray();
        const next: EncryptedRow[] = [];
        for (const row of rows) {
          const value = await decryptJson(oldKey, row, aadFor(table, row.id));
          next.push({
            ...(await encryptJson(newKey, value, aadFor(table, row.id))),
            id: row.id,
            updatedAt: row.updatedAt,
          });
        }
        rewritten.set(table, next);
      }
      const nextMeta: VaultMetaRow = {
        ...meta,
        salt: toBase64(salt),
        iterations: this.iterations,
        verifier: await createVerifier(newKey),
        updatedAt: new Date(this.now()).toISOString(),
      };

      await this.db.transaction(
        'rw',
        [this.db.meta, ...DATA_TABLES.map((t) => this.db[t])],
        async () => {
          for (const table of DATA_TABLES) await this.db[table].bulkPut(rewritten.get(table) ?? []);
          await this.db.meta.put(nextMeta);
        },
      );
      await this.setKey(newKey, newRaw);
    });
  }

  // ------------------------------------------------------------ record crypto

  /** Encrypts and stores one record. Used by the repositories. */
  writeRecord(table: DataTable, id: string, value: unknown): Promise<void> {
    return this.exclusive(async () => {
      const key = this.requireKey();
      const blob = await encryptJson(key, value, aadFor(table, id));
      await this.db[table].put({ ...blob, id, updatedAt: new Date(this.now()).toISOString() });
    });
  }

  async readRecord<T>(table: DataTable, id: string): Promise<T | undefined> {
    const key = this.requireKey();
    const row = await this.db[table].get(id);
    return row ? decryptJson<T>(key, row, aadFor(table, id)) : undefined;
  }

  async readAll<T>(table: DataTable): Promise<T[]> {
    const key = this.requireKey();
    const rows = await this.db[table].toArray();
    return Promise.all(rows.map((row) => decryptJson<T>(key, row, aadFor(table, row.id))));
  }

  deleteRecord(table: DataTable, id: string): Promise<void> {
    return this.exclusive(async () => {
      this.requireKey();
      await this.db[table].delete(id);
    });
  }

  deleteRecords(table: DataTable, ids: string[]): Promise<void> {
    return this.exclusive(async () => {
      this.requireKey();
      await this.db[table].bulkDelete(ids);
    });
  }

  // ------------------------------------------------------- backup and wipe

  /** Exports the encrypted vault. Records stay encrypted; the file is useless without the passphrase. */
  async exportBackup(): Promise<string> {
    this.requireKey();
    const meta = await this.requireMeta();
    const tables = Object.fromEntries(
      await Promise.all(DATA_TABLES.map(async (t) => [t, await this.db[t].toArray()] as const)),
    ) as Backup['tables'];
    const backup: Backup = {
      format: 'filler-backup',
      formatVersion: 1,
      exportedAt: new Date(this.now()).toISOString(),
      kdf: { salt: meta.salt, iterations: meta.iterations },
      verifier: meta.verifier,
      tables,
    };
    return JSON.stringify(backup);
  }

  /**
   * Replaces the whole vault with a backup, after verifying the passphrase
   * and decrypting every record. Leaves the vault unlocked with the backup's
   * passphrase. Nothing is changed if anything fails.
   */
  importBackup(json: string, passphrase: string): Promise<void> {
    return this.exclusive(async () => {
      let backup: Backup;
      try {
        backup = BackupSchema.parse(JSON.parse(json));
      } catch {
        throw new BackupFormatError('This file is not a valid Filler backup.');
      }
      if (backup.kdf.iterations < MIN_KDF_ITERATIONS && this.iterations >= MIN_KDF_ITERATIONS) {
        throw new BackupFormatError(
          'This backup uses unsafe encryption settings and cannot be imported.',
        );
      }
      const raw = await deriveKeyBytes(
        passphrase,
        fromBase64(backup.kdf.salt),
        backup.kdf.iterations,
      );
      const key = await importAesKey(raw);
      await checkVerifier(key, backup.verifier);
      for (const table of DATA_TABLES) {
        for (const row of backup.tables[table]) {
          try {
            await decryptJson(key, row, aadFor(table, row.id));
          } catch {
            throw new BackupFormatError(
              'This backup is damaged: some records cannot be decrypted.',
            );
          }
        }
      }
      const at = new Date(this.now()).toISOString();
      const existing = await this.db.meta.get('vault');
      await this.db.transaction(
        'rw',
        [this.db.meta, ...DATA_TABLES.map((t) => this.db[t])],
        async () => {
          for (const table of DATA_TABLES) {
            await this.db[table].clear();
            await this.db[table].bulkAdd(backup.tables[table]);
          }
          await this.db.meta.put({
            id: 'vault',
            formatVersion: 1,
            salt: backup.kdf.salt,
            iterations: backup.kdf.iterations,
            verifier: backup.verifier,
            createdAt: existing?.createdAt ?? at,
            updatedAt: at,
          });
        },
      );
      await this.setKey(key, raw);
    });
  }

  /** Permanently deletes the vault on this device. The UI must confirm first. */
  wipe(): Promise<void> {
    return this.exclusive(async () => {
      await this.db.transaction(
        'rw',
        [this.db.meta, ...DATA_TABLES.map((t) => this.db[t])],
        async () => {
          for (const table of DATA_TABLES) await this.db[table].clear();
          await this.db.meta.clear();
        },
      );
      this.lock();
    });
  }

  // ---------------------------------------------------------------- internals

  private requireKey(): CryptoKey {
    this.expireIfIdle();
    if (!this.key) throw new VaultLockedError();
    this.touch();
    return this.key;
  }

  private async requireMeta(): Promise<VaultMetaRow> {
    const meta = await this.db.meta.get('vault');
    if (!meta) throw new VaultNotInitializedError();
    return meta;
  }

  private async setKey(key: CryptoKey, raw: Uint8Array): Promise<void> {
    this.key = key;
    this.lastActivity = this.now();
    this.schedule();
    await this.persistSession(raw);
    raw.fill(0);
  }

  private sessionKeyB64: string | null = null;

  private async persistSession(raw?: Uint8Array): Promise<void> {
    if (!this.sessionKeyStore || !this.key) return;
    if (this.sessionKeyStore.enabled?.() === false) {
      this.sessionKeyB64 = null;
      return;
    }
    if (raw) this.sessionKeyB64 = toBase64(raw);
    if (this.sessionKeyB64) {
      await this.sessionKeyStore.set({ key: this.sessionKeyB64, lastActivity: this.lastActivity });
    }
  }

  private expireIfIdle(): void {
    if (this.key && this.autoLockMs > 0 && this.now() - this.lastActivity >= this.autoLockMs) {
      this.lock();
    }
  }

  private schedule(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (this.autoLockMs > 0) this.timer = setTimeout(() => this.expireIfIdle(), this.autoLockMs);
  }

  /** Serialises writes so a passphrase change never races a record write. */
  private exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(fn, fn);
    this.queue = run.catch(() => undefined);
    return run;
  }
}

function assertPassphrase(passphrase: string): void {
  if (passphrase.length < MIN_PASSPHRASE_LENGTH)
    throw new WeakPassphraseError(MIN_PASSPHRASE_LENGTH);
}
