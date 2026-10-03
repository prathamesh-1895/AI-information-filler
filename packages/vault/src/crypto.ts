/**
 * Vault cryptography: PBKDF2-SHA256 key derivation and AES-256-GCM record
 * encryption, using only WebCrypto (browser, service worker, Node ≥ 20, Deno).
 *
 * Every record is encrypted with a fresh random 12-byte IV and bound to its
 * location (`table/id`) through GCM additional authenticated data, so a
 * ciphertext cannot be moved to another row without failing to decrypt.
 */
import { WrongPassphraseError } from './errors';

/** OWASP 2023 recommendation for PBKDF2-HMAC-SHA256. */
export const DEFAULT_KDF_ITERATIONS = 600_000;
/** Floor from the playbook (PLAYBOOK §0.5); lower values need an explicit test-only opt-in. */
export const MIN_KDF_ITERATIONS = 310_000;
export const SALT_BYTES = 16;
export const IV_BYTES = 12;
export const MIN_PASSPHRASE_LENGTH = 8;

const VERIFIER_PLAINTEXT = 'filler-vault-verifier-v1';
const VERIFIER_AAD = 'meta/verifier';

export interface EncryptedBlob {
  /** Base64 IV. */
  iv: string;
  /** Base64 ciphertext including the GCM tag. */
  ciphertext: string;
}

const subtle = (): SubtleCrypto => globalThis.crypto.subtle;
const encoder = new TextEncoder();
const decoder = new TextDecoder();

export function randomBytes(length: number): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(length);
  // getRandomValues fills at most 65,536 bytes per call.
  for (let i = 0; i < length; i += 65_536) {
    globalThis.crypto.getRandomValues(bytes.subarray(i, Math.min(i + 65_536, length)));
  }
  return bytes;
}

export function toBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

export function fromBase64(value: string): Uint8Array<ArrayBuffer> {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/**
 * Derives 256 raw key bits from a passphrase. Callers import them with
 * {@link importAesKey} and drop the bytes; they are only kept when the user
 * opts into "stay unlocked for this browser session".
 */
export async function deriveKeyBytes(
  passphrase: string,
  salt: Uint8Array<ArrayBuffer>,
  iterations: number,
): Promise<Uint8Array<ArrayBuffer>> {
  const material = await subtle().importKey('raw', encoder.encode(passphrase), 'PBKDF2', false, [
    'deriveBits',
  ]);
  const bits = await subtle().deriveBits(
    { name: 'PBKDF2', hash: 'SHA-256', salt, iterations },
    material,
    256,
  );
  return new Uint8Array(bits);
}

/**
 * Derives the key that names fact rows (Phase 12): an HMAC key from the vault
 * key bytes via HKDF, so stored row ids reveal nothing (not even key names
 * like `custom.medical_note`), yet stay the same on every device that shares
 * the vault.
 */
export async function deriveRowIdKey(raw: Uint8Array<ArrayBuffer>): Promise<CryptoKey> {
  const base = await subtle().importKey('raw', raw, 'HKDF', false, ['deriveKey']);
  return subtle().deriveKey(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: encoder.encode('filler/row-ids'),
      info: encoder.encode('v1'),
    },
    base,
    { name: 'HMAC', hash: 'SHA-256', length: 256 },
    false,
    ['sign'],
  );
}

/** A row id for a logical id: `k` + 40 hex characters of HMAC-SHA256. */
export async function hashRowId(idKey: CryptoKey, id: string): Promise<string> {
  const mac = new Uint8Array(await subtle().sign('HMAC', idKey, encoder.encode(id)));
  return `k${[...mac.slice(0, 20)].map((b) => b.toString(16).padStart(2, '0')).join('')}`;
}

export const HASHED_ROW_ID = /^k[0-9a-f]{40}$/;

/** Imports raw key bytes as a non-extractable AES-GCM key. */
export function importAesKey(raw: Uint8Array<ArrayBuffer>): Promise<CryptoKey> {
  return subtle().importKey('raw', raw, { name: 'AES-GCM', length: 256 }, false, [
    'encrypt',
    'decrypt',
  ]);
}

export async function deriveKey(
  passphrase: string,
  salt: Uint8Array<ArrayBuffer>,
  iterations: number,
): Promise<CryptoKey> {
  return importAesKey(await deriveKeyBytes(passphrase, salt, iterations));
}

/** Encrypts any JSON-serialisable value, bound to `aad` (e.g. `facts/contact.email`). */
export async function encryptJson(
  key: CryptoKey,
  value: unknown,
  aad: string,
): Promise<EncryptedBlob> {
  const iv = randomBytes(IV_BYTES);
  const ciphertext = await subtle().encrypt(
    { name: 'AES-GCM', iv, additionalData: encoder.encode(aad) },
    key,
    encoder.encode(JSON.stringify(value)),
  );
  return { iv: toBase64(iv), ciphertext: toBase64(new Uint8Array(ciphertext)) };
}

/** Decrypts a blob produced by {@link encryptJson}. Throws if the key, AAD or data is wrong. */
export async function decryptJson<T = unknown>(
  key: CryptoKey,
  blob: EncryptedBlob,
  aad: string,
): Promise<T> {
  const plaintext = await subtle().decrypt(
    { name: 'AES-GCM', iv: fromBase64(blob.iv), additionalData: encoder.encode(aad) },
    key,
    fromBase64(blob.ciphertext),
  );
  return JSON.parse(decoder.decode(plaintext)) as T;
}

export function createVerifier(key: CryptoKey): Promise<EncryptedBlob> {
  return encryptJson(key, VERIFIER_PLAINTEXT, VERIFIER_AAD);
}

/** Resolves if `key` opens the verifier, otherwise throws {@link WrongPassphraseError}. */
export async function checkVerifier(key: CryptoKey, verifier: EncryptedBlob): Promise<void> {
  try {
    if ((await decryptJson(key, verifier, VERIFIER_AAD)) === VERIFIER_PLAINTEXT) return;
  } catch {
    // Wrong key and tampered verifier look the same from here.
  }
  throw new WrongPassphraseError();
}
