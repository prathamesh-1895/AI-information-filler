/** Background-worker side of the panel protocol. */
import {
  fail,
  ok,
  PanelRequestSchema,
  SITE_ACCESS,
  type PageScan,
  type Result,
  type TargetTab,
} from './protocol';
import { classifyInjectionError, isRestrictedUrl, mergeFrameScans } from './scan-merge';

const isExtensionPage = (url: string | undefined) =>
  url?.startsWith(browser.runtime.getURL('')) ?? false;

/**
 * The tab the user is working in: the active tab of the last focused window.
 * When the panel itself runs as a tab (dev/tests), picks the most recently
 * used other tab instead.
 */
export async function getTargetTab(selfTabId?: number): Promise<Result<TargetTab>> {
  const [active] = await browser.tabs.query({ active: true, lastFocusedWindow: true });
  let tab = active;
  if (!tab || tab.id === selfTabId || isExtensionPage(tab.url)) {
    const candidates = (await browser.tabs.query({}))
      .filter((t) => t.id !== undefined && t.id !== selfTabId && !isExtensionPage(t.url))
      .sort((a, b) => (b.lastAccessed ?? 0) - (a.lastAccessed ?? 0));
    tab = candidates[0];
  }
  if (tab?.id === undefined) return fail('NO_TAB', 'Open the page with the form you want to fill.');
  return ok({
    tabId: tab.id,
    ...(tab.url ? { url: tab.url } : {}),
    ...(tab.title ? { title: tab.title } : {}),
  });
}

export async function scanTab(tabId: number): Promise<Result<PageScan>> {
  let url: string | undefined;
  try {
    url = (await browser.tabs.get(tabId)).url;
  } catch {
    return fail('NO_TAB', 'That tab is no longer open.');
  }
  if (isRestrictedUrl(url)) {
    return fail(
      'RESTRICTED_PAGE',
      'Browsers do not let extensions read this kind of page. Open the form you want to fill.',
    );
  }
  try {
    await browser.scripting.executeScript({
      target: { tabId, allFrames: true },
      files: ['/page-agent.js'],
    });
  } catch (error) {
    const { code, message } = classifyInjectionError(error);
    // With site access already granted, a refusal means a page no extension may read
    // (about:blank, the new-tab page...). Chrome gives the same message for both cases.
    if (code === 'NO_PERMISSION' && (await browser.permissions.contains(SITE_ACCESS))) {
      return fail(
        'RESTRICTED_PAGE',
        'Browsers do not let extensions read this kind of page. Open the form you want to fill.',
      );
    }
    return fail(code, message);
  }
  try {
    const results = await browser.scripting.executeScript({
      target: { tabId, allFrames: true },
      func: () => globalThis.__fillerPageAgent?.scan() ?? null,
    });
    const merged = mergeFrameScans(
      tabId,
      results.map((r) => ({ frameId: r.frameId, result: r.result })),
    );
    return merged
      ? ok(merged)
      : fail('SCAN_FAILED', 'Filler could not read any forms on this page.');
  } catch (error) {
    return fail(
      'SCAN_FAILED',
      `Scanning failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

export async function handlePanelMessage(raw: unknown): Promise<Result<unknown>> {
  const parsed = PanelRequestSchema.safeParse(raw);
  if (!parsed.success) return fail('BAD_REQUEST', 'Unknown request.');
  const request = parsed.data;
  switch (request.type) {
    case 'GET_TARGET_TAB':
      return getTargetTab(request.selfTabId);
    case 'SCAN_REQUEST':
      return scanTab(request.tabId);
  }
}
