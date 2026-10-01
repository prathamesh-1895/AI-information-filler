import { fileURLToPath } from 'node:url';
import type { BrowserContext, Page } from '@playwright/test';
import { expect, test } from './fixtures';

/**
 * PLAYBOOK Task 11.1 end to end: a résumé file read on the device, every
 * detail reviewed, saved, and the next form asks almost nothing.
 */

const MOCK = 'http://127.0.0.1:54321';
const PASS = 'correct horse battery staple';
const resume = (name: string) =>
  fileURLToPath(new URL(`../test-fixtures/resumes/${name}`, import.meta.url));

async function setup(context: BrowserContext, extensionId: string, fixture: string) {
  const page = await context.newPage();
  await page.goto(`/${fixture}`);
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
  await panel.getByRole('button', { name: 'Skip for now' }).click();
  await expect(panel.getByRole('tab', { name: 'Fill' })).toBeVisible();
  return { page, panel };
}

const importRow = (panel: Page, label: string) =>
  panel
    .getByTestId('import-row')
    .filter({ has: panel.getByTestId('import-label').getByText(label, { exact: true }) });

test('PDF résumé → review → vault; the Upwork-like page then asks at most 2 questions', async ({
  context,
  extensionId,
}) => {
  const { panel } = await setup(context, extensionId, 'upwork-profile-like.html');
  await panel.getByRole('tab', { name: 'My details' }).click();
  await panel.getByLabel('Choose a résumé file').setInputFiles(resume('asha-verma.pdf'));
  await expect(panel.getByText('Read asha-verma.pdf.')).toBeVisible();
  await panel.getByRole('button', { name: 'Find my details' }).click();

  const review = panel.getByTestId('import-review');
  await expect(review).toContainText('Read on this device only');
  await expect(importRow(panel, 'Full name').getByLabel('Value for Full name')).toHaveValue(
    'Asha Verma',
  );
  await expect(importRow(panel, 'Skills').getByLabel('Value for Skills')).toHaveValue(
    'Excel, SQL, Power BI, Process mapping, Financial modelling',
  );
  await expect(importRow(panel, 'Company (Sahyadri Retail Pvt Ltd)')).toContainText('New');
  // The user can edit or untick before saving.
  await importRow(panel, 'Date of birth').getByRole('checkbox').uncheck();
  await importRow(panel, 'Headline')
    .getByLabel('Value for Headline')
    .fill('Business Consultant for Growing SMBs');
  await review.getByRole('button', { name: /Save \d+ details/ }).click();
  await expect(panel.getByTestId('import-card')).toContainText(
    /Saved \d+ details from asha-verma\.pdf\./,
  );

  // The vault has the details (and not the unticked one).
  await expect(panel.getByText('Business Consultant for Growing SMBs')).toBeVisible();
  const facts = (await panel.evaluate(() => chrome.runtime.sendMessage({ type: 'FACT_LIST' }))) as {
    data: Array<{ key: string; source: string }>;
  };
  const keys = facts.data.map((f) => f.key);
  expect(keys).toEqual(
    expect.arrayContaining([
      'experience[1].company',
      'projects[0].name',
      'languages[0].proficiency',
    ]),
  );
  expect(keys).not.toContain('person.dob');
  expect(new Set(facts.data.map((f) => f.source))).toEqual(new Set(['resume_import']));

  await panel.getByRole('tab', { name: 'Fill' }).click();
  await panel.getByRole('button', { name: 'Start on this page' }).click();
  await expect(panel.getByTestId('phase')).toHaveText('Ready for your review');
  const asked = await panel.getByTestId('question').count();
  expect(asked).toBeLessThanOrEqual(2);
  await expect(panel.getByTestId('question').filter({ hasText: 'Hourly rate' })).toBeVisible();
});

test('Word résumé with AI on: contacts stay on the device; saved details are not overwritten', async ({
  context,
  extensionId,
}) => {
  const { panel } = await setup(context, extensionId, 'simple-contact.html');
  const email = `import-${Math.random().toString(36).slice(2, 8)}@example.com`;
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

  await panel.evaluate(() =>
    chrome.runtime.sendMessage({ type: 'FACT_SET', key: 'address.city', value: 'Mumbai' }),
  );
  const before = ((await (await fetch(`${MOCK}/__mock/ai`)).json()) as { prompts: string[] })
    .prompts.length;
  await panel.getByRole('tab', { name: 'My details' }).click();
  await panel.getByLabel('Choose a résumé file').setInputFiles(resume('asha-verma.docx'));
  await expect(panel.getByText('Read asha-verma.docx.')).toBeVisible();
  await panel.getByRole('button', { name: 'Find my details' }).click();
  await expect(panel.getByTestId('import-review')).toContainText(
    'Read with Filler’s AI. Contact details were found on this device and not sent.',
  );
  const city = importRow(panel, 'City');
  await expect(city).toContainText('Different from saved');
  await expect(city).toContainText('Saved now: Mumbai');
  await expect(city.getByRole('checkbox')).not.toBeChecked();

  const prompts = (
    (await (await fetch(`${MOCK}/__mock/ai`)).json()) as { prompts: string[] }
  ).prompts.slice(before);
  expect(prompts.join('\n')).toContain('Sahyadri Retail');
  for (const leak of ['asha.verma@example.com', '98220', 'linkedin.com/in', '14 May 1996', 'Pune'])
    expect(prompts.join('\n')).not.toContain(leak);

  await panel.getByRole('button', { name: /Save \d+ details/ }).click();
  await expect(panel.getByTestId('import-card')).toContainText('Saved');
  const facts = (await panel.evaluate(() => chrome.runtime.sendMessage({ type: 'FACT_LIST' }))) as {
    data: Array<{ key: string; value: unknown }>;
  };
  expect(facts.data.find((f) => f.key === 'address.city')?.value).toBe('Mumbai');
});
