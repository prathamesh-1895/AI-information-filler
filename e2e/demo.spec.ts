import { fileURLToPath } from 'node:url';
import type { Page } from '@playwright/test';
import { expect, launchDevice, test } from './fixtures';
import { submits } from './agent';

/**
 * PLAYBOOK Task 12.4: docs/DEMO_SCRIPT.md rehearsed end to end, with AI on
 * (local mock backend, real function handlers) and in offline mode.
 */

const MOCK = 'http://127.0.0.1:54321';
const PASS = 'correct horse battery staple';
const BASE = 'http://127.0.0.1:5178';
const resume = fileURLToPath(new URL('../test-fixtures/resumes/asha-verma.pdf', import.meta.url));

test.use({ actionTimeout: 15_000 });

const question = (panel: Page, text: string | RegExp) =>
  panel.getByTestId('question').filter({ hasText: text });

async function demo(aiOn: boolean) {
  await fetch(`${MOCK}/__mock/ai`, {
    method: 'POST',
    body: JSON.stringify({ mode: 'up', limitCalls: 200, clearCache: true }),
  });
  const { context, extensionId } = await launchDevice({ capture: true, realViewport: true });
  const tab = async (fixture: string) => {
    const p = await context.newPage();
    await p.goto(`${BASE}/${fixture}`);
    return p;
  };
  const google = await tab('google-form-like.html');
  const panel = await context.newPage();
  await panel.goto(`chrome-extension://${extensionId}/sidepanel.html`);
  const focus = async (p: Page) => {
    await p.bringToFront();
    await panel.bringToFront();
    await panel.reload(); // the panel follows the most recently used tab
    await expect(panel.getByRole('tab', { name: 'Fill' })).toBeVisible();
  };

  // 0:30 vault
  await panel.getByRole('button', { name: 'Get started' }).click();
  await panel.getByLabel('Passphrase', { exact: true }).fill(PASS);
  await panel.getByLabel('Type it again').fill(PASS);
  await panel.getByLabel('I understand my passphrase cannot be recovered.').check();
  await panel.getByRole('button', { name: 'Create vault' }).click();
  await panel.getByRole('button', { name: 'Skip for now' }).click();
  if (aiOn) {
    const email = `demo-${Math.random().toString(36).slice(2, 8)}@example.com`;
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
  }

  // 1:00 résumé import
  await panel.getByRole('tab', { name: 'My details' }).click();
  await panel.getByLabel('Choose a résumé file').setInputFiles(resume);
  await panel.getByRole('button', { name: 'Find my details' }).click();
  const review = panel.getByTestId('import-review');
  await expect(review).toContainText(aiOn ? 'Read with Filler’s AI' : 'Read on this device only');
  await panel
    .getByTestId('import-row')
    .filter({ has: panel.getByTestId('import-label').getByText('Date of birth', { exact: true }) })
    .getByRole('checkbox')
    .uncheck();
  await review.getByRole('button', { name: /Save \d+ details/ }).click();
  await expect(panel.getByTestId('import-card')).toContainText('Saved');

  // 2:00 Google-Form-like
  await focus(google);
  await panel.getByRole('button', { name: 'Start on this page' }).click();
  await expect(panel.getByTestId('phase')).toHaveText('Ready for your review');
  const year = question(panel, /Which year (of study )?are you in\?/);
  await year.getByRole('button', { name: 'Final year' }).click();
  await year.getByRole('button', { name: 'Use this answer' }).click();
  await panel.getByRole('button', { name: /Approve all from vault/ }).click();
  await panel.getByRole('button', { name: /Fill \d+ approved/ }).click();
  await expect(google.locator('[data-fx="name"]')).toHaveValue('Asha Verma');
  await panel.getByRole('button', { name: 'End' }).click();

  // 3:00 Upwork-like with a template and drafts
  const upwork = await tab('upwork-profile-like.html');
  await focus(upwork);
  await panel
    .getByLabel('Start from a template (optional)')
    .selectOption({ label: 'Upwork profile: <role>' });
  await panel.getByLabel('Your role', { exact: true }).fill('Business consultant');
  await panel.getByRole('button', { name: 'Start on this page' }).click();
  await expect(panel.getByTestId('phase')).toHaveText('Ready for your review');
  await expect(panel.getByTestId('profile')).toContainText('Tips for Freelance marketplace');
  const rate = question(panel, 'Hourly rate');
  if (await rate.count()) {
    await rate.getByRole('textbox').fill('25');
    await rate.getByRole('button', { name: 'Use this answer' }).click();
  }
  await panel.getByRole('button', { name: /Approve all from vault/ }).click();
  await panel.getByRole('button', { name: /Fill \d+ approved/ }).click();
  await expect(upwork.locator('#overview')).not.toHaveValue('');
  // 4:00 the user clicks Next; Filler follows (step 2 from the vault, step 3 drafted).
  await upwork.getByRole('button', { name: 'Next' }).click();
  await expect(panel.getByTestId('review-row').filter({ hasText: 'City' })).toBeVisible();
  await panel.getByRole('button', { name: /Approve all from vault/ }).click();
  await panel.getByRole('button', { name: /Fill \d+ approved/ }).click();
  await upwork.getByRole('button', { name: 'Next' }).click();
  const pitch = question(panel, 'Why should clients hire you?');
  if (aiOn) {
    await expect(pitch.getByTestId('draft-controls')).toContainText('Using:');
    await pitch.getByRole('button', { name: 'Draft with AI' }).click();
    const row = panel.getByTestId('review-row').filter({ hasText: 'Why should clients hire you?' });
    await expect(row.getByTestId('draft-why')).toBeVisible();
    await row.getByLabel('Change it how?').fill('mention my GST Automation project');
    await row.getByRole('button', { name: 'Regenerate' }).click();
    await expect(row.getByTestId('review-value')).toContainText('GST Automation');
    await row.getByRole('button', { name: 'Approve' }).click();
  } else {
    await expect(pitch).toContainText('Offline mode: Filler needs you to write this one.');
    await pitch.getByRole('textbox').fill('I make small businesses calmer about their numbers.');
    await pitch.getByRole('button', { name: 'Use this answer' }).click();
  }
  await panel.getByRole('button', { name: /Fill \d+ approved/ }).click();
  await expect(upwork.locator('#pitch')).not.toHaveValue('');
  expect(await submits(upwork)).toEqual([]);
  await panel.getByRole('button', { name: 'End' }).click();

  // 5:00 Screen mode on the canvas form
  const canvas = await tab('canvas-form.html');
  await focus(canvas);
  await panel.getByRole('tab', { name: 'Screen' }).click();
  await panel.getByRole('button', { name: 'Snapshot this tab' }).click();
  await expect(panel.getByTestId('frame-canvas')).toBeVisible();
  await panel.getByTestId('frame-canvas').scrollIntoViewIfNeeded();
  const cb = (await panel.getByTestId('frame-canvas').boundingBox())!;
  const scale =
    cb.width /
    (await panel.getByTestId('frame-canvas').evaluate((c: HTMLCanvasElement) => c.width));
  await panel.mouse.move(cb.x + 35 * scale, cb.y + 372 * scale);
  await panel.mouse.down();
  await panel.mouse.move(cb.x + 445 * scale, cb.y + 420 * scale, { steps: 4 });
  await panel.mouse.up();
  await expect(panel.getByTestId('hidden-count')).toContainText('1 hidden');
  if (aiOn) {
    await panel.getByRole('button', { name: 'Read with AI' }).click();
    await expect(panel.getByTestId('copy-note')).toBeVisible();
    await expect(panel.getByTestId('suggestion').first()).toContainText('Asha Verma');
  } else {
    await expect(panel.getByRole('button', { name: 'Read with AI' })).toBeDisabled();
    await expect(panel.getByText(/Nothing has been sent/)).toBeVisible();
  }

  // 6:00 privacy: never-filled fields
  const tricky = await tab('tricky.html');
  await focus(tricky);
  await panel.getByRole('button', { name: 'Start on this page' }).click();
  await expect(panel.getByTestId('phase')).toHaveText('Ready for your review');
  await panel.getByTestId('not-filled').locator('summary').click();
  for (const label of ['Password', 'Card number', 'Passport number'])
    await expect(
      panel
        .getByTestId('not-filled-row')
        .filter({ has: panel.getByTestId('not-filled-label').getByText(label, { exact: true }) }),
    ).toContainText('Never filled');
  await panel.getByRole('button', { name: 'What is “Passport number”?' }).click();
  await expect(panel.getByTestId('explanation').first()).toContainText("which Filler won't fill");

  // 6:30 settings
  await panel.getByRole('tab', { name: 'Settings' }).click();
  await expect(panel.getByTestId('ai-card')).toBeVisible();
  for (const p of [google, upwork, canvas, tricky]) expect(await submits(p)).toEqual([]);
  await context.close();
}

test('demo rehearsal: AI on', async () => {
  test.setTimeout(120_000);
  await demo(true);
});

test('demo rehearsal: offline mode', async () => {
  test.setTimeout(120_000);
  await demo(false);
});
