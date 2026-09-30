/** Panel-side helpers: send a request to the background and validate the reply. */
import type { z } from 'zod';
import {
  PageScanSchema,
  resultSchema,
  SITE_ACCESS,
  TargetTabSchema,
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
