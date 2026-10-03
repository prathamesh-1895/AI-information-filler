// Verifies the store zip (PLAYBOOK Task 12.5): unpacks it into a temporary
// folder, loads it into a fresh Chromium profile, and checks that the service
// worker starts, the manifest is the production one, and the side panel
// renders its welcome screen with no console errors.
//   pnpm package && node scripts/verify-package.mjs
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

process.env.PLAYWRIGHT_BROWSERS_PATH = '0';
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const output = join(root, 'apps', 'extension', '.output');
const zipName = readdirSync(output).find((f) => /^filler-.*-chrome\.zip$/.test(f));
if (!zipName)
  throw new Error('No filler-*-chrome.zip in apps/extension/.output. Run `pnpm package` first.');

const require = createRequire(join(root, 'apps', 'extension', 'package.json'));
const JSZip = require('jszip');
const { chromium } = await import('@playwright/test');

const dir = mkdtempSync(join(tmpdir(), 'filler-zip-'));
const profile = mkdtempSync(join(tmpdir(), 'filler-profile-'));
const zip = await JSZip.loadAsync(readFileSync(join(output, zipName)));
for (const [name, entry] of Object.entries(zip.files)) {
  if (entry.dir) continue;
  const target = join(dir, name);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, await entry.async('nodebuffer'));
}

const context = await chromium.launchPersistentContext(profile, {
  channel: 'chromium',
  args: [`--disable-extensions-except=${dir}`, `--load-extension=${dir}`],
});
const errors = [];
context.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
try {
  let [worker] = context.serviceWorkers();
  worker ??= await context.waitForEvent('serviceworker', { timeout: 15_000 });
  const id = new URL(worker.url()).host;
  const manifest = await worker.evaluate(() => chrome.runtime.getManifest());
  const page = await context.newPage();
  await page.goto(`chrome-extension://${id}/sidepanel.html`);
  await page.getByRole('heading', { name: 'Welcome to Filler' }).waitFor({ timeout: 15_000 });
  if (manifest.host_permissions?.length)
    throw new Error('The packaged build has host permissions.');
  if (errors.length) throw new Error(`Console errors: ${errors.join(' | ')}`);
  console.log(
    `Package OK: ${zipName} (version ${manifest.version}, permissions ${manifest.permissions.join(', ')}) loads in a fresh profile and shows the welcome screen.`,
  );
} finally {
  await context.close();
  rmSync(dir, { recursive: true, force: true });
  rmSync(profile, { recursive: true, force: true });
}
