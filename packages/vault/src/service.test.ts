import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  BackupFormatError,
  VaultExistsError,
  VaultLockedError,
  VaultNotInitializedError,
  WeakPassphraseError,
  WrongPassphraseError,
} from './errors';
import { createRepositories } from './repositories';
import { VaultService, type SessionKeyStore } from './service';
import { PASS, makeVault } from './test-helpers';

afterEach(() => {
  vi.useRealTimers();
});

function memoryStore(): SessionKeyStore & { entry: { key: string; lastActivity: number } | null } {
  return {
    entry: null,
    async get() {
      return this.entry;
    },
    async set(entry) {
      this.entry = entry;
    },
    async clear() {
      this.entry = null;
    },
  };
}

describe('VaultService lifecycle', () => {
  it('moves uninitialized → unlocked → locked → unlocked', async () => {
    const vault = makeVault();
    expect(await vault.status()).toBe('uninitialized');
    await vault.create(PASS);
    expect(await vault.status()).toBe('unlocked');
    vault.lock();
    expect(await vault.status()).toBe('locked');
    await vault.unlock(PASS);
    expect(await vault.status()).toBe('unlocked');
  });

  it('refuses weak passphrases, a second create, and unlocking a missing vault', async () => {
    const vault = makeVault();
    await expect(vault.create('short')).rejects.toBeInstanceOf(WeakPassphraseError);
    await expect(vault.unlock(PASS)).rejects.toBeInstanceOf(VaultNotInitializedError);
    await vault.create(PASS);
    await expect(vault.create(PASS)).rejects.toBeInstanceOf(VaultExistsError);
  });

  it('rejects the wrong passphrase and stays locked', async () => {
    const vault = makeVault();
    await vault.create(PASS);
    vault.lock();
    await expect(vault.unlock('not the passphrase')).rejects.toBeInstanceOf(WrongPassphraseError);
    expect(vault.isUnlocked()).toBe(false);
  });

  it('blocks reads and writes while locked', async () => {
    const vault = makeVault();
    const repos = createRepositories(vault);
    await vault.create(PASS);
    await repos.facts.setValue('address.city', 'Pune');
    vault.lock();
    await expect(repos.facts.get('address.city')).rejects.toBeInstanceOf(VaultLockedError);
    await expect(repos.facts.setValue('address.city', 'Mumbai')).rejects.toBeInstanceOf(
      VaultLockedError,
    );
    await vault.unlock(PASS);
    expect((await repos.facts.get('address.city'))?.value).toBe('Pune');
  });

  it('refuses unsafe PBKDF2 settings unless explicitly in test mode', () => {
    expect(() => new VaultService({ dbName: 'x', kdfIterations: 1_000 })).toThrow(/at least/);
  });

  it('works end-to-end with the production KDF default', async () => {
    const vault = new VaultService({ dbName: `prod-kdf-${Math.random()}` });
    await vault.create(PASS);
    const meta = await vault.db.meta.get('vault');
    expect(meta?.iterations).toBe(600_000);
    vault.lock();
    await vault.unlock(PASS);
    expect(vault.isUnlocked()).toBe(true);
  }, 30_000);
});

describe('auto-lock', () => {
  it('locks after the idle timeout and notifies listeners', async () => {
    let now = 1_000_000;
    const vault = makeVault({ autoLockMinutes: 15, now: () => now });
    const onLock = vi.fn();
    vault.onLock(onLock);
    await vault.create(PASS);
    now += 14 * 60_000;
    expect(vault.isUnlocked()).toBe(true);
    now += 60_000;
    expect(vault.isUnlocked()).toBe(false);
    expect(onLock).toHaveBeenCalledTimes(1);
  });

  it('postpones auto-lock on activity', async () => {
    let now = 1_000_000;
    const vault = makeVault({ autoLockMinutes: 15, now: () => now });
    const repos = createRepositories(vault);
    await vault.create(PASS);
    for (let i = 0; i < 4; i++) {
      now += 10 * 60_000;
      await repos.facts.list(); // activity
    }
    expect(vault.isUnlocked()).toBe(true);
  });

  it('locks from the timer even without further calls', async () => {
    const vault = makeVault({ autoLockMinutes: 1 });
    await vault.create(PASS);
    // Fake only the clock and timers; fake-indexeddb needs the real scheduler.
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    vault.touch(); // re-arm the auto-lock timer under the fake clock
    vi.advanceTimersByTime(59_000);
    expect(vault.isUnlocked()).toBe(true);
    vi.advanceTimersByTime(2_000);
    expect(vault.isUnlocked()).toBe(false);
  });

  it('can be disabled with 0 minutes', async () => {
    let now = 0;
    const vault = makeVault({ autoLockMinutes: 0, now: () => now });
    await vault.create(PASS);
    now += 24 * 3_600_000;
    expect(vault.isUnlocked()).toBe(true);
  });
});

describe('service worker restarts', () => {
  it('starts locked with data intact after the worker is killed (memory-only mode)', async () => {
    const first = makeVault();
    await first.create(PASS);
    await createRepositories(first).facts.setValue('contact.email', 'priya@example.com');
    // Simulate a killed worker: a brand-new service over the same database.
    const revived = new VaultService({
      db: first.db,
      kdfIterations: 1_000,
      allowWeakKdfForTests: true,
    });
    expect(await revived.status()).toBe('locked');
    expect(await revived.resume()).toBe(false);
    await revived.unlock(PASS);
    expect((await createRepositories(revived).facts.get('contact.email'))?.value).toBe(
      'priya@example.com',
    );
  });

  it('resumes from the session key store when the user opted in', async () => {
    const store = memoryStore();
    const first = makeVault({ sessionKeyStore: store });
    await first.create(PASS);
    await createRepositories(first).facts.setValue('address.city', 'Pune');
    expect(store.entry).not.toBeNull();
    const revived = new VaultService({
      db: first.db,
      sessionKeyStore: store,
      kdfIterations: 1_000,
      allowWeakKdfForTests: true,
    });
    expect(await revived.resume()).toBe(true);
    expect((await createRepositories(revived).facts.get('address.city'))?.value).toBe('Pune');
  });

  it('does not resume an idle session, and clears the store on lock', async () => {
    let now = 5_000_000;
    const store = memoryStore();
    const first = makeVault({ sessionKeyStore: store, now: () => now });
    await first.create(PASS);
    now += 16 * 60_000;
    const revived = new VaultService({
      db: first.db,
      sessionKeyStore: store,
      now: () => now,
      kdfIterations: 1_000,
      allowWeakKdfForTests: true,
    });
    expect(await revived.resume()).toBe(false);
    expect(store.entry).toBeNull();

    now += 1;
    await revived.unlock(PASS);
    expect(store.entry).not.toBeNull();
    revived.lock();
    await Promise.resolve();
    expect(store.entry).toBeNull();
  });

  it('refuses a session key that does not open the verifier', async () => {
    const store = memoryStore();
    const vault = makeVault({ sessionKeyStore: store });
    await vault.create(PASS);
    const revived = new VaultService({
      db: vault.db,
      sessionKeyStore: store,
      kdfIterations: 1_000,
      allowWeakKdfForTests: true,
    });
    store.entry = { key: btoa('x'.repeat(32)), lastActivity: Date.now() };
    expect(await revived.resume()).toBe(false);
  });
});

describe('changePassphrase', () => {
  it('re-encrypts every record under the new passphrase', async () => {
    const vault = makeVault();
    const repos = createRepositories(vault);
    await vault.create(PASS);
    await repos.facts.setValue('contact.email', 'priya@example.com');
    await repos.fieldMemory.upsert({
      signature: 'a'.repeat(64),
      site: 'upwork.com',
      canonicalKey: 'bio.headline',
    });
    await repos.answers.add({
      id: 'a1',
      questionText: 'Overview',
      platform: 'upwork.com',
      goal: 'g',
      value: 'I help',
      approvedAt: new Date().toISOString(),
    });
    const before = await vault.db.facts.get('contact.email');

    await vault.changePassphrase(PASS, 'a brand new passphrase');
    const after = await vault.db.facts.get('contact.email');
    expect(after?.ciphertext).not.toBe(before?.ciphertext);

    vault.lock();
    await expect(vault.unlock(PASS)).rejects.toBeInstanceOf(WrongPassphraseError);
    await vault.unlock('a brand new passphrase');
    expect((await repos.facts.get('contact.email'))?.value).toBe('priya@example.com');
    expect((await repos.fieldMemory.get('a'.repeat(64)))?.canonicalKey).toBe('bio.headline');
    expect((await repos.answers.get('a1'))?.value).toBe('I help');
  });

  it('rejects a wrong old passphrase without changing anything', async () => {
    const vault = makeVault();
    await vault.create(PASS);
    await expect(
      vault.changePassphrase('wrong passphrase', 'new passphrase!'),
    ).rejects.toBeInstanceOf(WrongPassphraseError);
    vault.lock();
    await vault.unlock(PASS);
  });

  it('is atomic: a corrupted record aborts before anything is written', async () => {
    const vault = makeVault();
    const repos = createRepositories(vault);
    await vault.create(PASS);
    await repos.facts.setValue('contact.email', 'priya@example.com');
    await repos.facts.setValue('address.city', 'Pune');
    const row = await vault.db.facts.get('address.city');
    await vault.db.facts.put({ ...row!, ciphertext: btoa('garbage-garbage-garbage') });

    await expect(vault.changePassphrase(PASS, 'another passphrase')).rejects.toThrow();
    vault.lock();
    await vault.unlock(PASS); // old passphrase still works
    expect((await repos.facts.get('contact.email'))?.value).toBe('priya@example.com');
  });

  it('is atomic: a failed write inside the transaction rolls every table back', async () => {
    const vault = makeVault();
    const repos = createRepositories(vault);
    await vault.create(PASS);
    await repos.facts.setValue('contact.email', 'priya@example.com');
    await repos.answers.add({
      id: 'a1',
      questionText: 'Q',
      platform: 'x.com',
      goal: 'g',
      value: 'v',
      approvedAt: new Date().toISOString(),
    });
    const factBefore = await vault.db.facts.get('contact.email');
    const metaBefore = await vault.db.meta.get('vault');

    const spy = vi.spyOn(vault.db.answers, 'bulkPut').mockRejectedValueOnce(new Error('disk full'));
    await expect(vault.changePassphrase(PASS, 'another passphrase')).rejects.toThrow('disk full');
    spy.mockRestore();

    expect(await vault.db.facts.get('contact.email')).toEqual(factBefore);
    expect(await vault.db.meta.get('vault')).toEqual(metaBefore);
    vault.lock();
    await vault.unlock(PASS);
    expect((await repos.facts.get('contact.email'))?.value).toBe('priya@example.com');
  });
});

describe('backup, import and wipe', () => {
  it('export → wipe → import restores identical facts', async () => {
    const vault = makeVault();
    const repos = createRepositories(vault);
    await vault.create(PASS);
    await repos.facts.setValue('person.name.full', 'Priya Sharma');
    await repos.facts.setValue('skills', ['SQL', 'Excel']);
    await repos.facts.setValue('projects[0].name', 'GST Shield AI');
    const before = await repos.facts.list();
    const backup = await vault.exportBackup();
    expect(backup).not.toContain('Priya');

    await vault.wipe();
    expect(await vault.status()).toBe('uninitialized');

    await vault.importBackup(backup, PASS);
    expect(await vault.status()).toBe('unlocked');
    expect(await repos.facts.list()).toEqual(before);
  });

  it('imports into another device and replaces what was there', async () => {
    const source = makeVault();
    await source.create(PASS);
    await createRepositories(source).facts.setValue('address.city', 'Pune');
    const backup = await source.exportBackup();

    const target = makeVault();
    await target.create('other device passphrase');
    await createRepositories(target).facts.setValue('address.city', 'Delhi');
    await target.importBackup(backup, PASS);
    expect((await createRepositories(target).facts.get('address.city'))?.value).toBe('Pune');
    target.lock();
    await target.unlock(PASS);
  });

  it('rejects wrong passphrases, junk files and damaged backups without changing the vault', async () => {
    const vault = makeVault();
    const repos = createRepositories(vault);
    await vault.create(PASS);
    await repos.facts.setValue('address.city', 'Pune');
    const backup = await vault.exportBackup();

    await expect(vault.importBackup(backup, 'wrong passphrase')).rejects.toBeInstanceOf(
      WrongPassphraseError,
    );
    await expect(vault.importBackup('{"hello":1}', PASS)).rejects.toBeInstanceOf(BackupFormatError);
    await expect(vault.importBackup('not json', PASS)).rejects.toBeInstanceOf(BackupFormatError);

    const damaged = JSON.parse(backup);
    damaged.tables.facts[0].ciphertext = btoa('tampered-tampered');
    await expect(vault.importBackup(JSON.stringify(damaged), PASS)).rejects.toBeInstanceOf(
      BackupFormatError,
    );

    expect((await repos.facts.get('address.city'))?.value).toBe('Pune');
  });

  it('requires an unlocked vault to export', async () => {
    const vault = makeVault();
    await vault.create(PASS);
    vault.lock();
    await expect(vault.exportBackup()).rejects.toBeInstanceOf(VaultLockedError);
  });
});
