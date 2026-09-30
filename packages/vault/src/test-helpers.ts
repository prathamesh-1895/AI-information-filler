import { VaultService, type VaultServiceOptions } from './service';

let counter = 0;

/** A vault on a fresh fake-IndexedDB database with fast (test-only) key derivation. */
export function makeVault(options: VaultServiceOptions = {}): VaultService {
  counter += 1;
  return new VaultService({
    dbName: `test-vault-${counter}-${Math.random().toString(36).slice(2)}`,
    kdfIterations: 1_000,
    allowWeakKdfForTests: true,
    ...options,
  });
}

export const PASS = 'correct horse battery';
