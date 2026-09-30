import { fill } from '@/src/page-agent/fill';
import { clearHighlights, highlight } from '@/src/page-agent/highlight';
import { clickNavigation, listNavigation } from '@/src/page-agent/navigation';
import { observe, stopObserving } from '@/src/page-agent/observer';
import { resolve, scan } from '@/src/page-agent/scan';

export interface PageAgent {
  version: 1;
  scan: typeof scan;
  resolve: typeof resolve;
  fill: typeof fill;
  observe: typeof observe;
  stopObserving: typeof stopObserving;
  listNavigation: typeof listNavigation;
  clickNavigation: typeof clickNavigation;
  highlight: typeof highlight;
  clearHighlights: typeof clearHighlights;
  /** Ends the session in this frame: stops watching and removes the overlay. */
  stop(): void;
}

declare global {
  var __fillerPageAgent: PageAgent | undefined;
}

/**
 * Injected on demand into each frame of the active tab (chrome.scripting).
 * Installs itself once per frame; re-injection is a no-op.
 */
export default defineUnlistedScript(() => {
  if (globalThis.__fillerPageAgent) return;
  globalThis.__fillerPageAgent = {
    version: 1,
    scan,
    resolve,
    fill,
    observe,
    stopObserving,
    listNavigation,
    clickNavigation,
    highlight,
    clearHighlights,
    stop() {
      stopObserving();
      clearHighlights();
    },
  };
});
