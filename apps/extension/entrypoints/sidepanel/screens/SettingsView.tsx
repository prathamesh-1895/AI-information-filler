import { siteOf } from '@filler/core';
import { Banner, Button, Card, Toggle } from '@filler/ui';
import { useState } from 'react';
import { call } from '@/src/messaging/client';
import type { Settings } from '@/src/settings';
import { usePanel } from '../store';
import { AccountCard } from './Account';
import { AiCard } from './AiSettings';

const select =
  'w-full rounded-md border border-slate-300 bg-white px-2 py-1.5 text-sm dark:border-slate-700 dark:bg-slate-950';

/** Settings and site trust (PLAYBOOK Task 6.4). */
export function SettingsView() {
  const settings = usePanel((s) => s.settings);
  const update = usePanel((s) => s.updateSettings);
  const target = usePanel((s) => s.target);
  const refreshVault = usePanel((s) => s.refreshVault);
  const [note, setNote] = useState<string | null>(null);
  const site = target?.url?.startsWith('http') ? siteOf(target.url) : null;
  const trusted = site !== null && settings.trustedSites.includes(site);

  const forgetSite = async () => {
    if (!site) return;
    const result = await call<{ removed: number }>({ type: 'MEMORY_CLEAR_SITE', site });
    setNote(
      result.ok
        ? `Forgot ${result.data.removed} remembered ${result.data.removed === 1 ? 'field' : 'fields'} on ${site}.`
        : result.error.message,
    );
  };

  const lockNow = async () => {
    await call({ type: 'VAULT_LOCK' });
    await refreshVault();
  };

  return (
    <div className="space-y-4">
      {note && <Banner tone="green">{note}</Banner>}

      <AccountCard />

      <AiCard />

      <Card className="space-y-3">
        <h3 className="text-sm font-semibold">Security</h3>
        <div className="space-y-1">
          <label htmlFor="autolock" className="block text-sm font-medium">
            Lock my vault after
          </label>
          <select
            id="autolock"
            className={select}
            value={settings.autoLockMinutes}
            onChange={(e) => void update({ autoLockMinutes: Number(e.target.value) })}
          >
            {[5, 15, 30, 60, 240].map((m) => (
              <option key={m} value={m}>
                {m < 60 ? `${m} minutes` : `${m / 60} hour${m > 60 ? 's' : ''}`} of inactivity
              </option>
            ))}
            <option value={0}>Never (not recommended)</option>
          </select>
        </div>
        <Toggle
          label="Stay unlocked until I close the browser"
          description="Takes effect the next time you unlock. The key is kept in browser memory only, never on disk."
          checked={settings.stayUnlockedForSession}
          onChange={(v) => void update({ stayUnlockedForSession: v })}
        />
        <Button variant="secondary" onClick={() => void lockNow()}>
          Lock now
        </Button>
      </Card>

      <Card className="space-y-3">
        <h3 className="text-sm font-semibold">Filling</h3>
        <div className="space-y-1">
          <label htmlFor="typing" className="block text-sm font-medium">
            How to enter values
          </label>
          <select
            id="typing"
            className={select}
            value={settings.typingMode}
            onChange={(e) => void update({ typingMode: e.target.value as Settings['typingMode'] })}
          >
            <option value="auto">Fast (types key by key only when a site needs it)</option>
            <option value="typing">Always type key by key (slower, for picky sites)</option>
          </select>
        </div>
        <Toggle
          label="Highlight fields on the page"
          checked={settings.highlight}
          onChange={(v) => void update({ highlight: v })}
        />
        <div className="space-y-1">
          <label htmlFor="lang" className="block text-sm font-medium">
            Language for written answers
          </label>
          <select
            id="lang"
            className={select}
            value={settings.answerLanguage}
            onChange={(e) =>
              void update({ answerLanguage: e.target.value as Settings['answerLanguage'] })
            }
          >
            <option>English</option>
            <option>Hindi</option>
            <option>Marathi</option>
          </select>
        </div>
      </Card>

      <Card className="space-y-3">
        <h3 className="text-sm font-semibold">This site{site ? `: ${site}` : ''}</h3>
        {site ? (
          <>
            <Toggle
              label="Trust this site"
              description="Approve values from your vault automatically here. Written (AI) answers always need your approval."
              checked={trusted}
              onChange={(v) =>
                void update({
                  trustedSites: v
                    ? [...settings.trustedSites, site]
                    : settings.trustedSites.filter((s) => s !== site),
                })
              }
            />
            <Button variant="secondary" onClick={() => void forgetSite()}>
              Forget what Filler learned on this site
            </Button>
          </>
        ) : (
          <p className="text-xs text-slate-600 dark:text-slate-400">
            Open a website to change settings for it.
          </p>
        )}
        {settings.trustedSites.length > 0 && (
          <p className="text-xs text-slate-600 dark:text-slate-400" data-testid="trusted-list">
            Trusted: {settings.trustedSites.join(', ')}
          </p>
        )}
      </Card>

      <Card className="space-y-3">
        <h3 className="text-sm font-semibold">Appearance and shortcuts</h3>
        <div className="space-y-1">
          <label htmlFor="theme" className="block text-sm font-medium">
            Theme
          </label>
          <select
            id="theme"
            className={select}
            value={settings.theme}
            onChange={(e) => void update({ theme: e.target.value as Settings['theme'] })}
          >
            <option value="system">Match my system</option>
            <option value="light">Light</option>
            <option value="dark">Dark</option>
          </select>
        </div>
        <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
          <dt>
            <kbd className="rounded border px-1">Alt+Shift+F</kbd>
          </dt>
          <dd>Open Filler</dd>
          <dt>
            <kbd className="rounded border px-1">Alt+Shift+S</kbd>
          </dt>
          <dd>Start filling the current page</dd>
          <dt>
            <kbd className="rounded border px-1">↑ ↓ A E S</kbd>
          </dt>
          <dd>In the review list: move, approve, edit, skip</dd>
        </dl>
        <p className="text-xs text-slate-500 dark:text-slate-400">
          Change shortcuts at chrome://extensions/shortcuts.
        </p>
      </Card>
    </div>
  );
}
