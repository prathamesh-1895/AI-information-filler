import { Banner, Button, Card, TextField, Toggle } from '@filler/ui';
import type { SyncResult } from '@filler/vault';
import { Cloud } from 'lucide-react';
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { call } from '@/src/messaging/client';
import type { AuthStatus } from '@/src/cloud/auth';
import type { SyncStatus } from '@/src/cloud/sync-service';
import { usePanel } from '../store';

/** Email-code sign in, shared by Settings and the restore flow. */
export function SignIn({ onSignedIn }: { onSignedIn: (status: AuthStatus) => void }) {
  const [email, setEmail] = useState('');
  const [code, setCode] = useState('');
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const send = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const r = await call({ type: 'AUTH_SEND_CODE', email });
    setBusy(false);
    if (r.ok) setSent(true);
    else setError(r.error.message);
  };

  const verify = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const r = await call<AuthStatus>({ type: 'AUTH_VERIFY', email, code });
    setBusy(false);
    if (r.ok) onSignedIn(r.data);
    else setError(r.error.message);
  };

  return sent ? (
    <form onSubmit={(e) => void verify(e)} className="space-y-2" aria-label="Enter sign-in code">
      <p className="text-sm">We emailed a 6-digit code to {email}.</p>
      <TextField
        label="Code from the email"
        inputMode="numeric"
        autoComplete="one-time-code"
        value={code}
        onChange={(e) => setCode(e.target.value)}
        {...(error ? { error } : {})}
        autoFocus
      />
      <div className="flex gap-2">
        <Button variant="ghost" onClick={() => setSent(false)}>
          Change email
        </Button>
        <Button type="submit" disabled={busy || code.trim().length !== 6}>
          {busy ? 'Signing in…' : 'Sign in'}
        </Button>
      </div>
    </form>
  ) : (
    <form onSubmit={(e) => void send(e)} className="space-y-2" aria-label="Sign in with email">
      <TextField
        label="Email"
        type="email"
        autoComplete="email"
        value={email}
        onChange={(e) => setEmail(e.target.value)}
        hint="No password needed. Your email is only used to sign you in."
        {...(error ? { error } : {})}
      />
      <Button type="submit" disabled={busy || !email.includes('@')}>
        {busy ? 'Sending…' : 'Email me a code'}
      </Button>
    </form>
  );
}

function describe(result: SyncResult | undefined): string {
  if (!result) return 'Not synced yet.';
  switch (result.status) {
    case 'uploaded':
      return 'Your vault is saved to your account.';
    case 'downloaded':
      return 'Updated this device from your account.';
    case 'merged':
      return 'Merged changes from both sides.';
    case 'unchanged':
      return 'Everything is up to date.';
    case 'different-vault':
      return 'Your account holds a different vault.';
  }
}

/** Settings → Account and sync (PLAYBOOK Tasks 7.2–7.3). */
export function AccountCard() {
  const settings = usePanel((s) => s.settings);
  const update = usePanel((s) => s.updateSettings);
  const [auth, setAuth] = useState<AuthStatus | null>(null);
  const [sync, setSync] = useState<SyncStatus | null>(null);
  const [message, setMessage] = useState<{ tone: 'green' | 'red'; text: string } | null>(null);
  const [cloudPass, setCloudPass] = useState('');
  const authChanged = usePanel((s) => s.authChanged);

  const refresh = useCallback(async () => {
    const [a, s] = await Promise.all([
      call<AuthStatus>({ type: 'AUTH_STATUS' }),
      call<SyncStatus>({ type: 'SYNC_STATUS' }),
    ]);
    if (a.ok) setAuth(a.data);
    if (s.ok) setSync(s.data);
  }, []);
  useEffect(() => void refresh(), [refresh]);

  const run = async (message: Parameters<typeof call>[0]) => {
    setMessage(null);
    const r = await call<SyncResult>(message);
    if (r.ok)
      setMessage({
        tone: r.data.status === 'different-vault' ? 'red' : 'green',
        text: describe(r.data),
      });
    else setMessage({ tone: 'red', text: r.error.message });
    await refresh();
  };

  if (!auth) return null;
  return (
    <Card className="space-y-3" data-testid="account-card">
      <div className="flex items-center gap-2">
        <Cloud aria-hidden className="h-4 w-4 text-emerald-700" />
        <h3 className="text-sm font-semibold">Account and sync</h3>
      </div>
      {!auth.configured ? (
        <p className="text-xs text-slate-600 dark:text-slate-400">
          Cloud sync is not set up in this build. Filler works fully on this device.
        </p>
      ) : !auth.signedIn ? (
        <>
          <p className="text-xs text-slate-600 dark:text-slate-400">
            Sign in to keep your vault on more than one device. It is end-to-end encrypted: only
            your passphrase opens it.
          </p>
          <SignIn onSignedIn={() => void refresh().then(authChanged)} />
        </>
      ) : (
        <>
          <div className="flex items-center justify-between gap-2">
            <p className="min-w-0 truncate text-sm" data-testid="signed-in-as">
              Signed in as {auth.email}
            </p>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => void call({ type: 'AUTH_SIGN_OUT' }).then(refresh).then(authChanged)}
            >
              Sign out
            </Button>
          </div>
          <Toggle
            label="Sync my vault"
            description="Encrypted on this device before upload. The server never sees your details or your passphrase."
            checked={settings.cloudSync}
            onChange={(v) => void update({ cloudSync: v })}
          />
          <div className="flex items-center justify-between gap-2">
            <p
              className="text-xs text-slate-600 dark:text-slate-400"
              data-testid="sync-status"
              aria-live="polite"
            >
              {sync?.syncing ? 'Syncing…' : describe(sync?.last)}
              {sync?.lastAt ? ` (${new Date(sync.lastAt).toLocaleTimeString()})` : ''}
            </p>
            <Button
              size="sm"
              variant="secondary"
              disabled={sync?.syncing}
              onClick={() => void run({ type: 'SYNC_NOW' })}
            >
              Sync now
            </Button>
          </div>
          {message && (
            <Banner tone={message.tone} role={message.tone === 'red' ? 'alert' : 'status'}>
              {message.text}
            </Banner>
          )}
          {sync?.last &&
            sync.last.status !== 'different-vault' &&
            sync.last.conflicts.length > 0 && (
              <Banner tone="amber">
                {sync.last.conflicts.length} detail(s) changed on two devices. Filler kept the newer
                value and saved the other as “Conflict …” in My details.
              </Banner>
            )}
          {sync?.last?.status === 'different-vault' && (
            <div className="space-y-2 rounded-md border border-red-300 p-2 text-sm dark:border-red-800">
              <p>
                Your account has a vault made with a different passphrase. Choose which one to keep:
              </p>
              <TextField
                label="Passphrase of the vault in your account"
                type="password"
                value={cloudPass}
                onChange={(e) => setCloudPass(e.target.value)}
              />
              <div className="flex flex-wrap gap-2">
                <Button
                  size="sm"
                  disabled={!cloudPass}
                  onClick={() => void run({ type: 'SYNC_USE_CLOUD', passphrase: cloudPass })}
                >
                  Use the account’s vault here
                </Button>
                <Button
                  size="sm"
                  variant="danger"
                  onClick={() => void run({ type: 'SYNC_REPLACE_CLOUD' })}
                >
                  Replace it with this device’s vault
                </Button>
              </div>
            </div>
          )}
        </>
      )}
    </Card>
  );
}

/** First run on a new device: sign in and unlock the vault from the account. */
export function RestoreFromAccount({ onCancel }: { onCancel: () => void }) {
  const refreshVault = usePanel((s) => s.refreshVault);
  const [signedIn, setSignedIn] = useState(false);
  const [passphrase, setPassphrase] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const restore = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const r = await call({ type: 'SYNC_USE_CLOUD', passphrase });
    setBusy(false);
    if (r.ok) await refreshVault();
    else setError(r.error.message);
  };

  return (
    <section className="space-y-3" aria-labelledby="restore-title">
      <h2 id="restore-title" className="text-lg font-semibold">
        Restore your vault
      </h2>
      {!signedIn ? (
        <SignIn onSignedIn={() => setSignedIn(true)} />
      ) : (
        <form onSubmit={(e) => void restore(e)} className="space-y-2">
          <TextField
            label="Your vault passphrase"
            type="password"
            autoComplete="current-password"
            value={passphrase}
            onChange={(e) => setPassphrase(e.target.value)}
            {...(error ? { error } : {})}
            autoFocus
          />
          <Button type="submit" className="w-full" disabled={busy || !passphrase}>
            {busy ? 'Restoring…' : 'Restore'}
          </Button>
        </form>
      )}
      <Button variant="ghost" className="w-full" onClick={onCancel}>
        Back
      </Button>
    </section>
  );
}
