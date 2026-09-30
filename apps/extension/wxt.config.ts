import { defineConfig } from 'wxt';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  modules: ['@wxt-dev/module-react'],
  vite: () => ({
    plugins: [tailwindcss()],
  }),
  manifest: {
    name: 'Filler',
    description:
      'Fill any form once. Filler remembers, asks once, and drafts the rest. You submit.',
    // No host permissions at install: the page agent is injected on demand
    // into the active tab (activeTab + scripting) when the user starts a session.
    permissions: ['sidePanel', 'storage', 'activeTab', 'scripting'],
    action: { default_title: 'Open Filler' },
  },
});
