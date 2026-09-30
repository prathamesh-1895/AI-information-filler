/** Panel-side helpers: send a request to the background and validate the reply. */
import { z } from 'zod';
import {
  FillResultSchema,
  joinId,
  NavButtonSchema,
  PageEventSchema,
  PageScanSchema,
  resultSchema,
  SITE_ACCESS,
  TargetTabSchema,
  type FillItem,
  type HighlightItem,
  type PageEvent,
  type PanelRequest,
  type Result,
} from './protocol';

async function request<T extends z.ZodType>(
  message: PanelRequest,
  schema: T,
): Promise<Result<z.infer<T>>> {
  let reply: unknown;
  try {
    reply = await browser.runtime.sendMessage(message);
  } catch (error) {
    return {
      ok: false,
      error: {
        code: 'SCAN_FAILED',
        message: `Filler's background service did not answer (${String(error)}).`,
      },
    };
  }
  const parsed = resultSchema(schema).safeParse(reply);
  if (!parsed.success)
    return {
      ok: false,
      error: { code: 'BAD_REQUEST', message: 'Unexpected reply from the background service.' },
    };
  return parsed.data as Result<z.infer<T>>;
}

export async function getTargetTab() {
  const self = await browser.tabs.getCurrent?.();
  return request(
    { type: 'GET_TARGET_TAB', ...(self?.id !== undefined ? { selfTabId: self.id } : {}) },
    TargetTabSchema,
  );
}

export function scanTab(tabId: number) {
  return request({ type: 'SCAN_REQUEST', tabId }, PageScanSchema);
}

/** Must be called directly from a click handler (the browser requires a user gesture). */
export function requestSiteAccess(): Promise<boolean> {
  return browser.permissions.request(SITE_ACCESS);
}

export function fillFields(tabId: number, items: FillItem[]) {
  return request({ type: 'FILL_REQUEST', tabId, items }, z.array(FillResultSchema));
}

export function highlightFields(tabId: number, items: HighlightItem[]) {
  return request(
    { type: 'HIGHLIGHT_REQUEST', tabId, items },
    z.object({ shown: z.number(), missing: z.array(z.string()) }),
  );
}

export function startObserving(tabId: number) {
  return request({ type: 'OBSERVE_REQUEST', tabId }, z.object({ frames: z.number() }));
}

/** Stops watching and removes highlights in every frame of the tab. */
export function endSession(tabId: number) {
  return request({ type: 'END_SESSION_REQUEST', tabId }, z.object({ frames: z.number() }));
}

export function listNavigation(tabId: number) {
  return request({ type: 'NAV_LIST_REQUEST', tabId }, z.array(NavButtonSchema));
}

export function clickNavigation(tabId: number, buttonId: string) {
  return request(
    { type: 'NAV_CLICK_REQUEST', tabId, buttonId },
    z.object({ clicked: z.literal(true) }),
  );
}

/**
 * Subscribes to events from page agents in one tab. Ids are rewritten to the
 * page-wide `<frameId>:<id>` form. Invalid events and other tabs are ignored.
 */
export function onPageEvent(tabId: number, listener: (event: PageEvent) => void): () => void {
  const handler = (message: unknown, sender: { tab?: { id?: number }; frameId?: number }) => {
    if (sender.tab?.id !== tabId) return;
    const parsed = PageEventSchema.safeParse(message);
    if (!parsed.success) return;
    const frameId = sender.frameId ?? 0;
    const event = parsed.data;
    if (event.type === 'FIELD_FOCUSED') listener({ ...event, id: joinId(frameId, event.id) });
    else
      listener({
        ...event,
        added: event.added.map((f) => ({ ...f, id: joinId(frameId, f.id), frameId })),
        removed: event.removed.map((id) => joinId(frameId, id)),
      });
  };
  browser.runtime.onMessage.addListener(handler);
  return () => browser.runtime.onMessage.removeListener(handler);
}
