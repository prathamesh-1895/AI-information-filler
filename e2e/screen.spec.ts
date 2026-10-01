import type { BrowserContext, Page } from '@playwright/test';
import { captureTest as test, expect, launchDevice } from './fixtures';

/**
 * PLAYBOOK Phase 10 through the real panel. The mock Supabase runs the real
 * `ai-vision` handler; the scripted "model" answers with the recording for
 * the page title (test-fixtures/__ai__/vision). Screen/window sharing uses
 * the OS picker, which Playwright cannot click: see docs/MANUAL_TESTS.md.
 */

const MOCK = 'http://127.0.0.1:54321';
const PASS = 'correct horse battery staple';
const HIDE = [15, 23, 42]; // HIDE_COLOUR #0f172a

async function mockAi(body: Record<string, unknown> = {}) {
  const res = await fetch(`${MOCK}/__mock/ai`, { method: 'POST', body: JSON.stringify(body) });
  return (await res.json()) as {
    providerCalls: number;
    prompts: string[];
    lastImage: string | null;
  };
}

async function setup(context: BrowserContext, extensionId: string, fixture: string, signIn = true) {
  const page = await context.newPage();
  await page.goto(`http://127.0.0.1:5178/${fixture}`);
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
  await panel.getByRole('button', { name: 'Save and continue' }).click();
  await expect(panel.getByRole('tab', { name: 'Fill' })).toBeVisible();
  if (signIn) {
    const email = `screen-${Math.random().toString(36).slice(2, 8)}@example.com`;
    await panel.getByRole('tab', { name: 'Settings' }).click();
    await panel.getByLabel('Email', { exact: true }).fill(email);
    await panel.getByRole('button', { name: 'Email me a code' }).click();
    await expect(panel.getByText(`We emailed a 6-digit code to ${email}.`)).toBeVisible();
    const { code } = (await (
      await fetch(`${MOCK}/__mock/code?email=${encodeURIComponent(email)}`)
    ).json()) as {
      code: string;
    };
    await panel.getByLabel('Code from the email').fill(code);
    await panel.getByRole('button', { name: 'Sign in' }).click();
    await expect(panel.getByTestId('signed-in-as')).toBeVisible();
  }
  return { page, panel };
}

/** Pixel colour of the image the "model" received, at image coordinates. */
async function pixelOfUpload(panel: Page, x: number, y: number): Promise<number[]> {
  const { lastImage } = await mockAi();
  expect(lastImage).toBeTruthy();
  return panel.evaluate(
    async ({ data, x, y }) => {
      const img = new Image();
      img.src = `data:image/jpeg;base64,${data}`;
      await img.decode();
      const c = document.createElement('canvas');
      c.width = img.width;
      c.height = img.height;
      const ctx = c.getContext('2d')!;
      ctx.drawImage(img, 0, 0);
      return [...ctx.getImageData(Math.round(x), Math.round(y), 1, 1).data.slice(0, 3)];
    },
    { data: lastImage!, x, y },
  );
}
const near = (a: number[], b: number[]) => a.every((v, i) => Math.abs(v - b[i]!) <= 24);

const suggestion = (panel: Page, label: string) =>
  panel
    .getByTestId('suggestion')
    .filter({ has: panel.getByTestId('suggestion-label').getByText(label, { exact: true }) });

test.afterEach(async () => {
  await mockAi({ mode: 'up', limitCalls: 200, clearCache: true });
});

test('tab snapshot: never-fill fields are hidden automatically, the user hides more, and the AI never sees either', async () => {
  const { context, extensionId } = await launchDevice({ realViewport: true, capture: true });
  const { page, panel } = await setup(context, extensionId, 'ai-understanding.html');
  await page.locator('#pw').scrollIntoViewIfNeeded();
  const pw = (await page.locator('#pw').boundingBox())!;
  const team = (await page.locator('#hidden-ask').boundingBox())!;

  await panel.getByRole('tab', { name: 'Screen' }).click();
  await panel.getByRole('button', { name: 'Snapshot this tab' }).click();
  const frame = panel.getByTestId('frame');
  await expect(frame).toHaveCount(1);
  await expect(frame.getByTestId('hidden-count')).toHaveText(
    '1 hidden (1 never-fill field hidden automatically)',
  );

  // The user hides the "Team name" box by dragging over it on the preview.
  const canvas = frame.getByTestId('frame-canvas');
  const cb = (await canvas.boundingBox())!;
  const ratio = cb.width / (await canvas.evaluate((c: HTMLCanvasElement) => c.width));
  const at = (x: number, y: number) => ({ x: cb.x + x * ratio, y: cb.y + y * ratio });
  const from = at(team.x - 4, team.y - 4);
  const to = at(team.x + team.width + 4, team.y + team.height + 4);
  await panel.mouse.move(from.x, from.y);
  await panel.mouse.down();
  await panel.mouse.move(to.x, to.y, { steps: 5 });
  await panel.mouse.up();
  await expect(frame.getByTestId('hidden-count')).toHaveText(
    '2 hidden (1 never-fill field hidden automatically)',
  );

  await panel.getByRole('button', { name: 'Read with AI' }).click();
  await expect(panel.getByTestId('screen-results')).toBeVisible();
  await expect(
    suggestion(panel, 'Where are you based these days?').getByTestId('suggestion-value'),
  ).toHaveText('Pune');
  await expect(suggestion(panel, 'Choose a password')).toContainText('Never filled');
  await expect(panel.getByTestId('copy-note')).toHaveText(
    'Filler can’t type into this app. Copy each value.',
  );

  // What was uploaded: both areas are solid, on-device blackouts (the image is 1:1 with the viewport here).
  expect(near(await pixelOfUpload(panel, pw.x + pw.width / 2, pw.y + pw.height / 2), HIDE)).toBe(
    true,
  );
  expect(
    near(await pixelOfUpload(panel, team.x + team.width / 2, team.y + team.height / 2), HIDE),
  ).toBe(true);
  // …and an ordinary area is not.
  expect(near(await pixelOfUpload(panel, 5, 5), HIDE)).toBe(false);
  expect(
    await panel.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1),
  ).toBe(true);
  await context.close();
});

test('canvas form: a suggestion list in screen order with vault values, and Copy puts the value on the clipboard', async ({
  context,
  extensionId,
}) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write'], {
    origin: 'http://127.0.0.1:5178',
  });
  const { page, panel } = await setup(context, extensionId, 'canvas-form.html');
  await panel.getByRole('tab', { name: 'Screen' }).click();
  await panel.getByRole('button', { name: 'Snapshot this tab' }).click();
  await expect(panel.getByTestId('frame-canvas')).toBeVisible();
  await panel.getByRole('button', { name: 'Read with AI' }).click();

  const results = panel.getByTestId('screen-results');
  await expect(results.getByRole('heading')).toHaveText('Event registration');
  await expect(panel.getByTestId('copy-note')).toBeVisible();
  await expect(panel.getByTestId('suggestion-label')).toHaveText([
    'Full name',
    'Email address',
    'City',
    'Password',
    'Why do you want to attend?',
  ]);
  await expect(suggestion(panel, 'Full name').getByTestId('suggestion-value')).toHaveText(
    'Priya Sharma',
  );
  await expect(suggestion(panel, 'City').getByTestId('suggestion-value')).toHaveText('Pune');
  await expect(suggestion(panel, 'Email address')).toContainText('Your vault has no email yet.');
  await expect(suggestion(panel, 'Password')).toContainText('Never filled');
  await expect(suggestion(panel, 'Password').getByRole('button', { name: /Copy/ })).toHaveCount(0);

  await panel.bringToFront();
  await suggestion(panel, 'Full name').getByRole('button', { name: 'Copy Full name' }).click();
  await expect(
    suggestion(panel, 'Full name').getByRole('button', { name: 'Copy Full name' }),
  ).toHaveText('Copied');
  // The system clipboard is shared: read it back from the page.
  await page.bringToFront();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe('Priya Sharma');
  await panel.bringToFront();

  // "What is this?" on one area of the picture.
  await panel.getByRole('button', { name: 'What is this?' }).click();
  const canvas = panel.getByTestId('frame-canvas');
  const cb = (await canvas.boundingBox())!;
  await panel.mouse.move(cb.x + 20, cb.y + 60);
  await panel.mouse.down();
  await panel.mouse.move(cb.x + 200, cb.y + 100, { steps: 4 });
  await panel.mouse.up();
  const answer = panel.getByTestId('region-answer');
  await expect(answer).toContainText('Full name');
  await expect(answer).toContainText('Filler would use: Priya Sharma');
  await expect(answer).toContainText("Source: Filler's AI (read from the screen)");
});

test('without AI the picture is never sent, and the user is told why', async ({
  context,
  extensionId,
}) => {
  const before = (await mockAi()).providerCalls;
  const { panel } = await setup(context, extensionId, 'canvas-form.html', false);
  await panel.getByRole('tab', { name: 'Screen' }).click();
  await panel.getByRole('button', { name: 'Snapshot this tab' }).click();
  await expect(panel.getByTestId('frame-canvas')).toBeVisible();
  await expect(panel.getByRole('button', { name: 'Read with AI' })).toBeDisabled();
  await expect(
    panel.getByText('Reading the picture needs AI (not signed in). Nothing has been sent.'),
  ).toBeVisible();
  expect((await mockAi()).providerCalls).toBe(before);
});

test('"What is this?" explains tricky fields with their source, offline', async ({
  context,
  extensionId,
}) => {
  const { panel } = await setup(context, extensionId, 'tricky.html', false);
  await panel.getByRole('button', { name: 'Start on this page' }).click();
  await expect(panel.getByTestId('phase')).toHaveText('Ready for your review');
  await panel.getByTestId('not-filled').locator('summary').click();

  const explain = async (label: string) => {
    const button = panel.getByRole('button', { name: `What is “${label}”?` }).first();
    await button.click();
    return button.locator('xpath=..').getByTestId('explanation');
  };
  const passport = await explain('Passport number');
  await expect(passport).toContainText(
    "This asks for your passport number, which Filler won't fill.",
  );
  await expect(passport.getByTestId('explanation-source')).toHaveText(
    "Source: Filler's never-fill rules",
  );
  const card = await explain('Card number');
  await expect(card).toContainText("This asks for a card number, which Filler won't fill.");
  const pin = await explain('Pin code');
  await expect(pin).toContainText('This asks for your postal code.');
  await expect(pin.getByTestId('explanation-source')).toHaveText(
    "Source: Filler's rules (the field's label and markup)",
  );
  const cover = await explain('Cover letter');
  await expect(cover).toContainText('This needs a written answer in your own words');
  const referral = await explain('Referral code');
  await expect(referral).toContainText('Optional code');
});

test('when the picture does not line up with the page, nothing is sent until the user confirms', async ({
  context,
  extensionId,
}) => {
  // Playwright's emulated viewport differs from the real window here, which is
  // exactly the situation the guard is for (a page that changed size).
  const { panel } = await setup(context, extensionId, 'ai-understanding.html');
  await panel.getByRole('tab', { name: 'Screen' }).click();
  await panel.getByRole('button', { name: 'Snapshot this tab' }).click();
  const warning = panel.getByTestId('misaligned');
  await expect(warning).toContainText('may have missed password, card or ID fields');
  await expect(panel.getByRole('button', { name: 'Read with AI' })).toBeDisabled();
  await warning.getByLabel('I have hidden everything private on this picture').check();
  await expect(panel.getByRole('button', { name: 'Read with AI' })).toBeEnabled();
});
