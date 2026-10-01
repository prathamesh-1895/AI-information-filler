// Builds the extension in E2E mode (fixture-server access, separate output
// folder), then runs Playwright with project-local browsers.
// Usage: node scripts/e2e.mjs [playwright test args]
import { spawnSync } from 'node:child_process';

// E2E builds talk to the local mock Supabase (scripts/mock-supabase.mjs), never a real project.
const env = {
  ...process.env,
  FILLER_E2E: '1',
  PLAYWRIGHT_BROWSERS_PATH: '0',
  VITE_SUPABASE_URL: 'http://127.0.0.1:54321',
  VITE_SUPABASE_ANON_KEY: 'test-anon-key',
};
const run = (args) => spawnSync('pnpm', args, { stdio: 'inherit', shell: true, env }).status ?? 1;

const built = run(['--filter', '@filler/extension', 'build']);
if (built !== 0) process.exit(built);
process.exit(run(['exec', 'playwright', 'test', ...process.argv.slice(2)]));
