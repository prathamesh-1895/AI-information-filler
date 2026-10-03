import { defineConfig } from 'wxt';
import tailwindcss from '@tailwindcss/vite';
import { fileURLToPath } from 'node:url';

/** E2E builds get access to the local fixture server only, in their own output folder. */
const e2e = process.env.FILLER_E2E === '1';
/**
 * A second E2E build for tab snapshots: captureVisibleTab needs activeTab
 * (granted by clicking the toolbar button, which Playwright cannot do) or
 * <all_urls>. Only this build gets <all_urls>, so the main E2E build still
 * proves the "allow site access" flow.
 */
const capture = e2e && process.env.FILLER_E2E_CAPTURE === '1';

export default defineConfig({
  modules: ['@wxt-dev/module-react'],
  outDir: capture ? '.output-e2e-capture' : e2e ? '.output-e2e' : '.output',
  zip: { artifactTemplate: 'filler-{{version}}-{{browser}}.zip' },
  vite: () => ({
    plugins: [tailwindcss()],
    // The public Supabase values live in the repository root's .env (see README).
    envDir: fileURLToPath(new URL('../..', import.meta.url)),
  }),
  manifest: {
    name: 'Filler',
    description:
      'Fill any form once. Filler remembers, asks once, and drafts the rest. You submit.',
    // No host permissions at install. The page agent is injected on demand:
    // via activeTab after the user invokes Filler on a tab, or via optional
    // site access the user grants from the side panel.
    permissions: ['sidePanel', 'storage', 'activeTab', 'scripting'],
    optional_host_permissions: ['http://*/*', 'https://*/*'],
    ...(e2e
      ? { host_permissions: ['http://127.0.0.1/*', ...(capture ? ['<all_urls>'] : [])] }
      : {}),
    action: { default_title: 'Open Filler' },
    commands: {
      _execute_action: {
        suggested_key: { default: 'Alt+Shift+F' },
        description: 'Open Filler',
      },
      'start-session': {
        suggested_key: { default: 'Alt+Shift+S' },
        description: 'Start filling this page',
      },
    },
  },
});
