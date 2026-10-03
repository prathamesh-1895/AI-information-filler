/**
 * End-to-end encrypted vault sync (PLAYBOOK Task 7.3).
 *
 * The cloud stores ONE opaque blob per user: the whole snapshot (encrypted
 * rows + deletions) encrypted again with the vault key. The server never sees
 * the passphrase, the key, values, or even which kinds of details exist. Next
 * to the blob travel only what a new device needs to derive and check the key
 * from the passphrase (KDF salt/iterations and the verifier).
 *
 * Merge rule: per record, last writer wins by `updatedAt`; deletions win over
 * older edits. When the same fact changed on both devices since the last sync,
 * the newer value wins and the older one is kept as a `custom.conflict_*` fact
 * ("keep both"), so nothing typed by the user is silently lost.
 */
import { customKeyFor, type Fact } from '@filler/core';
import type { EncryptedBlob } from './crypto';
import { DATA_TABLES, type DataTable, type EncryptedRow } from './db';
import type { Snapshot, VaultService } from './service';

export interface RemoteVault {
  version: number;
  deviceId: string;
  kdf: { salt: string; iterations: number };
  verifier: EncryptedBlob;
  blob: EncryptedBlob;
  updatedAt?: string;
}

export interface SyncTransport {
  /** The user's cloud vault, or null if none was uploaded yet. */
  pull(): Promise<RemoteVault | null>;
  /**
   * Uploads `remote` if the cloud still holds `expectedVersion` (null = must not exist yet).
   * Returns 'conflict' if another device got there first.
   */
  push(remote: RemoteVault, expectedVersion: number | null): Promise<'ok' | 'conflict'>;
}

export interface ConflictNote {
  key: string;
  keptCopyAs: string;
}

export type SyncResult =
  | {
      status: 'uploaded' | 'downloaded' | 'merged' | 'unchanged';
      version: number;
      conflicts: ConflictNote[];
    }
  /** The cloud holds a different vault (another passphrase/salt). The user must choose which to keep. */
  | { status: 'different-vault'; cloudVersion: number };

const time = (iso: string | undefined) => (iso ? Date.parse(iso) || 0 : 0);

interface MergeOutput {
  merged: Snapshot;
  conflicts: ConflictNote[];
}

/** Merges two snapshots of the same vault (same key). Needs the vault to re-encrypt conflict copies. */
export async function mergeSnapshots(
  vault: VaultService,
  local: Snapshot,
  remote: Snapshot,
  lastSyncAt: string,
): Promise<MergeOutput> {
  const since = time(lastSyncAt);
  const conflicts: ConflictNote[] = [];

  // Deletions: newest per record.
  const tomb = new Map<string, Snapshot['tombstones'][number]>();
  for (const t of [...local.tombstones, ...remote.tombstones]) {
    const id = `${t.table}/${t.rowId}`;
    const seen = tomb.get(id);
    if (!seen || time(t.deletedAt) > time(seen.deletedAt)) tomb.set(id, t);
  }

  const tables = {} as Snapshot['tables'];
  for (const table of DATA_TABLES) {
    const mine = new Map(local.tables[table].map((r) => [r.id, r]));
    const theirs = new Map(remote.tables[table].map((r) => [r.id, r]));
    const out = new Map<string, EncryptedRow>();
    for (const id of new Set([...mine.keys(), ...theirs.keys()])) {
      const a = mine.get(id);
      const b = theirs.get(id);
      let winner: EncryptedRow;
      if (a && b) {
        if (a.ciphertext === b.ciphertext) winner = a;
        else {
          const [newer, older] =
            time(a.updatedAt) > time(b.updatedAt) ||
            (time(a.updatedAt) === time(b.updatedAt) && a.ciphertext > b.ciphertext)
              ? [a, b]
              : [b, a];
          winner = newer;
          // Changed on both devices since the last sync: keep the other value too.
          if (table === 'facts' && time(a.updatedAt) > since && time(b.updatedAt) > since) {
            const [newerValue, olderValue] = await Promise.all([
              vault.peekRecord<Fact>(table, newer),
              vault.peekRecord<Fact>(table, older),
            ]);
            // Row ids are opaque (keyed hashes): the fact key comes from the decrypted value.
            const factKey = newerValue.key;
            if (
              JSON.stringify(newerValue.value) !== JSON.stringify(olderValue.value) &&
              !factKey.startsWith('custom.conflict_')
            ) {
              const copyKey = customKeyFor(`conflict ${factKey}`);
              const copy = await vault.rekeyRecord(table, older, copyKey, (v) => ({
                ...(v as Fact),
                key: copyKey,
                source: 'user',
              }));
              out.set(copy.id, copy);
              conflicts.push({ key: factKey, keptCopyAs: copyKey });
            }
          }
        }
      } else {
        winner = (a ?? b)!;
      }
      const deleted = tomb.get(`${table}/${id}`);
      if (deleted && time(deleted.deletedAt) >= time(winner.updatedAt)) continue;
      if (!out.has(id)) out.set(id, winner);
    }
    tables[table] = [...out.values()].sort((x, y) => x.id.localeCompare(y.id));
  }

  // A deletion older than a surviving record is obsolete.
  const tombstones = [...tomb.values()].filter(
    (t) => !tables[t.table as DataTable].some((r) => r.id === t.rowId),
  );
  return { merged: { kdf: local.kdf, verifier: local.verifier, tables, tombstones }, conflicts };
}

const sameData = (a: Snapshot, b: Snapshot) => {
  const norm = (s: Snapshot) =>
    JSON.stringify({
      t: DATA_TABLES.map((t) =>
        [...s.tables[t]].sort((x, y) => x.id.localeCompare(y.id)).map((r) => [r.id, r.ciphertext]),
      ),
      d: [...s.tombstones].map((t) => `${t.table}/${t.rowId}`).sort(),
    });
  return norm(a) === norm(b);
};

export class VaultSync {
  constructor(
    private readonly vault: VaultService,
    private readonly transport: SyncTransport,
    private readonly deviceId: string,
    private readonly now: () => string = () => new Date().toISOString(),
  ) {}

  /** One sync round: pull, merge, write locally, push. Retries once if another device pushed meanwhile. */
  async sync(): Promise<SyncResult> {
    for (let attempt = 0; attempt < 3; attempt++) {
      const result = await this.round();
      if (result !== 'retry') return result;
    }
    throw new Error('Sync kept colliding with another device. Try again in a moment.');
  }

  private async round(): Promise<SyncResult | 'retry'> {
    const local = await this.vault.exportSnapshot();
    const remote = await this.transport.pull();
    const state = await this.vault.getSyncState();

    if (!remote) {
      const pushed = await this.push(local, 1, null);
      return pushed ? { status: 'uploaded', version: 1, conflicts: [] } : 'retry';
    }
    if (remote.kdf.salt !== local.kdf.salt)
      return { status: 'different-vault', cloudVersion: remote.version };

    const remoteSnap = await this.vault.openSnapshot(remote.blob);
    const { merged, conflicts } = await mergeSnapshots(
      this.vault,
      local,
      remoteSnap,
      state?.lastSyncAt ?? '',
    );
    const localChanged = !sameData(merged, local);
    const remoteChanged = !sameData(merged, remoteSnap);
    if (localChanged) await this.vault.applySnapshot(merged);
    let version = remote.version;
    if (remoteChanged) {
      if (!(await this.push(merged, remote.version + 1, remote.version))) return 'retry';
      version = remote.version + 1;
    }
    await this.vault.setSyncState({
      deviceId: this.deviceId,
      lastSyncedVersion: version,
      lastSyncAt: this.now(),
    });
    const status =
      localChanged && remoteChanged
        ? 'merged'
        : localChanged
          ? 'downloaded'
          : remoteChanged
            ? 'uploaded'
            : 'unchanged';
    return { status, version, conflicts };
  }

  /** Replace this device's vault with the cloud copy (new device, or the user chose the cloud). */
  async useCloudCopy(passphrase: string): Promise<SyncResult> {
    const remote = await this.transport.pull();
    if (!remote) throw new Error('There is no cloud copy yet.');
    await this.vault.joinRemote(remote, passphrase);
    await this.vault.setSyncState({
      deviceId: this.deviceId,
      lastSyncedVersion: remote.version,
      lastSyncAt: this.now(),
    });
    return { status: 'downloaded', version: remote.version, conflicts: [] };
  }

  /** Replace the cloud copy with this device's vault (the user chose this device). */
  async replaceCloudCopy(): Promise<SyncResult> {
    const remote = await this.transport.pull();
    const local = await this.vault.exportSnapshot();
    const next = (remote?.version ?? 0) + 1;
    if (!(await this.push(local, next, remote?.version ?? null)))
      throw new Error('Another device changed the cloud copy. Try again.');
    return { status: 'uploaded', version: next, conflicts: [] };
  }

  private async push(
    snapshot: Snapshot,
    version: number,
    expected: number | null,
  ): Promise<boolean> {
    const blob = await this.vault.sealSnapshot(snapshot);
    const ok =
      (await this.transport.push(
        { version, deviceId: this.deviceId, kdf: snapshot.kdf, verifier: snapshot.verifier, blob },
        expected,
      )) === 'ok';
    if (ok)
      await this.vault.setSyncState({
        deviceId: this.deviceId,
        lastSyncedVersion: version,
        lastSyncAt: this.now(),
      });
    return ok;
  }
}

/** An in-memory transport (tests, and a reference for the Supabase one). */
export class MemoryTransport implements SyncTransport {
  stored: RemoteVault | null = null;
  pushes = 0;
  async pull() {
    return this.stored ? structuredClone(this.stored) : null;
  }
  async push(remote: RemoteVault, expectedVersion: number | null) {
    if ((this.stored?.version ?? null) !== expectedVersion) return 'conflict' as const;
    this.pushes++;
    this.stored = structuredClone({ ...remote, updatedAt: new Date().toISOString() });
    return 'ok' as const;
  }
}
