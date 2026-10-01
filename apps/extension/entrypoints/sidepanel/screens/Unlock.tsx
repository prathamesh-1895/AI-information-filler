import { Button, TextField } from '@filler/ui';
import { Lock } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { call } from '@/src/messaging/client';
import { usePanel } from '../store';

/** Shown whenever the vault is locked (PLAYBOOK Task 6.1). Nothing else is reachable until it unlocks. */
export function Unlock() {
  const refreshVault = usePanel((s) => s.refreshVault);
  const [passphrase, setPassphrase] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!passphrase) return;
    setBusy(true);
    setError(null);
    const result = await call({ type: 'VAULT_UNLOCK', passphrase });
    setBusy(false);
    if (result.ok) {
      setPassphrase('');
      await refreshVault();
    } else {
      setError(result.error.message);
    }
  };

  return (
    <form onSubmit={(e) => void submit(e)} className="space-y-4" aria-labelledby="unlock-title">
      <div className="flex items-center gap-2">
        <Lock aria-hidden className="h-5 w-5 text-emerald-700" />
        <h2 id="unlock-title" className="text-lg font-semibold">
          Unlock your vault
        </h2>
      </div>
      <p className="text-sm text-slate-600 dark:text-slate-400">
        Your saved details are locked. Enter your passphrase to use them.
      </p>
      <TextField
        label="Passphrase"
        type="password"
        autoComplete="current-password"
        value={passphrase}
        onChange={(e) => setPassphrase(e.target.value)}
        autoFocus
        {...(error ? { error } : {})}
      />
      <Button type="submit" className="w-full" disabled={busy || !passphrase}>
        {busy ? 'Unlocking…' : 'Unlock'}
      </Button>
    </form>
  );
}
