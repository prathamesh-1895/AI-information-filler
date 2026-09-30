// Builds the extension in E2E mode (fixture-server access, separate output
// folder), then runs Playwright with project-local browsers.
// Usage: node scripts/e2e.mjs [playwright test args]
import { spawnSync } from 'node:child_process';

const env = { ...process.env, FILLER_E2E: '1', PLAYWRIGHT_BROWSERS_PATH: '0' };
const run = (args) => spawnSync('pnpm', args, { stdio: 'inherit', shell: true, env }).status ?? 1;

const built = run(['--filter', '@filler/extension', 'build']);
if (built !== 0) process.exit(built);
process.exit(run(['exec', 'playwright', 'test', ...process.argv.slice(2)]));
