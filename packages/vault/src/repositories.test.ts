import { describe, expect, it } from 'vitest';
import { VaultValidationError } from './errors';
import { createRepositories, questionSimilarity } from './repositories';
import { PASS, makeVault } from './test-helpers';

async function setup() {
  const vault = makeVault();
  await vault.create(PASS);
  return { vault, repos: createRepositories(vault) };
}

const now = () => new Date().toISOString();

/** Reads every row of every object store straight from IndexedDB, bypassing Dexie and the vault. */
function dumpRawDatabase(name: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const open = indexedDB.open(name);
    open.onerror = () => reject(open.error);
    open.onsuccess = () => {
      const db = open.result;
      const stores = Array.from(db.objectStoreNames);
      const tx = db.transaction(stores, 'readonly');
      const rows: unknown[] = [];
      for (const store of stores) {
        const req = tx.objectStore(store).getAll();
        req.onsuccess = () => rows.push({ store, rows: req.result });
      }
      tx.oncomplete = () => {
        db.close();
        resolve(JSON.stringify(rows));
      };
      tx.onerror = () => reject(tx.error);
    };
  });
}

describe('FactRepo', () => {
  it('sets, gets, lists (sorted) and deletes facts', async () => {
    const { repos } = await setup();
    await repos.facts.setValue('contact.email', 'priya@example.com');
    await repos.facts.setValue('address.city', 'Pune');
    await repos.facts.setValue('skills', ['SQL', 'Excel']);
    expect((await repos.facts.get('contact.email'))?.value).toBe('priya@example.com');
    expect((await repos.facts.list()).map((f) => f.key)).toEqual([
      'address.city',
      'contact.email',
      'skills',
    ]);
    await repos.facts.delete('address.city');
    expect(await repos.facts.get('address.city')).toBeUndefined();
  });

  it('overwrites a fact with the same key', async () => {
    const { repos } = await setup();
    await repos.facts.setValue('address.city', 'Pune');
    await repos.facts.setValue('address.city', 'Mumbai');
    expect((await repos.facts.list()).filter((f) => f.key === 'address.city')).toHaveLength(1);
    expect((await repos.facts.get('address.city'))?.value).toBe('Mumbai');
  });

  it('groups list items and scalars by group', async () => {
    const { repos } = await setup();
    await repos.facts.setValue('projects[0].name', 'GST Shield AI');
    await repos.facts.setValue('projects[1].name', 'Filler');
    await repos.facts.setValue('contact.email', 'priya@example.com');
    expect((await repos.facts.byGroup('projects')).map((f) => f.value)).toEqual([
      'GST Shield AI',
      'Filler',
    ]);
  });

  it('applies registry sensitivity defaults and records where a fact was learned', async () => {
    const { repos } = await setup();
    const phone = await repos.facts.setValue('contact.phone.mobile', '+91 98765 43210', {
      learnedOn: 'https://www.upwork.com/x',
    });
    expect(phone.sensitivity).toBe('personal');
    expect(phone.learnedOn).toBe('upwork.com');
    expect((await repos.facts.setValue('address.city', 'Pune')).sensitivity).toBe('public');
    expect((await repos.facts.setValue('custom.favorite_tools', 'Notion')).sensitivity).toBe(
      'public',
    );
  });

  it('allows raising sensitivity but not lowering it below the registry default', async () => {
    const { repos } = await setup();
    await expect(
      repos.facts.setValue('address.city', 'Pune', { sensitivity: 'restricted' }),
    ).resolves.toMatchObject({ sensitivity: 'restricted' });
    await expect(
      repos.facts.setValue('person.dob', '2003-05-14', { sensitivity: 'public' }),
    ).rejects.toBeInstanceOf(VaultValidationError);
    await expect(
      repos.facts.setValue('contact.email', 'a@b.co', { sensitivity: 'public' }),
    ).rejects.toThrow(/at least personal/);
  });

  it.each([
    ['card number', 'custom.reference', '4111 1111 1111 1111'],
    ['Aadhaar', 'custom.reference', '2345 6789 0124'],
    ['PAN', 'custom.reference', 'ABCDE1234F'],
    ['card number inside a list', 'skills', ['SQL', '4111111111111111']],
  ])('rejects a %s value', async (_name, key, value) => {
    const { repos } = await setup();
    await expect(repos.facts.setValue(key, value)).rejects.toBeInstanceOf(VaultValidationError);
  });

  it.each([
    'custom.passport_number',
    'custom.bank_account_number',
    'custom.upi_pin',
    'custom.password',
  ])('rejects denied custom key %s', async (key) => {
    const { repos } = await setup();
    await expect(repos.facts.setValue(key, 'x')).rejects.toBeInstanceOf(VaultValidationError);
  });

  it('rejects unknown keys and malformed facts', async () => {
    const { repos } = await setup();
    await expect(repos.facts.setValue('contact.fax', 'x')).rejects.toBeInstanceOf(
      VaultValidationError,
    );
    await expect(repos.facts.setValue('projects[].name', 'x')).rejects.toBeInstanceOf(
      VaultValidationError,
    );
  });

  it('accepts ordinary phone numbers, including ones with a 91 prefix', async () => {
    const { repos } = await setup();
    await expect(
      repos.facts.setValue('contact.phone.mobile', '919876543216'),
    ).resolves.toBeDefined();
    await expect(repos.facts.setValue('contact.phone.alt', '9876543210')).resolves.toBeDefined();
  });
});

describe('DocumentRepo', () => {
  it('stores and lists documents', async () => {
    const { repos } = await setup();
    await repos.documents.put({
      id: 'd1',
      type: 'resume',
      name: 'cv.pdf',
      text: 'Priya Sharma, Pune',
      parsedFactKeys: ['person.name.full'],
      createdAt: now(),
    });
    expect((await repos.documents.get('d1'))?.name).toBe('cv.pdf');
    expect(await repos.documents.list()).toHaveLength(1);
    await repos.documents.delete('d1');
    expect(await repos.documents.list()).toHaveLength(0);
  });
});

describe('FieldMemoryRepo', () => {
  const sigA = 'a'.repeat(64);
  const sigB = 'b'.repeat(64);

  it('upserts and bumps usage', async () => {
    const { repos } = await setup();
    await repos.fieldMemory.upsert({
      signature: sigA,
      site: 'https://www.upwork.com/nx',
      canonicalKey: 'bio.headline',
    });
    const second = await repos.fieldMemory.upsert({ signature: sigA, site: 'upwork.com' });
    expect(second.timesUsed).toBe(2);
    expect(second.canonicalKey).toBe('bio.headline');
    expect(second.site).toBe('upwork.com');
  });

  it('keeps AI classifications apart from the user’s own mappings', async () => {
    const { repos } = await setup();
    const ai = await repos.fieldMemory.upsert({
      signature: sigA,
      site: 'x.com',
      via: 'ai',
      kind: 'open_ended',
    });
    expect(ai).toMatchObject({ via: 'ai', kind: 'open_ended' });
    // The user answers the field: their mapping replaces the AI one.
    const user = await repos.fieldMemory.upsert({
      signature: sigA,
      site: 'x.com',
      canonicalKey: 'custom.challenge',
    });
    expect(user).toMatchObject({ via: 'user', canonicalKey: 'custom.challenge', timesUsed: 2 });
    expect(user).not.toHaveProperty('kind');
    // A later AI guess never overwrites what the user decided.
    const again = await repos.fieldMemory.upsert({
      signature: sigA,
      site: 'x.com',
      via: 'ai',
      canonicalKey: 'bio.summary_long',
    });
    expect(again).toMatchObject({ via: 'user', canonicalKey: 'custom.challenge' });
  });

  it('forgets one site without touching others', async () => {
    const { repos } = await setup();
    await repos.fieldMemory.upsert({ signature: sigA, site: 'upwork.com' });
    await repos.fieldMemory.upsert({ signature: sigB, site: 'fiverr.com' });
    expect(await repos.fieldMemory.deleteBySite('www.upwork.com')).toBe(1);
    expect((await repos.fieldMemory.list()).map((m) => m.site)).toEqual(['fiverr.com']);
  });

  it('rejects malformed signatures', async () => {
    const { repos } = await setup();
    await expect(
      repos.fieldMemory.upsert({ signature: 'short', site: 'x.com' }),
    ).rejects.toBeInstanceOf(VaultValidationError);
  });
});

describe('AnswerRepo', () => {
  it('finds similar questions, preferring the same platform', async () => {
    const { repos } = await setup();
    const base = { goal: 'Business consultant', approvedAt: now() };
    await repos.answers.add({
      ...base,
      id: 'a1',
      questionText: 'Tell us about your previous projects',
      platform: 'fiverr.com',
      value: 'Fiverr answer',
    });
    await repos.answers.add({
      ...base,
      id: 'a2',
      questionText: 'Tell us about your previous projects',
      platform: 'upwork.com',
      value: 'Upwork answer',
    });
    await repos.answers.add({
      ...base,
      id: 'a3',
      questionText: 'What is your hourly rate?',
      platform: 'upwork.com',
      value: '25',
    });

    const results = await repos.answers.search('Previous projects? Tell us about them', {
      platform: 'www.upwork.com',
    });
    expect(results.map((r) => r.answer.id)).toEqual(['a2', 'a1']);
    expect(await repos.answers.search('Favourite colour')).toEqual([]);
  });

  it('scores question similarity sensibly', () => {
    expect(questionSimilarity('Profile overview', 'profile overview *')).toBe(1);
    expect(questionSimilarity('Profile overview', 'Hourly rate')).toBe(0);
    expect(questionSimilarity('', 'x')).toBe(0);
  });
});

describe('encryption at rest', () => {
  it('stores no plaintext value anywhere in IndexedDB', async () => {
    const { vault, repos } = await setup();
    const secrets = [
      'priya@example.com',
      'Priya Sharma',
      '+91 98765 43210',
      'GST Shield AI',
      'upwork.com',
      'I help small businesses',
      'cv-secret-text',
    ];
    await repos.facts.setValue('contact.email', secrets[0]!);
    await repos.facts.setValue('person.name.full', secrets[1]!);
    await repos.facts.setValue('contact.phone.mobile', secrets[2]!);
    await repos.facts.setValue('projects[0].name', secrets[3]!);
    await repos.fieldMemory.upsert({
      signature: 'c'.repeat(64),
      site: secrets[4]!,
      canonicalKey: 'bio.headline',
    });
    await repos.answers.add({
      id: 'a1',
      questionText: 'Overview',
      platform: 'fiverr.com',
      goal: 'g',
      value: secrets[5]!,
      approvedAt: now(),
    });
    await repos.documents.put({
      id: 'd1',
      type: 'resume',
      name: 'cv.pdf',
      text: secrets[6]!,
      parsedFactKeys: [],
      createdAt: now(),
    });

    const raw = await dumpRawDatabase(vault.db.name);
    expect(raw.length).toBeGreaterThan(500);
    for (const secret of [...secrets, 'fiverr.com', 'Overview', 'cv.pdf'])
      expect(raw).not.toContain(secret);
  });
});
