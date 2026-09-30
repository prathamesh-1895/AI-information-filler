import { describe, expect, it } from 'vitest';
import {
  DEFAULT_KDF_ITERATIONS,
  MIN_KDF_ITERATIONS,
  checkVerifier,
  createVerifier,
  decryptJson,
  deriveKey,
  encryptJson,
  fromBase64,
  randomBytes,
  toBase64,
} from './crypto';
import { WrongPassphraseError } from './errors';

const salt = randomBytes(16);

describe('crypto primitives', () => {
  it('uses safe KDF defaults', () => {
    expect(DEFAULT_KDF_ITERATIONS).toBeGreaterThanOrEqual(MIN_KDF_ITERATIONS);
    expect(MIN_KDF_ITERATIONS).toBeGreaterThanOrEqual(310_000);
  });

  it('round-trips JSON values', async () => {
    const key = await deriveKey('passphrase-1', salt, 1_000);
    const value = { key: 'contact.email', value: 'priya@example.com', list: ['a', 'b'], n: 3 };
    const blob = await encryptJson(key, value, 'facts/contact.email');
    expect(await decryptJson(key, blob, 'facts/contact.email')).toEqual(value);
  });

  it('never exposes the plaintext in the blob', async () => {
    const key = await deriveKey('passphrase-1', salt, 1_000);
    const blob = await encryptJson(key, 'priya@example.com', 'x');
    expect(JSON.stringify(blob)).not.toContain('priya');
    expect(new TextDecoder().decode(fromBase64(blob.ciphertext))).not.toContain('priya');
  });

  it('creates non-extractable keys', async () => {
    const key = await deriveKey('passphrase-1', salt, 1_000);
    expect(key.extractable).toBe(false);
    await expect(globalThis.crypto.subtle.exportKey('raw', key)).rejects.toThrow();
  });

  it('rejects the wrong passphrase', async () => {
    const right = await deriveKey('passphrase-1', salt, 1_000);
    const wrong = await deriveKey('passphrase-2', salt, 1_000);
    const blob = await encryptJson(right, 'secret', 'x');
    await expect(decryptJson(wrong, blob, 'x')).rejects.toThrow();
    const verifier = await createVerifier(right);
    await expect(checkVerifier(right, verifier)).resolves.toBeUndefined();
    await expect(checkVerifier(wrong, verifier)).rejects.toBeInstanceOf(WrongPassphraseError);
  });

  it('rejects tampered ciphertext and IVs (GCM authentication)', async () => {
    const key = await deriveKey('passphrase-1', salt, 1_000);
    const blob = await encryptJson(key, 'secret value', 'x');
    const bytes = fromBase64(blob.ciphertext);
    bytes[0] = (bytes[0] ?? 0) ^ 0xff;
    await expect(decryptJson(key, { ...blob, ciphertext: toBase64(bytes) }, 'x')).rejects.toThrow();
    const iv = fromBase64(blob.iv);
    iv[0] = (iv[0] ?? 0) ^ 0x01;
    await expect(decryptJson(key, { ...blob, iv: toBase64(iv) }, 'x')).rejects.toThrow();
  });

  it('binds ciphertext to its record location (AAD)', async () => {
    const key = await deriveKey('passphrase-1', salt, 1_000);
    const blob = await encryptJson(key, 'value', 'facts/contact.email');
    await expect(decryptJson(key, blob, 'facts/contact.phone.mobile')).rejects.toThrow();
  });

  it('uses a unique IV for each of 1,000 encryptions', async () => {
    const key = await deriveKey('passphrase-1', salt, 1_000);
    const ivs = new Set<string>();
    for (let i = 0; i < 1_000; i++) ivs.add((await encryptJson(key, i, 'x')).iv);
    expect(ivs.size).toBe(1_000);
  });

  it('derives the same key for the same passphrase and salt, different for a different salt', async () => {
    const a = await deriveKey('passphrase-1', salt, 1_000);
    const b = await deriveKey('passphrase-1', salt, 1_000);
    const c = await deriveKey('passphrase-1', randomBytes(16), 1_000);
    const blob = await encryptJson(a, 'v', 'x');
    expect(await decryptJson(b, blob, 'x')).toBe('v');
    await expect(decryptJson(c, blob, 'x')).rejects.toThrow();
  });

  it('round-trips base64 for all byte values and large buffers', () => {
    const all = new Uint8Array(256).map((_, i) => i);
    expect(fromBase64(toBase64(all))).toEqual(all);
    const big = randomBytes(200_000);
    expect(fromBase64(toBase64(big))).toEqual(big);
  });
});
