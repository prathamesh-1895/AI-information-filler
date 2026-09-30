// Runs the Playwright CLI with browsers stored inside node_modules
// (PLAYWRIGHT_BROWSERS_PATH=0). On this Windows machine Chromium refuses to
// start from %LOCALAPPDATA%\ms-playwright (SideBySide activation error), so the
// project keeps its own copy. Usage: node scripts/playwright.mjs <playwright args>
import { spawnSync } from 'node:child_process';

const result = spawnSync('pnpm', ['exec', 'playwright', ...process.argv.slice(2)], {
  stdio: 'inherit',
  shell: true,
  env: { ...process.env, PLAYWRIGHT_BROWSERS_PATH: '0' },
});
process.exit(result.status ?? 1);
