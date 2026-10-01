import type { BrowserContext, Page } from '@playwright/test';
import { expect, test } from './fixtures';
import { submits } from './agent';

/**
 * PLAYBOOK Tasks 11.2–11.4 end to end: a profile per family is recognised on
 * its fixture and only adds to what Filler does anyway (the generic fallback
 * still plans every page with profiles off); goal templates fill the chips;
 * history shows the last session and its answers can be re-used.
 */

type Reply<T = unknown> =
  { ok: true; data: T } | { ok: false; error: { code: string; message: string } };
interface State {
  phase: string;
  fields: Array<{ id: string; label: string }>;
  plan: Array<{
    fieldId: string;
    kind: string;
    canonicalKey?: string;
    value?: unknown;
    question?: string;
    status: string;
  }>;
  profile?: { id: string; name: string; tips: string[] };
  constraints?: Record<string, { lengthWindow?: [number, number]; tip?: string }>;
}

const PASS = 'correct horse battery staple';
const send = <T>(panel: Page, message: unknown) =>
  panel.evaluate((m) => chrome.runtime.sendMessage(m), message) as Promise<Reply<T>>;
async function data<T>(panel: Page, message: unknown): Promise<T> {
  const reply = await send<T>(panel, message);
  if (!reply.ok) throw new Error(`${JSON.stringify(message)} failed: ${reply.error.message}`);
  return reply.data;
}

async function openPanel(context: BrowserContext, extensionId: string, fixture: string) {
  const page = await context.newPage();
  await page.goto(`/${fixture}`);
  const panel = await context.newPage();
  await panel.setViewportSize({ width: 360, height: 1400 });
  await panel.goto(`chrome-extension://${extensionId}/sidepanel.html`);
  const target = await data<{ tabId: number }>(panel, {
    type: 'GET_TARGET_TAB',
    selfTabId: await panel.evaluate(async () => (await chrome.tabs.getCurrent())!.id),
  });
  return { page, panel, tabId: target.tabId };
}

const FAMILIES: Array<[string, string]> = [
  ['upwork-profile-like.html', 'freelance'],
  ['fiverr-seller-like.html', 'freelance'],
  ['job-application-like.html', 'jobs'],
  ['google-form-like.html', 'forms'],
  ['ai-understanding.html', 'events'],
  ['college-form-like.html', 'personal-details'],
];

test('each family fixture gets its profile; with profiles off the generic fallback still plans every field', async ({
  context,
  extensionId,
}) => {
  const page = await context.newPage();
  const panel = await context.newPage();
  await panel.goto(`chrome-extension://${extensionId}/sidepanel.html`);
  await data(panel, { type: 'VAULT_CREATE', passphrase: PASS });
  await data(panel, { type: 'FACT_SET', key: 'family.father_name', value: 'Ramesh Verma' });
  const selfTabId = await panel.evaluate(async () => (await chrome.tabs.getCurrent())!.id);

  for (const [fixture, family] of FAMILIES) {
    await page.goto(`/${fixture}`);
    await page.bringToFront();
    const { tabId } = await data<{ tabId: number }>(panel, { type: 'GET_TARGET_TAB', selfTabId });
    const withProfile = await data<State>(panel, { type: 'SESSION_START', tabId });
    expect(withProfile.phase, fixture).toBe('AWAITING_REVIEW');
    expect(withProfile.profile?.id, fixture).toBe(family);
    expect(withProfile.profile?.tips.length, fixture).toBeGreaterThan(0);

    await data(panel, { type: 'SETTINGS_SET', patch: { platformProfiles: false } });
    const generic = await data<State>(panel, { type: 'SESSION_START', tabId });
    expect(generic.phase, fixture).toBe('AWAITING_REVIEW');
    expect(generic.profile, fixture).toBeUndefined();
    expect(generic.plan.length, fixture).toBe(withProfile.plan.length);
    await data(panel, { type: 'SETTINGS_SET', patch: { platformProfiles: true } });
    expect(await submits(page)).toEqual([]);
  }

  // The personal-details profile fixes what generic rules misread, and never touches Aadhaar.
  await page.goto('/college-form-like.html');
  await page.bringToFront();
  const { tabId } = await data<{ tabId: number }>(panel, { type: 'GET_TARGET_TAB', selfTabId });
  const s = await data<State>(panel, { type: 'SESSION_START', tabId });
  const item = (label: string) =>
    s.plan.find((p) => p.fieldId === s.fields.find((f) => f.label === label)!.id)!;
  expect(item('Category')).toMatchObject({ kind: 'choice' });
  expect(item('Category').canonicalKey).toBeUndefined();
  expect(item('Aadhaar number')).toMatchObject({ kind: 'denied', status: 'skipped' });
  expect(item("Father's name")).toMatchObject({ value: 'Ramesh Verma' });
});

test('profile tips and length targets show in the panel', async ({ context, extensionId }) => {
  const { panel } = await openPanel(context, extensionId, 'upwork-profile-like.html');
  await panel.getByRole('button', { name: 'Get started' }).click();
  await panel.getByLabel('Passphrase', { exact: true }).fill(PASS);
  await panel.getByLabel('Type it again').fill(PASS);
  await panel.getByLabel('I understand my passphrase cannot be recovered.').check();
  await panel.getByRole('button', { name: 'Create vault' }).click();
  await panel.getByRole('button', { name: 'Skip for now' }).click();

  // Templates fill the goal; the chips show it after starting.
  await panel
    .getByLabel('Start from a template (optional)')
    .selectOption({ label: 'Upwork profile: <role>' });
  await panel.getByLabel('Your role', { exact: true }).fill('Data analyst');
  await expect(panel.getByLabel('What are we doing? (optional)')).toHaveValue(
    'Create my Upwork profile as a Data analyst',
  );
  await panel.getByRole('button', { name: 'Start on this page' }).click();
  await expect(panel.getByTestId('phase')).toHaveText('Ready for your review');
  await expect(panel.getByTestId('goal-role')).toHaveText('Role: Data analyst');
  await expect(panel.getByTestId('goal-platform')).toHaveText('Platform: Upwork');
  await expect(panel.getByTestId('goal-tone')).toHaveText('Tone: professional');
  // The freelance profile's audience fills the gap the template left.
  await expect(panel.getByTestId('goal-targetAudience')).toHaveText(
    'Audience: clients hiring freelancers',
  );

  await panel.getByTestId('profile').locator('summary').click();
  await expect(panel.getByTestId('profile')).toContainText('Tips for Freelance marketplace');
  await expect(panel.getByTestId('profile-tips')).toContainText('Filler never attaches files');
  await expect(
    panel.getByTestId('question').filter({ hasText: 'Profile overview' }).getByTestId('field-tip'),
  ).toContainText('Aim for 1,000–5,000 characters.');
});

test('history: the last session on this site is listed (masked) and its answers can be re-used', async ({
  context,
  extensionId,
}) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write'], {
    origin: 'http://127.0.0.1:5178',
  });
  const { page, panel } = await openPanel(context, extensionId, 'simple-contact.html');
  await panel.getByRole('button', { name: 'Get started' }).click();
  await panel.getByLabel('Passphrase', { exact: true }).fill(PASS);
  await panel.getByLabel('Type it again').fill(PASS);
  await panel.getByLabel('I understand my passphrase cannot be recovered.').check();
  await panel.getByRole('button', { name: 'Create vault' }).click();
  await panel.getByLabel('Full name', { exact: true }).fill('Priya Sharma');
  await panel.getByLabel('Mobile number', { exact: true }).fill('+91 98765 43210');
  await panel.getByLabel('Email', { exact: true }).fill('priya@example.com');
  await panel.getByLabel('City', { exact: true }).fill('Pune');
  await panel.getByRole('button', { name: 'Save and continue' }).click();

  // Session 1: the message is a one-off answer (not saved to the vault).
  await panel.getByRole('button', { name: 'Start on this page' }).click();
  await expect(panel.getByTestId('phase')).toHaveText('Ready for your review');
  const message = panel.getByTestId('question').filter({ hasText: 'Message' });
  await message.getByRole('textbox').fill('Please call after 6 pm.');
  await message.getByLabel('Save for reuse').uncheck();
  await message.getByRole('button', { name: 'Use this answer' }).click();
  await panel.getByRole('button', { name: /Approve all from vault/ }).click();
  await panel.getByRole('button', { name: /Fill \d+ approved/ }).click();
  await expect(panel.getByTestId('ready')).toBeVisible();

  // The summary can be copied (personal values masked).
  await panel.bringToFront();
  await panel.getByRole('button', { name: 'Copy summary' }).click();
  await page.bringToFront();
  const summary = await page.evaluate(() => navigator.clipboard.readText());
  await panel.bringToFront();
  expect(summary).toContain('Filled:');
  expect(summary).toContain('- Full name: Priya Sharma');
  expect(summary).toContain('- Message: Please call after 6 pm.');
  expect(summary).not.toContain('98765 43210');
  expect(summary).not.toContain('priya@example.com');
  await panel.getByRole('button', { name: 'End' }).click();

  // The start screen lists the session; the phone number is masked.
  const history = panel.getByTestId('history');
  await expect(history).toContainText('Past sessions on 127.0.0.1 (1)');
  await history.locator('summary').click();
  await expect(history.getByTestId('history-entry')).toContainText('Simple contact form');
  await expect(history).toContainText('Message: Please call after 6 pm.');
  await expect(history).not.toContainText('98765 43210');

  // Session 2 on a fresh page: the message is asked again, and can be re-used from last time.
  await page.reload();
  await panel.getByRole('button', { name: 'Start on this page' }).click();
  await expect(panel.getByTestId('phase')).toHaveText('Ready for your review');
  await expect(panel.getByTestId('question').filter({ hasText: 'Message' })).toBeVisible();
  await panel.getByTestId('reuse').getByRole('button', { name: 'Re-use them' }).click();
  const row = panel.getByTestId('review-row').filter({ hasText: 'Message' });
  await expect(row.getByTestId('review-value')).toHaveText('Please call after 6 pm.');
  await expect(row.getByTestId('review-status')).toHaveText('Needs approval');
  await expect(row).toContainText('From your last session here');
  expect(await submits(page)).toEqual([]);
});
