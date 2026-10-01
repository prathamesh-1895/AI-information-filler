import 'fake-indexeddb/auto';
import { readFileSync } from 'node:fs';
import type { FieldDescriptor, SessionState } from '@filler/core';
import { createRepositories, VaultService } from '@filler/vault';
import { describe, expect, it, vi } from 'vitest';
import type { FillItem, PageScan } from '../messaging/protocol';
import { SessionHost } from './host';

const snapshot = (name: string): FieldDescriptor[] =>
  (
    JSON.parse(
      readFileSync(
        new URL(`../../../../test-fixtures/__scans__/${name}.json`, import.meta.url),
        'utf8',
      ),
    ) as Array<FieldDescriptor & { ref: string }>
  ).map(({ ref: _ref, ...f }, i) => ({ ...f, id: `0:f${i}` }));

async function setup(fields: FieldDescriptor[]) {
  const vault = new VaultService({
    dbName: `host-${Math.random()}`,
    kdfIterations: 1_000,
    allowWeakKdfForTests: true,
  });
  const repos = createRepositories(vault);
  await vault.create('correct horse battery');
  const filled: FillItem[][] = [];
  const states: SessionState[] = [];
  const scan: PageScan = {
    tabId: 1,
    url: 'http://127.0.0.1:5178/simple-contact.html',
    title: 'Simple contact form',
    scannedAt: '',
    frames: 1,
    fields,
    errors: [],
  };
  const deps = {
    vault,
    repos,
    scanTab: vi.fn(async () => ({ ok: true as const, data: scan })),
    fillTab: vi.fn(async (_tab: number, items: FillItem[]) => {
      filled.push(items);
      return {
        ok: true as const,
        data: items.map((i) => ({ fieldId: i.fieldId, status: 'filled' as const })),
      };
    }),
    highlightTab: vi.fn(async () => undefined),
    observeTab: vi.fn(async () => undefined),
    endTab: vi.fn(async () => undefined),
    publish: (_tab: number, s: SessionState) => void states.push(s),
  };
  return { host: new SessionHost(deps), vault, repos, filled, states, deps };
}

const questions = (s: SessionState) => s.plan.filter((p) => p.question !== undefined);
const byLabel = (s: SessionState, label: string) => {
  const field = s.fields.find((f) => f.label === label)!;
  return { field, item: s.plan.find((p) => p.fieldId === field.id)! };
};

describe('SessionHost', () => {
  it('ask once, remember forever (PLAYBOOK Task 5.5)', async () => {
    const { host, repos, filled, deps } = await setup(snapshot('simple-contact'));
    await repos.facts.setValue('person.name.full', 'Priya Sharma');
    await repos.facts.setValue('contact.email', 'priya@example.com');
    await repos.facts.setValue('address.city', 'Pune');

    let s = await host.start(1);
    expect(s.phase).toBe('AWAITING_REVIEW');
    expect(questions(s).map((q) => s.fields.find((f) => f.id === q.fieldId)!.label)).toEqual([
      'Mobile number',
      'Message',
    ]);
    expect(byLabel(s, 'Full name').item).toMatchObject({
      value: 'Priya Sharma',
      source: 'vault',
      status: 'pending',
    });
    expect(deps.observeTab).toHaveBeenCalledWith(1);
    expect(deps.highlightTab).toHaveBeenCalled();

    s = await host.dispatch(1, {
      type: 'ANSWER',
      fieldId: byLabel(s, 'Mobile number').field.id,
      value: '+91 98765 43210',
      save: true,
    });
    s = await host.dispatch(1, {
      type: 'ANSWER',
      fieldId: byLabel(s, 'Message').field.id,
      value: 'Please call me back.',
      save: true,
    });
    s = await host.dispatch(1, { type: 'APPROVE_ALL_VAULT' });
    s = await host.dispatch(1, { type: 'FILL' });
    expect(s.phase).toBe('READY_TO_SUBMIT');
    expect(filled[0]!.map((i) => i.value)).toEqual([
      'Priya Sharma',
      'priya@example.com',
      '+91 98765 43210',
      'Pune',
      'Please call me back.',
    ]);

    // The answers are now in the vault, under a canonical key and a custom key.
    expect((await repos.facts.get('contact.phone.mobile'))?.value).toBe('+91 98765 43210');
    expect(await repos.facts.get('custom.message')).toMatchObject({
      value: 'Please call me back.',
      learnedOn: '127.0.0.1',
    });

    // Next visit: zero questions.
    s = await host.start(1);
    expect(questions(s)).toEqual([]);
    expect(byLabel(s, 'Message').item).toMatchObject({
      value: 'Please call me back.',
      source: 'memory',
    });
  });

  it('"use once, don\'t save" asks again next time', async () => {
    const { host, repos } = await setup(snapshot('simple-contact'));
    let s = await host.start(1);
    const city = byLabel(s, 'City').field.id;
    s = await host.dispatch(1, { type: 'ANSWER', fieldId: city, value: 'Pune', save: false });
    expect(byLabel(s, 'City').item).toMatchObject({
      value: 'Pune',
      source: 'user',
      status: 'approved',
    });
    expect(await repos.facts.get('address.city')).toBeUndefined();
    s = await host.start(1);
    expect(byLabel(s, 'City').item.question).toBeDefined();
  });

  it('a sensitive answer is refused by the vault and the question comes back', async () => {
    const { host, repos } = await setup(snapshot('simple-contact'));
    let s = await host.start(1);
    const city = byLabel(s, 'City').field.id;
    s = await host.dispatch(1, {
      type: 'ANSWER',
      fieldId: city,
      value: '4111 1111 1111 1111',
      save: true,
    });
    expect(byLabel(s, 'City').item).toMatchObject({
      status: 'pending',
      question: expect.any(String),
      reason: expect.stringContaining('card number'),
    });
    expect(await repos.facts.get('address.city')).toBeUndefined();
  });

  it('locking the vault mid-session hides values; unlocking re-plans', async () => {
    const { host, vault, repos } = await setup(snapshot('simple-contact'));
    await repos.facts.setValue('address.city', 'Pune');
    let s = await host.start(1);
    expect(byLabel(s, 'City').item.value).toBe('Pune');
    vault.lock();
    s = await host.dispatch(1, { type: 'VAULT_LOCKED' });
    expect(s.phase).toBe('ERROR');
    expect(byLabel(s, 'City').item.value).toBeUndefined();
    await vault.unlock('correct horse battery');
    s = await host.dispatch(1, { type: 'VAULT_UNLOCKED' });
    expect(s.phase).toBe('AWAITING_REVIEW');
    expect(byLabel(s, 'City').item.value).toBe('Pune');
  });

  it('starting with a locked vault reports it instead of guessing', async () => {
    const { host, vault } = await setup(snapshot('simple-contact'));
    vault.lock();
    const s = await host.start(1);
    expect(s).toMatchObject({ phase: 'ERROR', error: { code: 'VAULT_LOCKED' } });
  });

  it('fills a job application from the vault: split DOB, education by section, denied nothing', async () => {
    const { host, repos } = await setup(snapshot('job-application-like'));
    for (const [k, v] of Object.entries({
      'person.name.full': 'Priya Rajesh Sharma',
      'contact.email': 'priya@example.com',
      'contact.phone.mobile': '+91 98765 43210',
      'person.dob': '2003-02-02',
      'education[0].institution': 'PICT',
      'education[0].degree': 'B.E.',
      'education[1].institution': 'Fergusson College',
      'education[0].start': 'Aug 2022',
      'links.linkedin': 'linkedin.com/in/priya',
    })) {
      await repos.facts.setValue(k, v);
    }
    const s = await host.start(1);
    const value = (label: string, section?: string) =>
      s.plan.find((p) => {
        const f = s.fields.find((x) => x.id === p.fieldId)!;
        return f.label === label && (!section || f.sectionHeading === section);
      })?.value;
    expect(value('First name')).toBe('Priya');
    expect(value('Last name')).toBe('Sharma');
    expect(value('Phone')).toBe('9876543210'); // maxlength 10 + pattern
    expect([value('Day'), value('Month'), value('Year')]).toEqual(['2', '2', '2003']); // matched to the select options
    expect(value('Institution', 'Education 2')).toBe('Fergusson College');
    expect(value('Start', 'Education 1')).toBe('2022-08');
    expect(value('LinkedIn profile')).toBe('https://linkedin.com/in/priya');
  });
});
