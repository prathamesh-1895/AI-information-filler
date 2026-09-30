/** Background-worker side of the panel protocol. */
import {
  fail,
  joinId,
  ok,
  PanelRequestSchema,
  SITE_ACCESS,
  splitId,
  type FillItem,
  type FillResult,
  type HighlightItem,
  type NavButton,
  type PageScan,
  type Result,
  type TargetTab,
} from './protocol';
import {
  classifyInjectionError,
  groupByFrame,
  isRestrictedUrl,
  mergeFrameScans,
} from './scan-merge';

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

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** Runs a page-agent call in specific frames (or all frames) and collects per-frame results. */
async function inFrames<A extends unknown[], R>(
  tabId: number,
  frameIds: number[] | 'all',
  func: (...args: A) => R,
  args: A,
): Promise<Array<{ frameId: number; result: Awaited<R> | undefined }>> {
  const target = frameIds === 'all' ? { tabId, allFrames: true } : { tabId, frameIds };
  const results = await browser.scripting.executeScript({ target, func, args } as never);
  return (results as Array<{ frameId: number; result?: Awaited<R> }>).map((r) => ({
    frameId: r.frameId,
    result: r.result,
  }));
}

export async function fillTab(tabId: number, items: FillItem[]): Promise<Result<FillResult[]>> {
  const out: FillResult[] = [];
  for (const [frameId, local] of groupByFrame(items)) {
    try {
      const [frame] = await inFrames(
        tabId,
        [frameId],
        (list: unknown) =>
          globalThis.__fillerPageAgent?.fill(
            list as Parameters<NonNullable<typeof globalThis.__fillerPageAgent>['fill']>[0],
          ) ?? null,
        [local],
      );
      const results = frame?.result;
      if (!Array.isArray(results)) {
        for (const item of local)
          out.push({
            fieldId: joinId(frameId, item.id),
            status: 'failed',
            error: 'Filler is not active on this page any more. Scan again.',
          });
        continue;
      }
      for (const r of results) {
        out.push({
          fieldId: joinId(frameId, r.id),
          status: r.status,
          ...(r.finalValue !== undefined ? { finalValue: r.finalValue } : {}),
          ...(r.error ? { error: r.error } : {}),
          ...(r.method ? { method: r.method } : {}),
        });
      }
    } catch (error) {
      for (const item of local)
        out.push({
          fieldId: joinId(frameId, item.id),
          status: 'failed',
          error: `Could not reach the page: ${errorText(error)}`,
        });
    }
  }
  return ok(out);
}

export async function highlightTab(
  tabId: number,
  items: HighlightItem[],
): Promise<Result<{ shown: number; missing: string[] }>> {
  const groups = groupByFrame(items);
  let shown = 0;
  const missing: string[] = [];
  try {
    // Every frame with an agent gets a call, so frames whose fields left the plan are cleared.
    const frames = await inFrames(tabId, 'all', () => Boolean(globalThis.__fillerPageAgent), []);
    for (const { frameId, result: hasAgent } of frames) {
      if (!hasAgent) continue;
      const local = groups.get(frameId) ?? [];
      const [r] = await inFrames(
        tabId,
        [frameId],
        (list: unknown) => {
          const agent = globalThis.__fillerPageAgent;
          if (!agent) return null;
          const items = list as Parameters<typeof agent.highlight>[0];
          if (!items.length) {
            agent.clearHighlights();
            return { shown: 0, missing: [] };
          }
          return agent.highlight(items);
        },
        [local],
      );
      if (r?.result) {
        shown += r.result.shown;
        missing.push(...r.result.missing.map((id) => joinId(frameId, id)));
      }
    }
    return ok({ shown, missing });
  } catch (error) {
    return fail('SCAN_FAILED', `Could not highlight fields: ${errorText(error)}`);
  }
}

async function everyFrame(
  tabId: number,
  call: 'observe' | 'stop',
): Promise<Result<{ frames: number }>> {
  try {
    const frames = await inFrames(
      tabId,
      'all',
      (what: string) => {
        const agent = globalThis.__fillerPageAgent;
        if (!agent) return false;
        if (what === 'observe') agent.observe();
        else agent.stop();
        return true;
      },
      [call],
    );
    return ok({ frames: frames.filter((f) => f.result === true).length });
  } catch (error) {
    return fail('SCAN_FAILED', `Could not reach the page: ${errorText(error)}`);
  }
}

export async function listNavigationTab(tabId: number): Promise<Result<NavButton[]>> {
  try {
    const frames = await inFrames(
      tabId,
      'all',
      () => globalThis.__fillerPageAgent?.listNavigation() ?? null,
      [],
    );
    return ok(
      frames.flatMap(({ frameId, result }) =>
        (result ?? []).map((b) => ({
          buttonId: joinId(frameId, b.id),
          text: b.text,
          submitLike: b.submitLike,
        })),
      ),
    );
  } catch (error) {
    return fail('SCAN_FAILED', `Could not read the page's buttons: ${errorText(error)}`);
  }
}

export async function clickNavigationTab(
  tabId: number,
  buttonId: string,
): Promise<Result<{ clicked: true }>> {
  const { frameId, localId } = splitId(buttonId);
  try {
    const [frame] = await inFrames(
      tabId,
      [frameId],
      (id: string) =>
        globalThis.__fillerPageAgent?.clickNavigation(id) ?? {
          ok: false as const,
          error: 'Filler is not active on this page.',
        },
      [localId],
    );
    const result = frame?.result;
    if (!result) return fail('SCAN_FAILED', 'Filler is not active on this page.');
    return result.ok ? ok({ clicked: true }) : fail('REFUSED', result.error);
  } catch (error) {
    return fail('SCAN_FAILED', `Could not reach the page: ${errorText(error)}`);
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
    case 'FILL_REQUEST':
      return fillTab(request.tabId, request.items);
    case 'HIGHLIGHT_REQUEST':
      return highlightTab(request.tabId, request.items);
    case 'OBSERVE_REQUEST':
      return everyFrame(request.tabId, 'observe');
    case 'END_SESSION_REQUEST':
      return everyFrame(request.tabId, 'stop');
    case 'NAV_LIST_REQUEST':
      return listNavigationTab(request.tabId);
    case 'NAV_CLICK_REQUEST':
      return clickNavigationTab(request.tabId, request.buttonId);
  }
}
