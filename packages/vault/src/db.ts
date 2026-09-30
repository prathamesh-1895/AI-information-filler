/**
 * IndexedDB layout. Every data row is `{ id, iv, ciphertext, updatedAt }`
 * plus, at most, one non-sensitive index field. Values only ever exist
 * inside `ciphertext`.
 */
import Dexie, { type EntityTable } from 'dexie';
import type { EncryptedBlob } from './crypto';

export const VAULT_DB_NAME = 'filler-vault';

export interface EncryptedRow extends EncryptedBlob {
  id: string;
  updatedAt: string;
}

/** Facts are keyed by their canonical key (e.g. `contact.email`); the key name is not a value. */
export type FactRow = EncryptedRow;
/** Field memory is keyed by the field signature (a SHA-256 hash). The site stays encrypted. */
export type FieldMemoryRow = EncryptedRow;
export type DocumentRow = EncryptedRow;
export type AnswerRow = EncryptedRow;

export interface VaultMetaRow {
  id: 'vault';
  formatVersion: 1;
  /** Base64 PBKDF2 salt. */
  salt: string;
  iterations: number;
  verifier: EncryptedBlob;
  createdAt: string;
  updatedAt: string;
}

export const DATA_TABLES = ['facts', 'documents', 'fieldMemory', 'answers'] as const;
export type DataTable = (typeof DATA_TABLES)[number];

export type VaultDb = Dexie & {
  meta: EntityTable<VaultMetaRow, 'id'>;
  facts: EntityTable<FactRow, 'id'>;
  documents: EntityTable<DocumentRow, 'id'>;
  fieldMemory: EntityTable<FieldMemoryRow, 'id'>;
  answers: EntityTable<AnswerRow, 'id'>;
};

export function openVaultDb(name: string = VAULT_DB_NAME): VaultDb {
  const db = new Dexie(name) as VaultDb;
  db.version(1).stores({
    meta: 'id',
    facts: 'id, updatedAt',
    documents: 'id, updatedAt',
    fieldMemory: 'id, updatedAt',
    answers: 'id, updatedAt',
  });
  return db;
}
