import type { BrowserContext, Page } from '@playwright/test';
import { expect, test } from './fixtures';

/**
 * Side panel → background → page agent, end to end (PLAYBOOK Task 3.5).
 * The panel runs as a normal tab here (Playwright cannot click the toolbar),
 * so the background targets the most recently used other tab.
 */
async function openPanelFor(
  context: BrowserContext,
  extensionId: string,
  fixture: string,
): Promise<{ page: Page; panel: Page }> {
  const page = await context.newPage();
  await page.goto(`/${fixture}`);
  await page.waitForLoadState('load');
  const panel = await context.newPage();
  await panel.goto(`chrome-extension://${extensionId}/sidepanel.html`);
  return { page, panel };
}

test('panel scans simple-contact and lists every field', async ({ context, extensionId }) => {
  const { page, panel } = await openPanelFor(context, extensionId, 'simple-contact.html');
  await expect(panel.getByTestId('target')).toContainText('Simple contact form');
  await panel.getByRole('button', { name: 'Scan this page' }).click();
  await expect(panel.getByTestId('field-count')).toHaveText('5 fields');
  await expect(panel.getByTestId('field-label')).toHaveText([
    'Full name *',
    'Email address *',
    'Mobile number',
    'City',
    'Message',
  ]);
  await expect(panel.getByTestId('field-denied')).toHaveCount(0);
  expect(
    await page.evaluate(() => (window as unknown as { __submits: unknown[] }).__submits),
  ).toEqual([]);
});

test('panel scans every frame and flags fields Filler never fills', async ({
  context,
  extensionId,
}) => {
  const { page, panel } = await openPanelFor(context, extensionId, 'tricky.html');
  await panel.getByRole('button', { name: 'Scan this page' }).click();
  await expect(panel.getByTestId('field-count')).toHaveText('12 fields in 2 frames');
  const rows = panel.getByTestId('field-row');
  const row = (label: string) =>
    rows.filter({ has: panel.getByTestId('field-label').getByText(label, { exact: true }) });
  await expect(row('Referral code')).toContainText('frame');
  for (const label of ['Password', 'Card number', 'Passport number', 'Reference code']) {
    await expect(row(label).getByTestId('field-denied')).toBeVisible();
  }
  await expect(row('Company name')).toHaveCount(1);
  await expect(row('Company name').getByTestId('field-denied')).toHaveCount(0);
  expect(
    await page.evaluate(() => (window as unknown as { __submits: unknown[] }).__submits),
  ).toEqual([]);
});

test('panel asks for site access when Filler cannot read the page', async ({
  context,
  extensionId,
}) => {
  // Besides the panel, only the browser's initial about:blank tab is open, and the
  // E2E build has no all-sites access, so Chrome refuses with its generic
  // permission error and the panel offers to request access.
  const panel = await context.newPage();
  await panel.goto(`chrome-extension://${extensionId}/sidepanel.html`);
  await panel.getByRole('button', { name: 'Scan this page' }).click();
  await expect(panel.getByRole('alert')).toContainText('Filler needs your permission');
  await expect(
    panel.getByRole('button', { name: 'Allow Filler to read forms on websites' }),
  ).toBeVisible();
});
