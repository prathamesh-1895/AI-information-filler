/**
 * Sync transport over the `vault_blobs` table (one row per user, protected by
 * RLS). Optimistic concurrency: inserts fail if a row exists, updates only
 * match the expected version; either way the caller re-pulls and merges.
 */
import type { RemoteVault, SyncTransport } from '@filler/vault';
import type { SupabaseClient } from '@supabase/supabase-js';
import { z } from 'zod';

const RowSchema = z.object({
  version: z.number().int(),
  device_id: z.string(),
  kdf: z.object({ salt: z.string(), iterations: z.number().int() }),
  verifier: z.object({ iv: z.string(), ciphertext: z.string() }),
  iv: z.string(),
  ciphertext: z.string(),
  updated_at: z.string().optional(),
});

const CONFLICT_CODES = new Set(['23505', '40001', 'PGRST116']);

export class SupabaseTransport implements SyncTransport {
  constructor(private readonly client: SupabaseClient) {}

  async pull(): Promise<RemoteVault | null> {
    // RLS returns only the signed-in user's row.
    const { data, error } = await this.client.from('vault_blobs').select('*').limit(1);
    if (error) throw new Error(`Could not read your cloud vault: ${error.message}`);
    const row = data?.[0];
    if (!row) return null;
    const r = RowSchema.parse(row);
    return {
      version: r.version,
      deviceId: r.device_id,
      kdf: r.kdf,
      verifier: r.verifier,
      blob: { iv: r.iv, ciphertext: r.ciphertext },
      ...(r.updated_at ? { updatedAt: r.updated_at } : {}),
    };
  }

  async push(remote: RemoteVault, expectedVersion: number | null): Promise<'ok' | 'conflict'> {
    const row = {
      version: remote.version,
      device_id: remote.deviceId,
      kdf: remote.kdf,
      verifier: remote.verifier,
      iv: remote.blob.iv,
      ciphertext: remote.blob.ciphertext,
    };
    const { data, error } =
      expectedVersion === null
        ? await this.client.from('vault_blobs').insert(row).select('version')
        : await this.client
            .from('vault_blobs')
            .update(row)
            .eq('version', expectedVersion)
            .select('version');
    if (error) {
      if (CONFLICT_CODES.has(error.code ?? '') || /duplicate|version/i.test(error.message))
        return 'conflict';
      throw new Error(`Could not save your cloud vault: ${error.message}`);
    }
    return data && data.length > 0 ? 'ok' : 'conflict';
  }
}
