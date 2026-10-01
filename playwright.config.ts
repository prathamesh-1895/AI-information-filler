import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  timeout: 30_000,
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
  use: { baseURL: 'http://127.0.0.1:5178' },
  webServer: [
    {
      command: 'node scripts/serve-fixtures.mjs',
      url: 'http://127.0.0.1:5178/index.html',
      reuseExistingServer: true,
    },
    {
      command: 'node scripts/mock-supabase.mjs',
      url: 'http://127.0.0.1:54321/__mock/db',
      reuseExistingServer: true,
    },
  ],
});
