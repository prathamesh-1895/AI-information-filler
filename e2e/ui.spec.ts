import AxeBuilder from '@axe-core/playwright';
import type { BrowserContext, Page } from '@playwright/test';
import { expect, test } from './fixtures';
import { submits } from './agent';

/**
 * PLAYBOOK Phase 6 through the real side panel UI: onboarding and unlock
 * (6.1), the vault manager (6.2), the fill session (6.3), settings (6.4) and
 * accessibility (6.5). The panel runs as a tab at side-panel width.
 */

const PASS = 'correct horse battery staple';

async function openPanel(context: BrowserContext, extensionId: string, fixture?: string) {
  const page = await context.newPage();
  if (fixture) await page.goto(`/${fixture}`);
  const panel = await context.newPage();
  await panel.setViewportSize({ width: 360, height: 900 });
  await panel.goto(`chrome-extension://${extensionId}/sidepanel.html`);
  return { page, panel };
}

async function onboard(panel: Page, profile: Record<string, string> = {}) {
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
  await panel
    .getByRole('button', {
      name: Object.keys(profile).length ? 'Save and continue' : 'Skip for now',
    })
    .click();
  await expect(panel.getByRole('tab', { name: 'Fill' })).toBeVisible();
}

const rows = (panel: Page) => panel.getByTestId('review-row');
const row = (panel: Page, label: string) =>
  rows(panel).filter({ has: panel.getByTestId('review-label').getByText(label, { exact: true }) });
const question = (panel: Page, text: string) =>
  panel.getByTestId('question').filter({ hasText: text });

async function expectNoHorizontalScroll(panel: Page) {
  expect(
    await panel.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1),
  ).toBe(true);
}

async function expectAccessible(panel: Page, where: string) {
  // Colour transitions (e.g. right after a theme switch) would be measured mid-fade.
  await panel.waitForFunction(() =>
    document.getAnimations().every((a) => a.playState !== 'running'),
  );
  const results = await new AxeBuilder({ page: panel }).analyze();
  const serious = results.violations.filter(
    (v) => v.impact === 'serious' || v.impact === 'critical',
  );
  expect(
    serious.map(
      (v) =>
        `${where}: ${v.id}: ${v.nodes.map((n) => `${n.target.join(' ')} → ${n.failureSummary?.replace(/\s+/g, ' ')}`).join('; ')}`,
    ),
  ).toEqual([]);
}

// --------------------------------------------------------------- 6.1

test('onboarding from a fresh profile, then lock and unlock (with a wrong passphrase first)', async ({
  context,
  extensionId,
}) => {
  const { panel } = await openPanel(context, extensionId, 'simple-contact.html');
  await expect(panel.getByRole('heading', { name: 'Welcome to Filler' })).toBeVisible();
  await expectAccessible(panel, 'welcome');
  await panel.getByRole('button', { name: 'Get started' }).click();

  // Strength meter, mismatch error, and the create button stays off until everything is right.
  await panel.getByLabel('Passphrase', { exact: true }).fill('short');
  await expect(panel.getByTestId('strength')).toHaveText('Strength: Too short');
  await panel.getByLabel('Passphrase', { exact: true }).fill(PASS);
  await expect(panel.getByTestId('strength')).toHaveText(/Strength: (Good|Strong|Very strong)/);
  await panel.getByLabel('Type it again').fill('something else');
  await expect(panel.getByText('The two passphrases do not match.')).toBeVisible();
  await expect(panel.getByRole('button', { name: 'Create vault' })).toBeDisabled();
  await expect(panel.getByText('It cannot be recovered.')).toBeVisible();
  await expectAccessible(panel, 'create passphrase');
  await panel.getByLabel('Type it again').fill(PASS);
  await panel.getByLabel('I understand my passphrase cannot be recovered.').check();
  await panel.getByRole('button', { name: 'Create vault' }).click();

  await panel.getByLabel('Full name', { exact: true }).fill('Priya Sharma');
  await panel.getByLabel('Skills', { exact: true }).fill('Excel, SQL');
  await panel.getByRole('button', { name: 'Save and continue' }).click();
  await panel.getByRole('tab', { name: 'My details' }).click();
  await expect(panel.getByTestId('fact-value').filter({ hasText: 'Priya Sharma' })).toBeVisible();
  await expect(panel.getByTestId('fact-value').filter({ hasText: 'Excel, SQL' })).toBeVisible();

  await panel.getByRole('button', { name: 'Lock vault' }).click();
  await expect(panel.getByRole('heading', { name: 'Unlock your vault' })).toBeVisible();
  await expectAccessible(panel, 'unlock');
  await panel.getByLabel('Passphrase').fill('not my passphrase');
  await panel.getByRole('button', { name: 'Unlock' }).click();
  await expect(panel.getByRole('alert')).toHaveText('That passphrase is not correct.');
  await panel.getByLabel('Passphrase').fill(PASS);
  await panel.getByRole('button', { name: 'Unlock' }).click();
  await expect(panel.getByRole('tab', { name: 'My details' })).toBeVisible();
  await expectNoHorizontalScroll(panel);
});

// --------------------------------------------------------------- 6.2

test('vault manager: add, edit, mask, delete, repeat sections, deny list, export, wipe', async ({
  context,
  extensionId,
}) => {
  const { panel } = await openPanel(context, extensionId, 'simple-contact.html');
  await onboard(panel, { 'Mobile number': '+91 98765 43210' });
  await panel.getByRole('tab', { name: 'My details' }).click();

  // Personal values are masked until revealed.
  const phone = panel.getByTestId('fact-row').filter({ hasText: 'Mobile number' });
  await expect(phone.getByTestId('fact-value')).toHaveText('•••••••••••3210');
  await phone.getByRole('button', { name: 'Show Mobile number' }).click();
  await expect(phone.getByTestId('fact-value')).toHaveText('+91 98765 43210');

  // Add, edit, delete a detail.
  await panel.getByRole('button', { name: 'Add a detail' }).click();
  await panel.getByLabel('What is it?').selectOption({ label: 'LinkedIn' });
  await panel.getByLabel('Value').fill('linkedin.com/in/priya');
  await panel.getByRole('button', { name: 'Save', exact: true }).click();
  const linkedin = panel.getByTestId('fact-row').filter({ hasText: 'LinkedIn' });
  await expect(linkedin.getByTestId('fact-value')).toHaveText('linkedin.com/in/priya');
  await linkedin.getByRole('button', { name: 'Edit LinkedIn' }).click();
  await linkedin.getByLabel('New value for LinkedIn').fill('linkedin.com/in/priya-sharma');
  await linkedin.getByRole('button', { name: 'Save' }).click();
  await expect(linkedin.getByTestId('fact-value')).toHaveText('linkedin.com/in/priya-sharma');

  // A custom detail, and a sensitive value the vault refuses.
  await panel.getByRole('button', { name: 'Add a detail' }).click();
  await panel.getByLabel('What is it?').selectOption({ label: 'Something else…' });
  await panel.getByLabel('Name of the detail').fill('Team name');
  await panel.getByLabel('Value').fill('Rocket');
  await panel.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(panel.getByTestId('fact-row').filter({ hasText: 'Team name' })).toBeVisible();
  await panel.getByRole('button', { name: 'Add a detail' }).click();
  await panel.getByLabel('What is it?').selectOption({ label: 'Something else…' });
  await panel.getByLabel('Name of the detail').fill('Reference');
  await panel.getByLabel('Value').fill('4111 1111 1111 1111');
  await panel.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(panel.getByRole('alert')).toContainText('card number');
  await panel.getByRole('button', { name: 'Cancel' }).click();

  await linkedin.getByRole('button', { name: 'Delete LinkedIn' }).click();
  await linkedin.getByRole('button', { name: 'Confirm delete' }).click();
  await expect(linkedin).toHaveCount(0);

  // Repeating sections: add two, reorder, delete — indexes stay gap-free.
  for (const college of ['PICT', 'Fergusson College']) {
    await panel.getByRole('button', { name: 'Add education' }).click();
    await panel.getByLabel('Institution').fill(college);
    await panel.getByLabel('Degree').fill(college === 'PICT' ? 'B.E.' : 'HSC');
    await panel.getByRole('button', { name: 'Save', exact: true }).click();
  }
  const items = panel.getByTestId('item-education');
  await expect(items).toHaveCount(2);
  await expect(items.nth(1)).toContainText('Fergusson College');
  await panel.getByRole('button', { name: 'Move Education 2 up' }).click();
  await expect(items.nth(0)).toContainText('Fergusson College');
  await panel.getByRole('button', { name: 'Delete Education 1' }).click();
  await expect(items).toHaveCount(1);
  await expect(items.nth(0)).toContainText('Education 1');
  await expect(items.nth(0)).toContainText('PICT');

  // Search.
  await panel.getByLabel('Search your details').fill('rocket');
  await expect(panel.getByTestId('fact-row')).toHaveCount(1);
  await panel.getByLabel('Search your details').fill('');

  // Deny list: built-ins are locked; user phrases can be added and removed.
  await expect(panel.getByTestId('deny-builtin')).toContainText('Aadhaar numbers');
  await panel.getByLabel('Also never fill fields about…').fill('blood group');
  await panel.getByRole('button', { name: 'Add', exact: true }).click();
  await expect(panel.getByTestId('deny-user')).toContainText('blood group');
  await panel.getByRole('button', { name: 'Remove blood group' }).click();
  await expect(panel.getByTestId('deny-user')).toHaveCount(0);

  await expectAccessible(panel, 'vault manager');
  await expectNoHorizontalScroll(panel);

  // Encrypted export.
  const download = panel.waitForEvent('download');
  await panel.getByRole('button', { name: 'Export backup' }).click();
  const file = await download;
  expect(file.suggestedFilename()).toMatch(/^filler-backup-\d{4}-\d{2}-\d{2}\.filler$/);
  const content = await (await file.createReadStream()).toArray();
  const text = Buffer.concat(content as Buffer[]).toString('utf8');
  expect(text).toContain('"format":"filler-backup"');
  expect(text).not.toContain('Rocket');

  // Wipe needs the typed confirmation.
  await panel.getByText('Delete everything').click();
  await expect(panel.getByRole('button', { name: 'Delete my vault' })).toBeDisabled();
  await panel.getByLabel('Type DELETE').fill('DELETE');
  await panel.getByRole('button', { name: 'Delete my vault' }).click();
  await expect(panel.getByRole('heading', { name: 'Welcome to Filler' })).toBeVisible();
});

// --------------------------------------------------------------- 6.3

test('Google-Form-like form: questions, approvals and fill, all through the panel', async ({
  context,
  extensionId,
}) => {
  const { page, panel } = await openPanel(context, extensionId, 'google-form-like.html');
  await onboard(panel, {
    'Full name': 'Priya Sharma',
    Email: 'priya@example.com',
    'Mobile number': '+91 98765 43210',
    City: 'Mumbai',
    Skills: 'Excel, Python',
  });
  await expect(panel.getByTestId('target')).toContainText('Campus Ambassador Application');
  await panel.getByRole('button', { name: 'Start on this page' }).click();
  await expect(panel.getByTestId('phase')).toHaveText('Ready for your review');

  // Choice questions render as buttons; text questions as inputs.
  const year = question(panel, 'Which year are you in?');
  await year.getByRole('button', { name: 'Final year' }).click();
  await year.getByRole('button', { name: 'Use this answer' }).click();
  for (const [label, choice] of [
    ['Communication', 'Good'],
    ['Teamwork', 'Excellent'],
  ] as const) {
    const q = question(panel, label);
    await q.getByRole('button', { name: choice }).click();
    await q.getByRole('button', { name: 'Use this answer' }).click();
  }
  const dob = question(panel, 'Date of birth');
  await dob.locator('input[type="date"]').fill('2003-05-14');
  await dob.getByRole('button', { name: 'Use this answer' }).click();
  const why = question(panel, 'Why do you want to be a campus ambassador?');
  await why.getByRole('textbox').fill('I enjoy organising events.');
  await why.getByLabel('Save for reuse').uncheck(); // one-off answer
  await why.getByRole('button', { name: 'Use this answer' }).click();
  await expect(panel.getByTestId('question')).toHaveCount(0);

  await expect(row(panel, 'Full name').getByTestId('review-status')).toHaveText('Needs approval');
  await panel.getByRole('button', { name: /Approve all from vault/ }).click();
  await expect(row(panel, 'Full name').getByTestId('review-status')).toHaveText('Approved');
  await panel.getByRole('button', { name: /Fill \d+ approved/ }).click();
  await expect(panel.getByTestId('ready')).toBeVisible();

  await expect(page.locator('[data-fx="name"]')).toHaveValue('Priya Sharma');
  await expect(page.locator('[data-fx="dob"]')).toHaveValue('2003-05-14');
  await expect(page.locator('[data-fx="city"] [aria-selected="true"]')).toHaveText('Mumbai');
  expect(
    await page
      .locator('[data-fx="skills"] [aria-checked="true"]')
      .evaluateAll((els) => els.map((e) => e.getAttribute('aria-label'))),
  ).toEqual(['Excel', 'Python']);
  expect(
    await page.locator('[data-fx="year"] [aria-checked="true"]').getAttribute('aria-label'),
  ).toBe('Final year');
  await expect(page.locator('[data-fx="why"]')).toHaveValue('I enjoy organising events.');
  await expect(page.locator('[data-fx="year-other"]')).toHaveValue(''); // "Other" text left alone
  expect(await submits(page)).toEqual([]);
  await expectAccessible(panel, 'fill session');
  await expectNoHorizontalScroll(panel);
});

test('Upwork-like wizard: step 1 and step 2 through the panel, keyboard review, never submits', async ({
  context,
  extensionId,
}) => {
  const { page, panel } = await openPanel(context, extensionId, 'upwork-profile-like.html');
  await onboard(panel, {
    Headline: 'Business Consultant for Growing SMBs',
    Skills: 'Excel, SQL',
    City: 'Pune',
    'Mobile number': '+91 98765 43210',
  });
  await panel
    .getByLabel('What are we doing? (optional)')
    .fill('Create my Upwork profile as a business consultant');
  await panel.getByLabel('Role').fill('Business consultant');
  await panel.getByRole('button', { name: 'Start on this page' }).click();
  await expect(
    panel.getByText('Goal: Create my Upwork profile as a business consultant'),
  ).toBeVisible();

  const overview = question(panel, 'Profile overview');
  await expect(overview).toContainText('Offline mode');
  await overview.getByRole('textbox').fill('I help small businesses fix their operations.');
  await expect(overview.getByText(/\d+ \/ 5000 characters/)).toBeVisible();
  await overview.getByRole('button', { name: 'Use this answer' }).click();
  const level = question(panel, 'Experience level');
  await level.getByRole('button', { name: 'Intermediate' }).click();
  await level.getByRole('button', { name: 'Use this answer' }).click();
  for (const label of ['Hourly rate', 'English proficiency']) {
    const q = question(panel, label);
    if (label === 'English proficiency') await q.getByRole('button', { name: 'Fluent' }).click();
    else await q.getByRole('textbox').fill('25');
    await q.getByRole('button', { name: 'Use this answer' }).click();
  }

  // Keyboard review: focus a row, move with arrows, approve with A.
  const first = row(panel, 'Your professional role');
  await first.focus();
  await panel.keyboard.press('a');
  await expect(first.getByTestId('review-status')).toHaveText('Approved');
  await panel.keyboard.press('ArrowDown');
  await expect(row(panel, 'Hourly rate')).toBeFocused(); // next field on the page (already approved: it was your answer)
  await panel.keyboard.press('ArrowDown');
  await expect(row(panel, 'Skills')).toBeFocused();
  await panel.keyboard.press('a');
  await expect(row(panel, 'Skills').getByTestId('review-status')).toHaveText('Approved');

  await panel.getByRole('button', { name: /Fill \d+ approved/ }).click();
  await expect(page.locator('#title')).toHaveValue('Business Consultant for Growing SMBs');
  await expect(page.locator('#overview')).toHaveValue(
    'I help small businesses fix their operations.',
  );
  await expect(page.locator('input[name="level"][value="intermediate"]')).toBeChecked();

  // Clicking a field on the page points at its row in the panel.
  await page.locator('#rate').click();
  await expect(row(panel, 'Hourly rate')).toHaveClass(/ring-2/);

  // The user clicks Next; the panel follows.
  await page.getByRole('button', { name: 'Next' }).click();
  await expect(panel.getByTestId('next-page')).toBeVisible();
  await expect(row(panel, 'City')).toBeVisible();
  await expect(question(panel, 'Street address')).toBeVisible();
  await question(panel, 'Street address').getByRole('textbox').fill('Flat 4B, Sunrise Apartments');
  await question(panel, 'Street address').getByRole('button', { name: 'Use this answer' }).click();
  await question(panel, 'ZIP/Postal code').getByRole('button', { name: 'Skip' }).click();
  await panel.getByRole('button', { name: /Approve all from vault/ }).click();
  await panel.getByRole('button', { name: /Fill \d+ approved/ }).click();
  await expect(panel.getByTestId('ready')).toBeVisible();
  await expect(page.locator('#city')).toHaveValue('Pune');
  await expect(page.locator('#street')).toHaveValue('Flat 4B, Sunrise Apartments');
  await expect(page.locator('#zip')).toHaveValue('');
  expect(await submits(page)).toEqual([]);
});

test('denied fields are listed with reasons and stay empty; iframe fields are planned too', async ({
  context,
  extensionId,
}) => {
  const { page, panel } = await openPanel(context, extensionId, 'tricky.html');
  await onboard(panel);
  await panel.getByRole('button', { name: 'Start on this page' }).click();
  await panel.getByTestId('not-filled').locator('summary').click();
  const notFilled = (label: string) =>
    panel
      .getByTestId('not-filled-row')
      .filter({ has: panel.getByTestId('not-filled-label').getByText(label, { exact: true }) });
  for (const label of ['Password', 'Card number', 'Passport number', 'Reference code']) {
    await expect(notFilled(label)).toContainText('Never filled');
  }
  await expect(notFilled('Referral code')).toContainText('Optional code');
  await expect(question(panel, 'Company name')).toBeVisible(); // inside a shadow root
  await expect(page.locator('#pw')).toHaveValue('');
});

test('a page Filler may not read asks for site access', async ({ context, extensionId }) => {
  const { panel } = await openPanel(context, extensionId); // only about:blank besides the panel
  await onboard(panel);
  await panel.getByRole('button', { name: 'Start on this page' }).click();
  await expect(panel.getByRole('alert')).toContainText('needs your permission');
  await expect(panel.getByRole('button', { name: 'Allow access' })).toBeVisible();
});

// --------------------------------------------------------------- 6.4

test('settings: trusting a site auto-approves vault values; forgetting a site asks again; highlights can be turned off', async ({
  context,
  extensionId,
}) => {
  const { page, panel } = await openPanel(context, extensionId, 'simple-contact.html');
  await onboard(panel, { 'Full name': 'Priya Sharma', Email: 'priya@example.com', City: 'Pune' });
  await panel.getByRole('button', { name: 'Start on this page' }).click();
  const phone = question(panel, 'Mobile number');
  await phone.getByRole('textbox').fill('+91 98765 43210');
  await phone.getByRole('button', { name: 'Use this answer' }).click();
  await expect(row(panel, 'Full name').getByTestId('review-status')).toHaveText('Needs approval');
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          document.querySelector('[data-filler-overlay]')?.shadowRoot?.querySelectorAll('.box')
            .length ?? 0,
      ),
    )
    .toBeGreaterThan(0);
  await panel.getByRole('button', { name: 'End' }).click();

  await panel.getByRole('tab', { name: 'Settings' }).click();
  await expectAccessible(panel, 'settings');
  await panel.getByRole('switch', { name: 'Trust this site' }).click();
  await expect(panel.getByTestId('trusted-list')).toContainText('127.0.0.1');
  await panel.getByRole('switch', { name: 'Highlight fields on the page' }).click();
  await panel.getByRole('tab', { name: 'Fill' }).click();
  await panel.getByRole('button', { name: 'Start on this page' }).click();
  await expect(row(panel, 'Full name').getByTestId('review-status')).toHaveText('Approved');
  await expect(row(panel, 'Mobile number').getByTestId('review-status')).toHaveText('Approved'); // remembered → vault value
  await expect(panel.getByTestId('question')).toHaveCount(1); // only Message
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          document.querySelector('[data-filler-overlay]')?.shadowRoot?.querySelectorAll('.box')
            .length ?? 0,
      ),
    )
    .toBe(0);
  await panel.getByRole('button', { name: 'End' }).click();

  // Forget what was learned here: the custom/remembered mapping for the phone stays as a fact,
  // but field memory is gone, so fields that needed memory are asked again.
  await panel.getByRole('tab', { name: 'Settings' }).click();
  await panel.getByRole('button', { name: 'Forget what Filler learned on this site' }).click();
  await expect(panel.getByText(/Forgot \d+ remembered field/)).toBeVisible();

  // Theme switch applies immediately.
  await panel.getByLabel('Theme').selectOption('dark');
  await expect(panel.locator('html')).toHaveClass(/dark/);
  await expectAccessible(panel, 'settings (dark)');
  await expectNoHorizontalScroll(panel);
});
