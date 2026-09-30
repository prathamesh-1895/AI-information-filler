/** Pure helpers for the background scan flow (unit-tested without a browser). */
import { FrameScanSchema, type ErrorCode, type PageScan } from './protocol';

export interface FrameResult {
  frameId: number;
  result?: unknown;
}

/**
 * Merges per-frame scan results into one page scan. Field ids are prefixed
 * with the frame id (`0:f3`) and `frameId` is set, so later fill requests
 * can be routed to the right frame. Invalid frame results are reported, not dropped silently.
 */
export function mergeFrameScans(tabId: number, frames: FrameResult[]): PageScan | null {
  const valid: Array<{ frameId: number; scan: ReturnType<typeof FrameScanSchema.parse> }> = [];
  const errors: string[] = [];
  for (const frame of frames) {
    if (frame.result === null || frame.result === undefined) continue; // agent absent in that frame
    const parsed = FrameScanSchema.safeParse(frame.result);
    if (parsed.success) valid.push({ frameId: frame.frameId, scan: parsed.data });
    else
      errors.push(
        `frame ${frame.frameId}: invalid scan result (${parsed.error.issues[0]?.message ?? 'unknown'})`,
      );
  }
  valid.sort((a, b) => a.frameId - b.frameId);
  const top = valid.find((v) => v.frameId === 0) ?? valid[0];
  if (!top) return null;
  return {
    tabId,
    url: top.scan.url,
    title: top.scan.title,
    scannedAt: top.scan.scannedAt,
    frames: valid.length,
    fields: valid.flatMap(({ frameId, scan }) =>
      scan.fields.map((f) => ({ ...f, id: `${frameId}:${f.id}`, frameId })),
    ),
    errors: [
      ...errors,
      ...valid.flatMap(({ frameId, scan }) => scan.errors.map((e) => `frame ${frameId}: ${e}`)),
    ],
  };
}

const RESTRICTED_URL =
  /^(?:chrome|edge|brave|about|devtools|view-source|chrome-extension|moz-extension):|^https:\/\/(?:chrome\.google\.com\/webstore|chromewebstore\.google\.com|microsoftedge\.microsoft\.com\/addons)/i;

export function isRestrictedUrl(url: string | undefined): boolean {
  return url !== undefined && RESTRICTED_URL.test(url);
}

/** Maps a chrome.scripting error to a code and a message a user can act on. */
export function classifyInjectionError(error: unknown): { code: ErrorCode; message: string } {
  const text = error instanceof Error ? error.message : String(error);
  // Chrome names the URL when it refuses (`Cannot access contents of url "about:blank"`).
  // Asking for site permission would not help on those pages.
  const quotedUrl = /url "([^"]+)"/i.exec(text)?.[1];
  if (quotedUrl && isRestrictedUrl(quotedUrl)) {
    return {
      code: 'RESTRICTED_PAGE',
      message:
        'Browsers do not let extensions read this kind of page. Open the form you want to fill.',
    };
  }
  if (
    /cannot access a (?:chrome|edge|about|devtools)|gallery cannot be scripted|cannot be scripted|chrome-extension:\/\//i.test(
      text,
    )
  ) {
    return {
      code: 'RESTRICTED_PAGE',
      message:
        'Browsers do not let extensions read this kind of page. Open the form you want to fill.',
    };
  }
  if (/permission|cannot access contents|host/i.test(text)) {
    return {
      code: 'NO_PERMISSION',
      message: 'Filler needs your permission to read forms on this site.',
    };
  }
  if (/no tab with id|tab was closed|frame with id/i.test(text)) {
    return { code: 'NO_TAB', message: 'That tab is no longer open.' };
  }
  return { code: 'INJECTION_FAILED', message: `Filler could not read this page (${text}).` };
}

/**
 * Groups page-wide items (`fieldId: "12:f0"`) by frame and swaps in the
 * frame-local id, ready to hand to that frame's page agent.
 */
export function groupByFrame<T extends { fieldId: string }>(
  items: T[],
): Map<number, Array<Omit<T, 'fieldId'> & { id: string }>> {
  const groups = new Map<number, Array<Omit<T, 'fieldId'> & { id: string }>>();
  for (const { fieldId, ...rest } of items) {
    const at = fieldId.indexOf(':');
    const frameId = Number(fieldId.slice(0, at));
    const list = groups.get(frameId) ?? [];
    list.push({ ...rest, id: fieldId.slice(at + 1) });
    groups.set(frameId, list);
  }
  return groups;
}
