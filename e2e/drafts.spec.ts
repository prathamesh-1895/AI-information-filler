import AxeBuilder from '@axe-core/playwright';
import type { BrowserContext, Page } from '@playwright/test';
import { expect, test } from './fixtures';
import { submits } from './agent';

/**
 * PLAYBOOK Phase 9 through the real panel: fact selection chips, AI drafts
 * for the title and overview, Regenerate with a hint, edit, approve, fill;
 * goal chips; consistency across wizard pages; and the wizard still
 * completing with the AI down. The mock Supabase runs the real `ai-generate`
 * handler with the scripted writer from supabase/tests/fake-llm.ts.
 */

const MOCK = 'http://127.0.0.1:54321';
const PASS = 'correct horse battery staple';
const emailFor = (name: string) => `${name}-${Math.random().toString(36).slice(2, 8)}@example.com`;

async function mockAi(body: Record<string, unknown> = {}) {
  const res = await fetch(`${MOCK}/__mock/ai`, { method: 'POST', body: JSON.stringify(body) });
  return (await res.json()) as { providerCalls: number; prompts: string[] };
}

async function setup(context: BrowserContext, extensionId: string) {
  const page = await context.newPage();
  await page.goto('/upwork-profile-like.html');
  const panel = await context.newPage();
  await panel.setViewportSize({ width: 360, height: 1400 });
  await panel.goto(`chrome-extension://${extensionId}/sidepanel.html`);

  await panel.getByRole('button', { name: 'Get started' }).click();
  await panel.getByLabel('Passphrase', { exact: true }).fill(PASS);
  await panel.getByLabel('Type it again').fill(PASS);
  await panel.getByLabel('I understand my passphrase cannot be recovered.').check();
  await panel.getByRole('button', { name: 'Create vault' }).click();
  await expect(panel.getByRole('heading', { name: 'A few details to start' })).toBeVisible({
    timeout: 15_000,
  });
  await panel.getByLabel('Full name', { exact: true }).fill('Priya Sharma');
  await panel.getByLabel('City', { exact: true }).fill('Pune');
  await panel.getByLabel('Mobile number', { exact: true }).fill('+91 98765 43210');
  await panel.getByLabel('Skills', { exact: true }).fill('Excel, SQL, Power BI');
  await panel.getByRole('button', { name: 'Save and continue' }).click();
  await expect(panel.getByRole('tab', { name: 'Fill' })).toBeVisible();
  await panel.evaluate((m) => chrome.runtime.sendMessage(m), {
    type: 'FACT_BATCH',
    remove: [],
    set: [
      { key: 'projects[0].name', value: 'GST Automation' },
      { key: 'projects[1].name', value: 'Inventory Dashboard' },
      { key: 'professional.years_experience', value: '6' },
      { key: 'preferences.hourly_rate', value: '25' },
    ],
  });

  const email = emailFor('drafts');
  await panel.getByRole('tab', { name: 'Settings' }).click();
  await panel.getByLabel('Email', { exact: true }).fill(email);
  await panel.getByRole('button', { name: 'Email me a code' }).click();
  await expect(panel.getByText(`We emailed a 6-digit code to ${email}.`)).toBeVisible();
  const { code } = (await (
    await fetch(`${MOCK}/__mock/code?email=${encodeURIComponent(email)}`)
  ).json()) as { code: string };
  await panel.getByLabel('Code from the email').fill(code);
  await panel.getByRole('button', { name: 'Sign in' }).click();
  await expect(panel.getByTestId('signed-in-as')).toBeVisible();
  await panel.getByRole('tab', { name: 'Fill' }).click();
  return { page, panel };
}

const row = (panel: Page, label: string) =>
  panel
    .getByTestId('review-row')
    .filter({ has: panel.getByTestId('review-label').getByText(label, { exact: true }) });
const question = (panel: Page, text: string) =>
  panel.getByTestId('question').filter({ hasText: text });

async function start(panel: Page, goal: string) {
  await panel.getByLabel('What are we doing? (optional)').fill(goal);
  await panel.getByRole('button', { name: 'Start on this page' }).click();
  await expect(panel.getByTestId('phase')).toHaveText('Ready for your review');
}

test.afterEach(async () => {
  await mockAi({ mode: 'up', limitCalls: 200, clearCache: true });
});

test('drafts: title and overview drafted from chosen facts, regenerated with a hint, edited, approved and filled; consistent on a later page; goal edits change the next draft', async ({
  context,
  extensionId,
}) => {
  await mockAi({ mode: 'up', limitCalls: 200, clearCache: true });
  const { page, panel } = await setup(context, extensionId);
  await start(panel, 'Create my Upwork profile as a business consultant for small businesses');

  // Goal chips, read from the text.
  await expect(panel.getByTestId('goal-role')).toHaveText('Role: business consultant');
  await expect(panel.getByTestId('goal-targetAudience')).toHaveText('Audience: small businesses');

  // Title: draft from the defaults.
  const title = question(panel, 'Your professional role');
  await title.getByRole('button', { name: 'Draft with AI' }).click();
  await expect(row(panel, 'Your professional role').getByTestId('review-value')).toHaveText(
    'Business Consultant | Excel & SQL',
  );
  await expect(row(panel, 'Your professional role')).toContainText('AI draft');

  // Overview: the chips say what would be sent; untick Projects first.
  const overview = question(panel, 'Profile overview');
  const controls = overview.getByTestId('draft-controls');
  await expect(controls).toContainText('Using:');
  await expect(controls.getByRole('button', { name: 'Projects (2)' })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await expect(controls.getByRole('group')).toHaveText('Using:SkillsProjects (2)Profession');
  await controls.getByRole('button', { name: 'Projects (2)' }).click();
  await controls.getByRole('button', { name: 'Draft with AI' }).click();
  const ov = row(panel, 'Profile overview');
  await expect(ov.getByTestId('review-value')).toContainText(
    'I work as a business consultant for small businesses.',
  );
  await expect(ov.getByTestId('review-value')).not.toContainText('GST Automation');
  await expect(ov.getByTestId('draft-count')).toContainText('/ 5,000 characters');
  await expect(ov.getByTestId('draft-why')).toContainText('Skills');
  await expect(ov.getByTestId('review-status')).toHaveText('Needs approval');

  // Regenerate with a hint changes the text.
  const before = await ov.getByTestId('review-value').innerText();
  await ov.getByLabel('Change it how?').fill('mention my GST Automation project');
  await ov.getByRole('button', { name: 'Regenerate' }).click();
  await expect(ov.getByTestId('review-value')).toContainText(
    'I can also speak to my GST Automation project.',
  );
  expect(await ov.getByTestId('review-value').innerText()).not.toBe(before);

  // The draft card is accessible (axe: no serious or critical issues).
  await ov.getByText(/Other versions/).click();
  const axe = await new AxeBuilder({ page: panel }).analyze();
  expect(axe.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical')).toEqual(
    [],
  );

  // Approve-all-from-vault never approves AI text.
  await panel.getByRole('button', { name: /Approve all from vault/ }).click();
  await expect(ov.getByTestId('review-status')).toHaveText('Needs approval');

  // Edit the overview, approve the title, fill.
  await ov.getByRole('button', { name: 'Edit Profile overview' }).click();
  const edited = `${await ov.getByLabel('Edit value').inputValue()} I reply within a day.`;
  await ov.getByLabel('Edit value').fill(edited);
  await ov.getByRole('button', { name: 'Save' }).click();
  await expect(ov.getByTestId('review-status')).toHaveText('Edited');
  await row(panel, 'Your professional role').getByRole('button', { name: 'Approve' }).click();
  await panel.getByRole('button', { name: /Fill \d+ approved/ }).click();
  await expect(page.locator('#title')).toHaveValue('Business Consultant | Excel & SQL');
  await expect(page.locator('#overview')).toHaveValue(edited);

  // Later pages: step 3's pitch stays consistent with the title filled on step 1.
  await page.getByRole('button', { name: 'Next' }).click();
  await expect(row(panel, 'City')).toBeVisible();
  await page.getByRole('button', { name: 'Next' }).click();
  const pitch = question(panel, 'Why should clients hire you?');
  await pitch.getByRole('button', { name: 'Draft with AI' }).click();
  const pr = row(panel, 'Why should clients hire you?');
  await expect(pr.getByTestId('review-value')).toContainText(
    'As Business Consultant | Excel & SQL,',
  );
  expect((await pr.getByTestId('review-value').innerText()).length).toBeLessThanOrEqual(600);

  // Editing the goal changes the next draft.
  await panel.getByRole('button', { name: 'Edit goal' }).click();
  await panel.getByLabel('Role', { exact: true }).fill('data analyst');
  await panel.getByRole('button', { name: 'Save goal' }).click();
  await expect(panel.getByTestId('goal-role')).toHaveText('Role: data analyst');
  await pr.getByRole('button', { name: 'Regenerate' }).click();
  await expect(pr.getByTestId('review-value')).toContainText('I work as a data analyst');
  await pr.getByRole('button', { name: 'Approve' }).click();
  await panel.getByRole('button', { name: /Fill \d+ approved/ }).click();
  await expect(page.locator('#pitch')).toHaveValue(/data analyst/);
  expect(await submits(page)).toEqual([]);

  // The "model" got only the ticked, public details: never the phone or city.
  const { prompts } = await mockAi();
  const drafts = prompts.filter((p) => p.includes('<<<DRAFT_DATA')).join('\n');
  expect(drafts).toContain('Excel');
  for (const leak of ['98765', 'Pune', 'Priya']) expect(drafts).not.toContain(leak);
  expect(
    await panel.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1),
  ).toBe(true);
});

test('AI down: the Upwork-like wizard still completes through questions', async ({
  context,
  extensionId,
}) => {
  await mockAi({ mode: 'down', clearCache: true });
  const { page, panel } = await setup(context, extensionId);
  await start(panel, 'Create my Upwork profile as a business consultant');
  await expect(panel.getByTestId('ai-chip').first()).toContainText('Offline mode');

  const overview = question(panel, 'Profile overview');
  await expect(overview).toContainText('Offline mode: Filler needs you to write this one.');
  await expect(overview.getByRole('button', { name: 'Draft with AI' })).toHaveCount(0);
  await overview.getByRole('textbox').fill('I help small businesses tidy up their books.');
  await expect(overview.getByLabel('Save for reuse')).toBeChecked();
  await overview.getByRole('button', { name: 'Use this answer' }).click();
  const title = question(panel, 'Your professional role');
  await title.getByRole('textbox').fill('Business Consultant');
  await title.getByRole('button', { name: 'Use this answer' }).click();
  await panel.getByRole('button', { name: /Approve all from vault/ }).click();
  await panel.getByRole('button', { name: /Fill \d+ approved/ }).click();
  await expect(page.locator('#overview')).toHaveValue(
    'I help small businesses tidy up their books.',
  );

  await page.getByRole('button', { name: 'Next' }).click();
  await expect(row(panel, 'City')).toBeVisible();
  await question(panel, 'Street address').getByRole('button', { name: 'Skip' }).click();
  await question(panel, 'ZIP/Postal code').getByRole('button', { name: 'Skip' }).click();
  await panel.getByRole('button', { name: /Approve all from vault/ }).click();
  await panel.getByRole('button', { name: /Fill \d+ approved/ }).click();
  await expect(page.locator('#city')).toHaveValue('Pune');

  await page.getByRole('button', { name: 'Next' }).click();
  const pitch = question(panel, 'Why should clients hire you?');
  await pitch.getByRole('textbox').fill('I explain numbers in plain words.');
  await pitch.getByRole('button', { name: 'Use this answer' }).click();
  await panel.getByRole('button', { name: /Fill \d+ approved/ }).click();
  await expect(panel.getByTestId('ready')).toBeVisible();
  await expect(page.locator('#pitch')).toHaveValue('I explain numbers in plain words.');
  expect(await submits(page)).toEqual([]);
});
