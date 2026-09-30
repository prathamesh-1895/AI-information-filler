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

test('panel highlights fields on the page and reports which field the user clicked', async ({
  context,
  extensionId,
}) => {
  const { page, panel } = await openPanelFor(context, extensionId, 'simple-contact.html');
  await panel.getByRole('button', { name: 'Scan this page' }).click();
  await expect(panel.getByTestId('field-count')).toHaveText('5 fields');
  await panel.getByRole('button', { name: 'Highlight fields' }).click();
  await expect(panel.getByRole('button', { name: 'Clear highlights' })).toBeVisible();
  // The overlay lives in the page's isolated world, but its DOM is shared.
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          document.querySelector('[data-filler-overlay]')?.shadowRoot?.querySelectorAll('.box')
            .length ?? 0,
      ),
    )
    .toBe(5);

  await page.locator('#city').click();
  await expect(panel.locator('[aria-current="true"]')).toContainText('City');

  await panel.getByRole('button', { name: 'Clear highlights' }).click();
  await expect
    .poll(() => page.evaluate(() => document.querySelectorAll('[data-filler-overlay]').length))
    .toBe(0);
});

test('panel follows a wizard: new step fields appear without rescanning', async ({
  context,
  extensionId,
}) => {
  const { page, panel } = await openPanelFor(context, extensionId, 'upwork-profile-like.html');
  await panel.getByRole('button', { name: 'Scan this page' }).click();
  await expect(panel.getByTestId('field-count')).toHaveText('6 fields');
  await page.getByRole('button', { name: 'Next' }).click();
  await expect(panel.getByTestId('changes')).toHaveText(
    'The page changed: 4 new fields, 6 went away.',
  );
  await expect(panel.getByTestId('field-label')).toHaveText([
    'Street address',
    'City',
    'ZIP/Postal code',
    'Phone',
  ]);
});

test('fill and navigation requests go through the background with safety intact', async ({
  context,
  extensionId,
}) => {
  const { page, panel } = await openPanelFor(context, extensionId, 'tricky.html');
  const scanned = await panel.evaluate(async () => {
    const target = await chrome.runtime.sendMessage({
      type: 'GET_TARGET_TAB',
      selfTabId: (await chrome.tabs.getCurrent())!.id,
    });
    const scan = await chrome.runtime.sendMessage({
      type: 'SCAN_REQUEST',
      tabId: target.data.tabId,
    });
    return {
      tabId: target.data.tabId as number,
      fields: scan.data.fields as Array<{
        id: string;
        label: string;
        selector: string;
        signature: string;
      }>,
    };
  });
  const item = (label: string, value: string) => {
    const f = scanned.fields.find((x) => x.label === label)!;
    return { fieldId: f.id, selector: f.selector, signature: f.signature, value };
  };
  const reply = await panel.evaluate((msg) => chrome.runtime.sendMessage(msg), {
    type: 'FILL_REQUEST',
    tabId: scanned.tabId,
    items: [
      item('Company name', 'Acme Consulting'),
      item('Password', 'hunter2hunter2'),
      item('Referral code', 'FRIEND50'),
    ],
  });
  expect(reply.ok).toBe(true);
  expect(reply.data.map((r: { status: string }) => r.status)).toEqual([
    'filled',
    'failed',
    'filled',
  ]);
  expect(reply.data[1].error).toContain('Passwords are never filled');
  expect(reply.data[2].fieldId).toMatch(/^[1-9]\d*:f\d+$/); // iframe field routed to its own frame
  await expect(page.locator('#pw')).toHaveValue('');
  await expect(page.frameLocator('iframe').locator('#referral-code')).toHaveValue('FRIEND50');

  const buttons = await panel.evaluate(
    (tabId) => chrome.runtime.sendMessage({ type: 'NAV_LIST_REQUEST', tabId }),
    scanned.tabId,
  );
  const submit = buttons.data.find((b: { text: string }) => b.text === 'Create account');
  expect(submit.submitLike).toBe(true);
  const click = await panel.evaluate((msg) => chrome.runtime.sendMessage(msg), {
    type: 'NAV_CLICK_REQUEST',
    tabId: scanned.tabId,
    buttonId: submit.buttonId,
  });
  expect(click).toMatchObject({ ok: false, error: { code: 'REFUSED' } });
  expect(
    await page.evaluate(() => (window as unknown as { __submits: unknown[] }).__submits),
  ).toEqual([]);
});

test('scripts running inside web pages cannot drive the background', async ({
  context,
  extensionId,
}) => {
  const { page, panel } = await openPanelFor(context, extensionId, 'simple-contact.html');
  // The page's own JavaScript world has no extension messaging at all.
  expect(
    await page.evaluate(
      () =>
        typeof (window as unknown as { chrome?: { runtime?: { sendMessage?: unknown } } }).chrome
          ?.runtime?.sendMessage,
    ),
  ).toBe('undefined');
  // A script in the page's *extension* (isolated) world, where the page agent runs, can send
  // messages, but the background only answers Filler's own extension pages.
  const outcome = await panel.evaluate(async () => {
    const target = await chrome.runtime.sendMessage({
      type: 'GET_TARGET_TAB',
      selfTabId: (await chrome.tabs.getCurrent())!.id,
    });
    const [res] = await chrome.scripting.executeScript({
      target: { tabId: target.data.tabId },
      func: async (tabId: number) => {
        try {
          const reply = await chrome.runtime.sendMessage({ type: 'SCAN_REQUEST', tabId });
          return { reply: reply ?? null };
        } catch (e) {
          return { error: String(e) };
        }
      },
      args: [target.data.tabId],
    });
    return res!.result as { reply?: unknown; error?: string };
  });
  expect(outcome.reply ?? null).toBeNull();
});
