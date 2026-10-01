import type { BrowserContext, Page } from '@playwright/test';
import { expect, test } from './fixtures';

/**
 * Background trust boundary and frame routing, driven with raw messages from
 * an extension page (Phases 3–4). The panel UI itself is covered by ui.spec.ts.
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
