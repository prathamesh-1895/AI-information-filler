import { Button, Spinner } from '@filler/ui';
import { Lock } from 'lucide-react';
import { useEffect, type KeyboardEvent } from 'react';
import { call, keepAlive } from '@/src/messaging/client';
import { APP_NAME } from '@/src/app-info';
import { FillView } from './screens/FillView';
import { Onboarding } from './screens/Onboarding';
import { ScreenView, SharingIndicator } from './screens/ScreenView';
import { SettingsView } from './screens/SettingsView';
import { Unlock } from './screens/Unlock';
import { VaultView } from './screens/VaultView';
import { usePanel, type View } from './store';

const TABS: Array<{ id: View; label: string }> = [
  { id: 'fill', label: 'Fill' },
  { id: 'screen', label: 'Screen' },
  { id: 'vault', label: 'My details' },
  { id: 'settings', label: 'Settings' },
];

export function App() {
  const vault = usePanel((s) => s.vault);
  const view = usePanel((s) => s.view);
  const setView = usePanel((s) => s.setView);
  const theme = usePanel((s) => s.settings.theme);
  const refreshVault = usePanel((s) => s.refreshVault);
  const refreshTarget = usePanel((s) => s.refreshTarget);
  const loadSettings = usePanel((s) => s.loadSettings);

  useEffect(() => {
    const stop = keepAlive();
    void refreshVault();
    void loadSettings();
    void refreshTarget();
    const onTab = () => void refreshTarget();
    browser.tabs.onActivated.addListener(onTab);
    browser.tabs.onUpdated.addListener(onTab);
    // The vault can lock in the background (auto-lock); re-check when the panel regains focus.
    const onFocus = () => void refreshVault();
    window.addEventListener('focus', onFocus);
    const poll = setInterval(() => void refreshVault(), 30_000);
    return () => {
      stop();
      browser.tabs.onActivated.removeListener(onTab);
      browser.tabs.onUpdated.removeListener(onTab);
      window.removeEventListener('focus', onFocus);
      clearInterval(poll);
    };
  }, [refreshVault, refreshTarget, loadSettings]);

  // Theme: explicit choice, or follow the system.
  useEffect(() => {
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    const apply = () =>
      document.documentElement.classList.toggle(
        'dark',
        theme === 'dark' || (theme === 'system' && media.matches),
      );
    apply();
    media.addEventListener('change', apply);
    return () => media.removeEventListener('change', apply);
  }, [theme]);

  const onTabKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const i = TABS.findIndex((t) => t.id === view);
    const next =
      e.key === 'ArrowRight'
        ? TABS[(i + 1) % TABS.length]
        : e.key === 'ArrowLeft'
          ? TABS[(i + TABS.length - 1) % TABS.length]
          : undefined;
    if (!next) return;
    e.preventDefault();
    setView(next.id);
    document.getElementById(`tab-${next.id}`)?.focus();
  };

  return (
    <div className="min-h-screen bg-white text-slate-900 dark:bg-slate-950 dark:text-slate-100">
      <header className="flex items-center justify-between gap-2 border-b border-slate-200 px-4 py-2.5 dark:border-slate-800">
        <h1 className="text-lg font-semibold">{APP_NAME}</h1>
        <SharingIndicator />
        {vault === 'unlocked' && (
          <Button
            size="sm"
            variant="ghost"
            aria-label="Lock vault"
            onClick={() => void call({ type: 'VAULT_LOCK' }).then(() => refreshVault())}
          >
            <Lock aria-hidden className="h-4 w-4" />
            Lock
          </Button>
        )}
      </header>
      <main className="p-4">
        {vault === 'loading' && <Spinner label="Starting Filler…" />}
        {vault === 'uninitialized' && <Onboarding />}
        {vault === 'locked' && <Unlock />}
        {vault === 'unlocked' && (
          <>
            <div
              role="tablist"
              aria-label="Filler sections"
              className="mb-4 flex gap-1 rounded-lg bg-slate-100 p-1 dark:bg-slate-900"
              onKeyDown={onTabKey}
            >
              {TABS.map((t) => (
                <button
                  key={t.id}
                  id={`tab-${t.id}`}
                  role="tab"
                  type="button"
                  aria-selected={view === t.id}
                  aria-controls={`panel-${t.id}`}
                  tabIndex={view === t.id ? 0 : -1}
                  onClick={() => setView(t.id)}
                  className={`flex-1 rounded-md px-1 py-1.5 text-[13px] font-medium whitespace-nowrap focus-visible:outline-2 focus-visible:outline-emerald-600 ${
                    view === t.id
                      ? 'bg-white shadow-sm dark:bg-slate-800'
                      : 'text-slate-600 dark:text-slate-400'
                  }`}
                >
                  {t.label}
                </button>
              ))}
            </div>
            <section id={`panel-${view}`} role="tabpanel" aria-labelledby={`tab-${view}`}>
              {view === 'fill' && <FillView />}
              {view === 'screen' && <ScreenView />}
              {view === 'vault' && <VaultView />}
              {view === 'settings' && <SettingsView />}
            </section>
          </>
        )}
      </main>
    </div>
  );
}
