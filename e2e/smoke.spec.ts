import { expect, test } from './fixtures';

test('extension loads and the side panel renders', async ({ context, extensionId }) => {
  expect(extensionId).toMatch(/^[a-p]{32}$/);
  const panel = await context.newPage();
  await panel.goto(`chrome-extension://${extensionId}/sidepanel.html`);
  await expect(panel.getByRole('heading', { name: 'Filler', exact: true })).toBeVisible();
  await expect(panel.getByRole('heading', { name: 'Welcome to Filler' })).toBeVisible();
});

test('fixture harness serves pages and records no submits', async ({ context }) => {
  const page = await context.newPage();
  await page.goto('http://127.0.0.1:5178/simple-contact.html');
  await expect(page.getByLabel('Full name')).toBeVisible();
  expect(
    await page.evaluate(() => (window as unknown as { __submits: unknown[] }).__submits),
  ).toEqual([]);
});
