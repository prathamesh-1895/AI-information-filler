/**
 * Tab snapshot (PLAYBOOK Task 10.1), background side. Captures the visible
 * part of a tab, optionally a few scrolled screens of a long page, and
 * reports where the never-fill fields are on each frame so the panel can
 * black them out before anything is uploaded. Nothing is uploaded here.
 *
 * Order matters: the tab is brought to the front first, then measured and
 * scanned, then captured, so the boxes describe the same layout as the
 * picture. Each picture's size is checked against the measured viewport;
 * when they disagree the frame is flagged and the panel makes the user
 * hide things by hand before anything can be sent.
 */
import type { Box, Policy } from '@filler/core';
import { scanTab } from '../messaging/background-handler';
import { fail, ok, type Result } from '../messaging/protocol';

export interface CaptureSegment {
  /** PNG of the visible viewport. */
  dataUrl: string;
  /** Viewport size in CSS pixels (the image may be larger on high-DPI screens). */
  viewport: { width: number; height: number };
  scroll: { x: number; y: number };
  /** Boxes to black out automatically, in viewport CSS pixels. */
  hidden: Box[];
}

export interface TabCapture {
  tabId: number;
  url: string;
  title: string;
  segments: CaptureSegment[];
  /** How many never-fill fields were found (some may be off-screen). */
  sensitiveFields: number;
}

interface Metrics {
  x: number;
  y: number;
  width: number;
  height: number;
  pageHeight: number;
  iframes: Box[];
}

/** Chrome allows about two captures a second. */
const CAPTURE_GAP_MS = 600;
const PAD = 6;

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function metrics(tabId: number): Promise<Metrics> {
  const [res] = await browser.scripting.executeScript({
    target: { tabId },
    func: () => ({
      x: window.scrollX,
      y: window.scrollY,
      width: window.innerWidth,
      height: window.innerHeight,
      pageHeight: document.documentElement.scrollHeight,
      iframes: [...document.querySelectorAll('iframe, frame')].map((f) => {
        const r = f.getBoundingClientRect();
        return {
          x: r.left + window.scrollX,
          y: r.top + window.scrollY,
          width: r.width,
          height: r.height,
        };
      }),
    }),
  });
  return res!.result as Metrics;
}

async function scrollTo(tabId: number, x: number, y: number): Promise<{ x: number; y: number }> {
  const [res] = await browser.scripting.executeScript({
    target: { tabId },
    func: (sx: number, sy: number) => {
      window.scrollTo({ left: sx, top: sy, behavior: 'instant' as ScrollBehavior });
      return { x: window.scrollX, y: window.scrollY };
    },
    args: [x, y],
  });
  return res!.result as { x: number; y: number };
}

/** Boxes (document pixels) → visible boxes in viewport pixels, padded and clipped. */
export function toViewport(
  boxes: readonly Box[],
  scroll: { x: number; y: number },
  viewport: { width: number; height: number },
): Box[] {
  return boxes.flatMap((b) => {
    const x = Math.max(0, b.x - scroll.x - PAD);
    const y = Math.max(0, b.y - scroll.y - PAD);
    const right = Math.min(viewport.width, b.x - scroll.x + b.width + PAD);
    const bottom = Math.min(viewport.height, b.y - scroll.y + b.height + PAD);
    return right > x && bottom > y ? [{ x, y, width: right - x, height: bottom - y }] : [];
  });
}

export async function captureTab(
  tabId: number,
  options: { segments: number; policy: Pick<Policy, 'classifyRisk'> },
): Promise<Result<TabCapture>> {
  let tab: Browser.tabs.Tab;
  try {
    tab = await browser.tabs.get(tabId);
  } catch {
    return fail('NO_TAB', 'That tab is no longer open.');
  }
  const [previous] = await browser.tabs.query({ active: true, windowId: tab.windowId });
  const segments: CaptureSegment[] = [];
  let start: Metrics | undefined;
  try {
    if (!tab.active) {
      await browser.tabs.update(tabId, { active: true });
      await wait(350); // let the tab lay out and paint before it is measured
    }
    // Finding the never-fill fields also proves Filler may read this tab.
    const scan = await scanTab(tabId);
    if (!scan.ok) return scan;
    const denied = scan.data.fields.filter(
      (f) => !options.policy.classifyRisk(f).allowed && f.bbox,
    );
    start = await metrics(tabId);
    // Fields in frames other than the top one have boxes relative to their frame:
    // when any of them is sensitive, the whole frame is blacked out.
    const sensitiveBoxes: Box[] = [
      ...denied.filter((f) => f.frameId === 0).map((f) => f.bbox!),
      ...(denied.some((f) => f.frameId !== 0) ? start.iframes : []),
    ];
    const count = Math.max(1, Math.min(3, options.segments));
    for (let i = 0; i < count; i++) {
      const targetY = start.y + i * start.height;
      if (i > 0 && targetY >= start.pageHeight) break;
      const scroll = i === 0 ? { x: start.x, y: start.y } : await scrollTo(tabId, start.x, targetY);
      if (i > 0 && scroll.y <= segments[segments.length - 1]!.scroll.y) break; // the page ended
      if (i > 0) await wait(CAPTURE_GAP_MS);
      const dataUrl = await browser.tabs.captureVisibleTab(tab.windowId, { format: 'png' });
      const viewport = { width: start.width, height: start.height };
      segments.push({
        dataUrl,
        viewport,
        scroll,
        hidden: toViewport(sensitiveBoxes, scroll, viewport),
      });
    }
    return ok({
      tabId,
      url: tab.url ?? '',
      title: tab.title ?? '',
      segments,
      sensitiveFields: denied.length,
    });
  } catch (error) {
    return fail(
      'NO_PERMISSION',
      `Filler could not take a picture of this tab (${error instanceof Error ? error.message : String(error)}). Click Filler's toolbar button on the tab first, or use "Share a screen or window".`,
    );
  } finally {
    if (start && segments.length > 1)
      await scrollTo(tabId, start.x, start.y).catch(() => undefined);
    if (previous?.id !== undefined && previous.id !== tabId)
      await browser.tabs.update(previous.id, { active: true }).catch(() => undefined);
  }
}
