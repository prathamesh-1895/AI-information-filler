import { resolve, scan } from '@/src/page-agent/scan';

export interface PageAgent {
  version: 1;
  scan: typeof scan;
  resolve: typeof resolve;
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
  globalThis.__fillerPageAgent = { version: 1, scan, resolve };
});
