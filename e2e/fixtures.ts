import { test as base, chromium, type BrowserContext } from '@playwright/test';
import { fileURLToPath } from 'node:url';

const extensionPath = fileURLToPath(
  new URL('../apps/extension/.output-e2e/chrome-mv3', import.meta.url),
);
/** The tab-snapshot build (adds <all_urls>; see apps/extension/wxt.config.ts). */
const captureExtensionPath = fileURLToPath(
  new URL('../apps/extension/.output-e2e-capture/chrome-mv3', import.meta.url),
);

/** A fresh browser profile with the extension: one "device". */
export async function launchDevice(
  options: { realViewport?: boolean; capture?: boolean } = {},
): Promise<{ context: BrowserContext; extensionId: string }> {
  const path = options.capture ? captureExtensionPath : extensionPath;
  const context = await chromium.launchPersistentContext('', {
    channel: 'chromium',
    args: [`--disable-extensions-except=${path}`, `--load-extension=${path}`],
    // Real window size instead of Playwright's per-page viewport emulation: tab
    // screenshots (captureVisibleTab) see the real window, so boxes must too.
    ...(options.realViewport ? { viewport: null } : {}),
  });
  let [worker] = context.serviceWorkers();
  worker ??= await context.waitForEvent('serviceworker');
  return { context, extensionId: new URL(worker.url()).host };
}

/**
 * Collects console errors and uncaught page errors from every page of a
 * context (PLAYBOOK Task 12.2: zero console errors across the e2e run).
 */
export function watchConsole(context: BrowserContext): string[] {
  const errors: string[] = [];
  context.on('console', (m) => {
    if (m.type() !== 'error') return;
    const where = m.location().url;
    // Browsers log every failed network request; the fixture server has no favicon.
    if (/favicon\.ico/.test(where) || /favicon\.ico/.test(m.text())) return;
    errors.push(`${where}: ${m.text()}`);
  });
  context.on('weberror', (e) => errors.push(`uncaught: ${String(e.error())}`));
  return errors;
}

/** Playwright fixtures: a persistent Chromium context with the built extension loaded. */
export const test = base.extend<{ context: BrowserContext; extensionId: string }>({
  // eslint-disable-next-line no-empty-pattern
  context: async ({}, use) => {
    const context = await chromium.launchPersistentContext('', {
      channel: 'chromium',
      args: [`--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`],
    });
    const errors = watchConsole(context);
    await use(context);
    await context.close();
    test.expect(errors, 'console errors during the test').toEqual([]);
  },
  extensionId: async ({ context }, use) => {
    let [worker] = context.serviceWorkers();
    worker ??= await context.waitForEvent('serviceworker');
    const id = new URL(worker.url()).host;
    await use(id);
  },
});

export const expect = test.expect;

/** Like `test`, but with the tab-snapshot build of the extension (Phase 10). */
export const captureTest = base.extend<{ context: BrowserContext; extensionId: string }>({
  // eslint-disable-next-line no-empty-pattern
  context: async ({}, use) => {
    const { context } = await launchDevice({ capture: true });
    const errors = watchConsole(context);
    await use(context);
    await context.close();
    base.expect(errors, 'console errors during the test').toEqual([]);
  },
  extensionId: async ({ context }, use) => {
    let [worker] = context.serviceWorkers();
    worker ??= await context.waitForEvent('serviceworker');
    await use(new URL(worker.url()).host);
  },
});
