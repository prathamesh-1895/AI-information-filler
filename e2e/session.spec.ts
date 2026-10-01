import type { Page } from '@playwright/test';
import { expect, test } from './fixtures';
import { submits } from './agent';

/**
 * PLAYBOOK Phase 5 end to end, through the real extension: the background
 * worker hosts the vault and the session; the panel page drives it with the
 * same messages the Phase 6 UI will send.
 */

type Reply<T = unknown> =
  { ok: true; data: T } | { ok: false; error: { code: string; message: string } };
interface PlanItem {
  fieldId: string;
  value?: string | string[];
  question?: string;
  status: string;
  source?: string;
  kind: string;
}
interface State {
  phase: string;
  fields: Array<{ id: string; label: string }>;
  plan: PlanItem[];
}

const send = <T>(panel: Page, message: unknown) =>
  panel.evaluate((m) => chrome.runtime.sendMessage(m), message) as Promise<Reply<T>>;

async function data<T>(panel: Page, message: unknown): Promise<T> {
  const reply = await send<T>(panel, message);
  if (!reply.ok)
    throw new Error(
      `${JSON.stringify(message)} failed: ${reply.error.code} ${reply.error.message}`,
    );
  return reply.data;
}

async function openPanel(
  context: import('@playwright/test').BrowserContext,
  extensionId: string,
  fixture: string,
) {
  const page = await context.newPage();
  await page.goto(`/${fixture}`);
  const panel = await context.newPage();
  await panel.goto(`chrome-extension://${extensionId}/sidepanel.html`);
  const target = await data<{ tabId: number }>(panel, {
    type: 'GET_TARGET_TAB',
    selfTabId: await panel.evaluate(async () => (await chrome.tabs.getCurrent())!.id),
  });
  return { page, panel, tabId: target.tabId };
}

const itemFor = (s: State, label: string) => {
  const field = s.fields.find((f) => f.label === label)!;
  return s.plan.find((p) => p.fieldId === field.id)!;
};
const questionLabels = (s: State) =>
  s.plan.filter((p) => p.question).map((p) => s.fields.find((f) => f.id === p.fieldId)!.label);

test('ask once, remember forever: second visit asks zero questions', async ({
  context,
  extensionId,
}) => {
  const { page, panel, tabId } = await openPanel(context, extensionId, 'simple-contact.html');
  expect(await data(panel, { type: 'VAULT_STATUS' })).toEqual({ status: 'uninitialized' });
  await data(panel, { type: 'VAULT_CREATE', passphrase: 'correct horse battery' });
  await data(panel, { type: 'FACT_SET', key: 'person.name.full', value: 'Priya Sharma' });
  await data(panel, { type: 'FACT_SET', key: 'contact.email', value: 'priya@example.com' });
  await data(panel, { type: 'FACT_SET', key: 'address.city', value: 'Pune' });

  let s = await data<State>(panel, { type: 'SESSION_START', tabId });
  expect(s.phase).toBe('AWAITING_REVIEW');
  expect(questionLabels(s)).toEqual(['Mobile number', 'Message']);

  for (const [label, value] of [
    ['Mobile number', '+91 98765 43210'],
    ['Message', 'Please call me back.'],
  ] as const) {
    s = await data<State>(panel, {
      type: 'SESSION_EVENT',
      tabId,
      event: { type: 'ANSWER', fieldId: itemFor(s, label).fieldId, value, save: true },
    });
  }
  await data(panel, { type: 'SESSION_EVENT', tabId, event: { type: 'APPROVE_ALL_VAULT' } });
  s = await data<State>(panel, { type: 'SESSION_EVENT', tabId, event: { type: 'FILL' } });
  expect(s.phase).toBe('READY_TO_SUBMIT');
  await expect(page.locator('#full-name')).toHaveValue('Priya Sharma');
  await expect(page.locator('#phone')).toHaveValue('+91 98765 43210');
  await expect(page.locator('#message')).toHaveValue('Please call me back.');
  expect(await submits(page)).toEqual([]);

  // Reload: the page agent is gone, the vault remembers.
  await page.reload();
  s = await data<State>(panel, { type: 'SESSION_START', tabId });
  expect(questionLabels(s)).toEqual([]);
  expect(itemFor(s, 'Message')).toMatchObject({ value: 'Please call me back.', source: 'memory' });
  await data(panel, { type: 'SESSION_EVENT', tabId, event: { type: 'APPROVE_ALL_VAULT' } });
  s = await data<State>(panel, { type: 'SESSION_EVENT', tabId, event: { type: 'FILL' } });
  expect(s.phase).toBe('READY_TO_SUBMIT');
  await expect(page.locator('#phone')).toHaveValue('+91 98765 43210');
  expect(await submits(page)).toEqual([]);
});

test('wizard: the next step is planned from the vault automatically', async ({
  context,
  extensionId,
}) => {
  const { page, panel, tabId } = await openPanel(context, extensionId, 'upwork-profile-like.html');
  await data(panel, { type: 'VAULT_CREATE', passphrase: 'correct horse battery' });
  for (const [key, value] of Object.entries({
    'bio.headline': 'Business Consultant for Growing SMBs',
    'preferences.hourly_rate': '25',
    skills: ['Excel', 'SQL'],
    'languages[0].proficiency': 'Fluent',
    'address.line1': 'Flat 4B, Sunrise Apartments',
    'address.city': 'Pune',
    'address.postal_code': '411001',
    'contact.phone.mobile': '+91 98765 43210',
  })) {
    await data(panel, { type: 'FACT_SET', key, value });
  }
  let s = await data<State>(panel, { type: 'SESSION_START', tabId });
  expect(itemFor(s, 'Profile overview')).toMatchObject({
    kind: 'open_ended',
    question: expect.any(String),
  }); // offline: you write it
  expect(itemFor(s, 'Experience level').question).toBeDefined();
  await data(panel, { type: 'SESSION_EVENT', tabId, event: { type: 'APPROVE_ALL_VAULT' } });
  s = await data<State>(panel, { type: 'SESSION_EVENT', tabId, event: { type: 'FILL' } });
  expect(s.phase).toBe('AWAITING_REVIEW'); // overview and experience level still need you
  await expect(page.locator('#title')).toHaveValue('Business Consultant for Growing SMBs');
  await expect(page.locator('.chip')).toHaveText(['Excel', 'SQL']);
  await expect(page.locator('#english')).toHaveValue('fluent');

  // The user clicks Next themselves; the observer reports step 2 and the host plans it.
  await page.getByRole('button', { name: 'Next' }).click();
  await expect
    .poll(async () => {
      const st = await data<State | null>(panel, { type: 'SESSION_GET', tabId });
      return st?.fields.map((f) => f.label) ?? [];
    })
    .toEqual(['Street address', 'City', 'ZIP/Postal code', 'Phone']);
  await expect
    .poll(async () => (await data<State>(panel, { type: 'SESSION_GET', tabId })).phase)
    .toBe('AWAITING_REVIEW');
  s = await data<State>(panel, { type: 'SESSION_GET', tabId });
  expect(questionLabels(s)).toEqual([]);
  await data(panel, { type: 'SESSION_EVENT', tabId, event: { type: 'APPROVE_ALL_VAULT' } });
  s = await data<State>(panel, { type: 'SESSION_EVENT', tabId, event: { type: 'FILL' } });
  expect(s.phase).toBe('READY_TO_SUBMIT');
  await expect(page.locator('#zip')).toHaveValue('411001');
  await expect(page.locator('#phone')).toHaveValue('+91 98765 43210');
  expect(await submits(page)).toEqual([]);
});

test('vault errors come back as readable codes; page scripts still cannot reach the vault', async ({
  context,
  extensionId,
}) => {
  const { page, panel } = await openPanel(context, extensionId, 'simple-contact.html');
  expect(await send(panel, { type: 'FACT_LIST' })).toMatchObject({
    ok: false,
    error: { code: 'VAULT_LOCKED' },
  });
  expect(await send(panel, { type: 'VAULT_UNLOCK', passphrase: 'x' })).toMatchObject({
    ok: false,
    error: { code: 'VAULT_MISSING' },
  });
  expect(await send(panel, { type: 'VAULT_CREATE', passphrase: 'short' })).toMatchObject({
    ok: false,
    error: { code: 'INVALID' },
  });
  await data(panel, { type: 'VAULT_CREATE', passphrase: 'correct horse battery' });
  expect(
    await send(panel, { type: 'FACT_SET', key: 'custom.passport_number', value: 'Z1234567' }),
  ).toMatchObject({ ok: false, error: { code: 'INVALID' } });
  await data(panel, { type: 'VAULT_LOCK' });
  expect(await send(panel, { type: 'VAULT_UNLOCK', passphrase: 'wrong passphrase' })).toMatchObject(
    { ok: false, error: { code: 'WRONG_PASSPHRASE' } },
  );

  // A script in the page's isolated world asks for the vault: no answer.
  const leaked = await panel.evaluate(
    async (tabId) => {
      const [res] = await chrome.scripting.executeScript({
        target: { tabId },
        func: async () => {
          try {
            return (await chrome.runtime.sendMessage({ type: 'FACT_LIST' })) ?? null;
          } catch {
            return null;
          }
        },
      });
      return res!.result;
    },
    (
      await data<{ tabId: number }>(panel, {
        type: 'GET_TARGET_TAB',
        selfTabId: await panel.evaluate(async () => (await chrome.tabs.getCurrent())!.id),
      })
    ).tabId,
  );
  expect(leaked).toBeNull();
  expect(await submits(page)).toEqual([]);
});
