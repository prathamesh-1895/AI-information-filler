import { describe, expect, it } from 'vitest';
import { WrongPassphraseError } from './errors';
import { createRepositories } from './repositories';
import { MemoryTransport, VaultSync } from './sync';
import { PASS, makeVault } from './test-helpers';

/** PLAYBOOK Task 7.3: two devices sync through an untrusted store that only ever sees ciphertext. */

let clock = Date.parse('2026-10-01T10:00:00.000Z');
const tick = () => new Date((clock += 1_000)).toISOString();

async function device(name: string, cloud: MemoryTransport) {
  const vault = makeVault({ now: () => clock });
  return { vault, repos: createRepositories(vault), sync: new VaultSync(vault, cloud, name, tick) };
}

async function twoDevices() {
  const cloud = new MemoryTransport();
  const a = await device('laptop', cloud);
  await a.vault.create(PASS);
  await a.repos.facts.setValue('person.name.full', 'Priya Sharma');
  await a.repos.facts.setValue('address.city', 'Pune');
  expect(await a.sync.sync()).toMatchObject({ status: 'uploaded', version: 1 });
  const b = await device('phone', cloud);
  await b.sync.useCloudCopy(PASS);
  return { cloud, a, b };
}

const value = async (d: Awaited<ReturnType<typeof device>>, key: string) =>
  (await d.repos.facts.get(key))?.value;

describe('vault sync', () => {
  it('a new device joins with the passphrase and sees the same details', async () => {
    const { b } = await twoDevices();
    expect(await value(b, 'person.name.full')).toBe('Priya Sharma');
    expect(b.vault.isUnlocked()).toBe(true);
  });

  it('refuses to join with the wrong passphrase, changing nothing', async () => {
    const cloud = new MemoryTransport();
    const a = await device('laptop', cloud);
    await a.vault.create(PASS);
    await a.sync.sync();
    const b = await device('phone', cloud);
    await expect(b.sync.useCloudCopy('not the passphrase')).rejects.toBeInstanceOf(
      WrongPassphraseError,
    );
    expect(await b.vault.status()).toBe('uninitialized');
  });

  it('syncs edits both ways', async () => {
    const { a, b } = await twoDevices();
    clock += 10_000;
    await b.repos.facts.setValue('contact.email', 'priya@example.com');
    expect(await b.sync.sync()).toMatchObject({ status: 'uploaded', version: 2 });
    expect(await a.sync.sync()).toMatchObject({ status: 'downloaded', version: 2 });
    expect(await value(a, 'contact.email')).toBe('priya@example.com');

    clock += 10_000;
    await a.repos.facts.setValue('address.city', 'Mumbai');
    await a.sync.sync();
    await b.sync.sync();
    expect(await value(b, 'address.city')).toBe('Mumbai');
    expect(await b.sync.sync()).toMatchObject({ status: 'unchanged' });
  });

  it('deletions travel and are not resurrected by an older copy', async () => {
    const { a, b } = await twoDevices();
    clock += 10_000;
    await a.repos.facts.delete('address.city');
    await a.sync.sync();
    expect(await b.sync.sync()).toMatchObject({ status: 'downloaded' });
    expect(await value(b, 'address.city')).toBeUndefined();
    // Re-creating it later wins over the old deletion.
    clock += 10_000;
    await b.repos.facts.setValue('address.city', 'Nashik');
    await b.sync.sync();
    await a.sync.sync();
    expect(await value(a, 'address.city')).toBe('Nashik');
  });

  it('keeps both values when the same detail changed on two devices', async () => {
    const { a, b } = await twoDevices();
    clock += 10_000;
    await a.repos.facts.setValue('address.city', 'Mumbai');
    clock += 10_000;
    await b.repos.facts.setValue('address.city', 'Bengaluru'); // newer
    await b.sync.sync();
    const result = await a.sync.sync();
    expect(result).toMatchObject({
      status: 'merged',
      conflicts: [{ key: 'address.city', keptCopyAs: 'custom.conflict_address_city' }],
    });
    expect(await value(a, 'address.city')).toBe('Bengaluru');
    expect(await value(a, 'custom.conflict_address_city')).toBe('Mumbai');
    await b.sync.sync();
    expect(await value(b, 'custom.conflict_address_city')).toBe('Mumbai');
  });

  it('a device that pushes on an outdated version retries after merging', async () => {
    const { cloud, a, b } = await twoDevices();
    clock += 10_000;
    await a.repos.facts.setValue('links.github', 'github.com/priya');
    await b.repos.facts.setValue('skills', ['Excel']);
    await a.sync.sync();
    const pushesBefore = cloud.pushes;
    expect(await b.sync.sync()).toMatchObject({ status: 'merged', version: 3 });
    expect(cloud.pushes).toBe(pushesBefore + 1);
    await a.sync.sync();
    expect(await value(a, 'skills')).toEqual(['Excel']);
    expect(await value(b, 'links.github')).toBe('github.com/priya');
  });

  it('detects a cloud vault from a different passphrase and lets the user pick', async () => {
    const { cloud } = await twoDevices();
    const c = await device('tablet', cloud);
    await c.vault.create('a different passphrase');
    await c.repos.facts.setValue('address.city', 'Delhi');
    expect(await c.sync.sync()).toEqual({ status: 'different-vault', cloudVersion: 1 });
    await c.sync.replaceCloudCopy();
    expect(cloud.stored?.version).toBe(2);
    const d = await device('desktop', cloud);
    await d.sync.useCloudCopy('a different passphrase');
    expect(await value(d, 'address.city')).toBe('Delhi');
  });

  it('the cloud only ever holds ciphertext: no values, no key names, no sites', async () => {
    const { cloud, a } = await twoDevices();
    await a.repos.fieldMemory.upsert({
      signature: 'f'.repeat(64),
      site: 'upwork.com',
      canonicalKey: 'bio.headline',
    });
    await a.repos.facts.setValue('custom.team_name', 'Rocket');
    await a.sync.sync();
    const stored = JSON.stringify(cloud.stored);
    for (const secret of [
      'Priya',
      'Pune',
      'Rocket',
      'upwork',
      'person.name.full',
      'address.city',
      'custom.team_name',
      'bio.headline',
    ]) {
      expect(stored).not.toContain(secret);
    }
    expect(Object.keys(cloud.stored!).sort()).toEqual([
      'blob',
      'deviceId',
      'kdf',
      'updatedAt',
      'verifier',
      'version',
    ]);
  });
});

describe('change events', () => {
  it('fire for user writes and deletes, not for applied sync snapshots', async () => {
    const { a, b } = await twoDevices();
    let changes = 0;
    b.vault.onChange(() => changes++);
    await b.repos.facts.setValue('links.github', 'github.com/priya');
    await b.repos.facts.delete('links.github');
    expect(changes).toBe(2);
    clock += 10_000;
    await a.repos.facts.setValue('address.city', 'Goa');
    await a.sync.sync();
    await b.sync.sync();
    expect(changes).toBe(2);
  });
});
