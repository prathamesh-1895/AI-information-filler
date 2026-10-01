import type { BrowserContext, Page } from '@playwright/test';
import { expect, test } from './fixtures';
import { submits } from './agent';

/**
 * PLAYBOOK Tasks 8.4–8.5 end to end, through the real side panel. The mock
 * Supabase (scripts/mock-supabase.mjs) runs the real `health` and
 * `ai-classify` handlers, safety envelope and Gemini adapter, with the
 * scripted model from supabase/tests/fake-llm.ts in place of the provider.
 */

const MOCK = 'http://127.0.0.1:54321';
const PASS = 'correct horse battery staple';
const emailFor = (name: string) => `${name}-${Math.random().toString(36).slice(2, 8)}@example.com`;

async function mockAi(body: Record<string, unknown> = {}) {
  const res = await fetch(`${MOCK}/__mock/ai`, { method: 'POST', body: JSON.stringify(body) });
  return (await res.json()) as { mode: string; providerCalls: number; prompts: string[] };
}

async function openPanel(context: BrowserContext, extensionId: string, fixture: string) {
  const page = await context.newPage();
  await page.goto(`/${fixture}`);
  const panel = await context.newPage();
  await panel.setViewportSize({ width: 360, height: 1100 });
  await panel.goto(`chrome-extension://${extensionId}/sidepanel.html`);
  return { page, panel };
}

async function onboard(panel: Page, profile: Record<string, string>) {
  await panel.getByRole('button', { name: 'Get started' }).click();
  await panel.getByLabel('Passphrase', { exact: true }).fill(PASS);
  await panel.getByLabel('Type it again').fill(PASS);
  await panel.getByLabel('I understand my passphrase cannot be recovered.').check();
  await panel.getByRole('button', { name: 'Create vault' }).click();
  await expect(panel.getByRole('heading', { name: 'A few details to start' })).toBeVisible({
    timeout: 15_000,
  });
  for (const [label, value] of Object.entries(profile))
    await panel.getByLabel(label, { exact: true }).fill(value);
  await panel.getByRole('button', { name: 'Save and continue' }).click();
  await expect(panel.getByRole('tab', { name: 'Fill' })).toBeVisible();
}

async function signIn(panel: Page, email: string) {
  await panel.getByRole('tab', { name: 'Settings' }).click();
  await panel.getByLabel('Email', { exact: true }).fill(email);
  await panel.getByRole('button', { name: 'Email me a code' }).click();
  await expect(panel.getByText(`We emailed a 6-digit code to ${email}.`)).toBeVisible();
  const res = await fetch(`${MOCK}/__mock/code?email=${encodeURIComponent(email)}`);
  const { code } = (await res.json()) as { code: string };
  await panel.getByLabel('Code from the email').fill(code);
  await panel.getByRole('button', { name: 'Sign in' }).click();
  await expect(panel.getByTestId('signed-in-as')).toHaveText(`Signed in as ${email}`);
}

const chip = (panel: Page) => panel.getByTestId('ai-chip').first();
const row = (panel: Page, label: string) =>
  panel
    .getByTestId('review-row')
    .filter({ has: panel.getByTestId('review-label').getByText(label, { exact: true }) });
const question = (panel: Page, text: string) =>
  panel.getByTestId('question').filter({ hasText: text });

test.afterEach(async () => {
  await mockAi({ mode: 'up', limitCalls: 200, clearCache: true });
});

test('AI on: fields the rules could not place are understood, filled from the vault, and nothing personal is sent', async ({
  context,
  extensionId,
}) => {
  await mockAi({ mode: 'up', limitCalls: 200, clearCache: true });
  const before = (await mockAi()).providerCalls;
  const { page, panel } = await openPanel(context, extensionId, 'ai-understanding.html');
  await onboard(panel, { 'Full name': 'Priya Sharma', City: 'Pune', Skills: 'React, Node.js' });

  // Signed out: offline, and the chip says why.
  await expect(chip(panel)).toContainText('Offline mode');
  await expect(chip(panel)).toContainText('not signed in');

  await signIn(panel, emailFor('ai-on'));
  const card = panel.getByTestId('ai-card');
  await expect(card.getByTestId('ai-chip')).toContainText('AI on');

  await panel.getByRole('tab', { name: 'Fill' }).click();
  await panel.getByLabel('What are we doing? (optional)').fill('Sign up for Build Weekend');
  await panel.getByRole('button', { name: 'Start on this page' }).click();
  await expect(panel.getByTestId('phase')).toHaveText('Ready for your review');
  await expect(chip(panel)).toContainText('AI on');

  // Previously unmapped questions now come from the vault.
  await expect(row(panel, 'Where are you based these days?')).toContainText('Pune');
  await expect(row(panel, "What's your go-to stack?")).toContainText('React');
  // Facts the vault lacks are asked the AI's way, once.
  await expect(question(panel, 'Team name')).toContainText('What is your team called?');
  await expect(question(panel, 'Favourite tools')).toContainText(
    'Which tools do you like using most?',
  );
  // The password field is never offered.
  await expect(question(panel, 'Choose a password')).toHaveCount(0);

  const team = question(panel, 'Team name');
  await team.getByRole('textbox').fill('Night Owls');
  await team.getByRole('button', { name: 'Use this answer' }).click();
  await panel.getByRole('button', { name: /Approve all from vault/ }).click();
  await panel.getByRole('button', { name: /Fill \d+ approved/ }).click();
  await expect(page.locator('[data-fx="based"]')).toHaveValue('Pune');
  await expect(page.locator('[data-fx="stack"]')).toHaveValue('React, Node.js');
  await expect(page.locator('[data-fx="team"]')).toHaveValue('Night Owls');
  await expect(page.locator('[data-fx="password"]')).toHaveValue('');
  expect(await submits(page)).toEqual([]);

  // What the "model" saw: field text only. No vault values, no goal email, no password field.
  const { prompts, providerCalls } = await mockAi();
  expect(providerCalls).toBe(before + 1);
  const sent = prompts.slice(before).join('\n');
  expect(sent).toContain('Spirit animal');
  for (const leak of ['Priya', 'Pune', 'React', 'Node.js', 'Night Owls', 'Choose a password'])
    expect(sent).not.toContain(leak);
  // The injected help text is inside the data block, and nothing came back from it.
  expect(sent.indexOf('ignore previous instructions')).toBeGreaterThan(
    sent.indexOf('<<<PAGE_DATA'),
  );

  // Starting again on the same page costs no AI call: field memory remembers the AI's reading.
  await panel.getByRole('button', { name: 'End' }).click();
  await panel.getByRole('button', { name: 'Start on this page' }).click();
  await expect(panel.getByTestId('phase')).toHaveText('Ready for your review');
  await expect(row(panel, 'Where are you based these days?')).toContainText('Pune');
  expect((await mockAi()).providerCalls).toBe(before + 1);

  // Settings: connection check and today's usage.
  await panel.getByRole('tab', { name: 'Settings' }).click();
  await card.getByRole('button', { name: 'Test AI connection' }).click();
  await expect(card.getByTestId('ai-test-result')).toContainText('AI is working (gemini');
  await expect(card.getByTestId('ai-usage')).toContainText('Understanding fields');
  await expect(
    card.getByTestId('ai-usage').getByRole('row', { name: /Understanding fields/ }),
  ).toContainText('2 / 200');
  expect(
    await panel.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1),
  ).toBe(true);
});

test('provider down: offline mode with a reason, and the page still completes through questions', async ({
  context,
  extensionId,
}) => {
  await mockAi({ mode: 'down', clearCache: true });
  const { page, panel } = await openPanel(context, extensionId, 'ai-understanding.html');
  await onboard(panel, { 'Full name': 'Priya Sharma', City: 'Pune' });
  await signIn(panel, emailFor('ai-down'));
  await panel.getByRole('tab', { name: 'Fill' }).click();
  await panel.getByRole('button', { name: 'Start on this page' }).click();
  await expect(panel.getByTestId('phase')).toHaveText('Ready for your review');
  await expect(chip(panel)).toContainText('Offline mode');
  await expect(chip(panel)).toContainText('AI provider unavailable');

  // Without AI the field is a plain question; answering it still fills the page.
  const based = question(panel, 'Where are you based these days?');
  await based.getByRole('textbox').fill('Pune');
  await based.getByRole('button', { name: 'Use this answer' }).click();
  await panel.getByRole('button', { name: /Fill \d+ approved/ }).click();
  await expect(page.locator('[data-fx="based"]')).toHaveValue('Pune');
  expect(await submits(page)).toEqual([]);

  await panel.getByRole('tab', { name: 'Settings' }).click();
  const card = panel.getByTestId('ai-card');
  await card.getByRole('button', { name: 'Test AI connection' }).click();
  await expect(card.getByTestId('ai-test-result')).toContainText('not answering right now');
});

test('daily limit: a friendly message and offline mode, not an error', async ({
  context,
  extensionId,
}) => {
  await mockAi({ mode: 'up', limitCalls: 1, clearCache: true });
  const { page, panel } = await openPanel(context, extensionId, 'ai-understanding.html');
  await onboard(panel, { 'Full name': 'Priya Sharma', City: 'Pune' });
  await signIn(panel, emailFor('ai-limit'));
  await panel.getByRole('tab', { name: 'Fill' }).click();
  await panel.getByRole('button', { name: 'Start on this page' }).click();
  await expect(panel.getByTestId('phase')).toHaveText('Ready for your review');
  await expect(row(panel, 'Where are you based these days?')).toContainText('Pune');
  await expect(chip(panel)).toContainText('AI on'); // the one allowed call

  // A new page on the same site needs another call: over the limit.
  await page.goto('/simple-contact.html');
  await expect(panel.getByText('Simple contact form')).toBeVisible();
  await expect(panel.getByTestId('phase')).toHaveText('Ready for your review');
  await expect(chip(panel)).toContainText('Offline mode');
  await expect(chip(panel)).toContainText('daily AI limit reached');
  await expect(question(panel, 'Message')).toBeVisible();
  await expect(panel.getByRole('alert')).toHaveCount(0);

  await panel.getByRole('tab', { name: 'Settings' }).click();
  const card = panel.getByTestId('ai-card');
  await card.getByRole('button', { name: 'Test AI connection' }).click();
  await expect(card.getByTestId('ai-test-result')).toContainText("You've reached today's AI limit");
});
