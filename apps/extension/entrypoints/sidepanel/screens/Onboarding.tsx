import { Banner, Button, Card, TextField } from '@filler/ui';
import { KeyRound, ShieldCheck, Sparkles } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { call } from '@/src/messaging/client';
import { passphraseStrength } from '../format';
import { usePanel } from '../store';

type Step = 'welcome' | 'passphrase' | 'profile';

const STRENGTH_COLORS = [
  'bg-red-600',
  'bg-orange-500',
  'bg-amber-500',
  'bg-emerald-600',
  'bg-emerald-700',
];

/** First run (PLAYBOOK Task 6.1): welcome → passphrase → optional quick-start profile. */
export function Onboarding() {
  const [step, setStep] = useState<Step>('welcome');
  const refreshVault = usePanel((s) => s.refreshVault);

  if (step === 'welcome') {
    return (
      <section aria-labelledby="welcome-title" className="space-y-4">
        <h2 id="welcome-title" className="text-xl font-semibold">
          Welcome to Filler
        </h2>
        <ul className="space-y-3 text-sm text-slate-700 dark:text-slate-300">
          <li className="flex gap-2">
            <Sparkles aria-hidden className="mt-0.5 h-4 w-4 shrink-0 text-emerald-700" />
            Tell Filler your details once. It fills them into any form and asks only for what it
            does not know.
          </li>
          <li className="flex gap-2">
            <ShieldCheck aria-hidden className="mt-0.5 h-4 w-4 shrink-0 text-emerald-700" />
            Your details are encrypted on this device. Filler never fills passwords, card numbers or
            ID numbers, and never presses Submit.
          </li>
          <li className="flex gap-2">
            <KeyRound aria-hidden className="mt-0.5 h-4 w-4 shrink-0 text-emerald-700" />
            You choose a passphrase that unlocks your details.
          </li>
        </ul>
        <Button className="w-full" onClick={() => setStep('passphrase')}>
          Get started
        </Button>
      </section>
    );
  }

  if (step === 'passphrase') return <CreatePassphrase onDone={() => setStep('profile')} />;
  return <QuickStart onDone={() => void refreshVault()} />;
}

function CreatePassphrase({ onDone }: { onDone: () => void }) {
  const [passphrase, setPassphrase] = useState('');
  const [confirm, setConfirm] = useState('');
  const [understood, setUnderstood] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const strength = passphraseStrength(passphrase);
  const mismatch = confirm.length > 0 && confirm !== passphrase;
  const canSubmit = passphrase.length >= 8 && confirm === passphrase && understood && !busy;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!canSubmit) return;
    setBusy(true);
    setError(null);
    const result = await call({ type: 'VAULT_CREATE', passphrase });
    setBusy(false);
    if (result.ok) onDone();
    else setError(result.error.message);
  };

  return (
    <form onSubmit={(e) => void submit(e)} className="space-y-4" aria-labelledby="create-title">
      <h2 id="create-title" className="text-lg font-semibold">
        Create your passphrase
      </h2>
      <TextField
        label="Passphrase"
        type="password"
        autoComplete="new-password"
        value={passphrase}
        onChange={(e) => setPassphrase(e.target.value)}
        hint="At least 8 characters. A few random words work well."
        autoFocus
      />
      <div aria-live="polite">
        <div className="flex gap-1" aria-hidden>
          {[0, 1, 2, 3].map((i) => (
            <span
              key={i}
              className={`h-1.5 flex-1 rounded ${i < Math.max(1, strength.score) && passphrase ? STRENGTH_COLORS[strength.score] : 'bg-slate-200 dark:bg-slate-800'}`}
            />
          ))}
        </div>
        {passphrase && (
          <p className="mt-1 text-xs text-slate-600 dark:text-slate-400" data-testid="strength">
            Strength: {strength.label}
          </p>
        )}
      </div>
      <TextField
        label="Type it again"
        type="password"
        autoComplete="new-password"
        value={confirm}
        onChange={(e) => setConfirm(e.target.value)}
        {...(mismatch ? { error: 'The two passphrases do not match.' } : {})}
      />
      <Banner tone="amber" role="alert">
        <strong>It cannot be recovered.</strong> Filler cannot reset it for you. If you forget it,
        your saved details are gone (you can keep an encrypted backup).
      </Banner>
      <label className="flex items-start gap-2 text-sm">
        <input
          type="checkbox"
          checked={understood}
          onChange={(e) => setUnderstood(e.target.checked)}
          className="mt-1"
        />
        I understand my passphrase cannot be recovered.
      </label>
      {error && (
        <Banner tone="red" role="alert">
          {error}
        </Banner>
      )}
      <Button type="submit" className="w-full" disabled={!canSubmit}>
        {busy ? 'Creating your vault…' : 'Create vault'}
      </Button>
    </form>
  );
}

const QUICK_FIELDS = [
  { key: 'person.name.full', label: 'Full name', type: 'text', autoComplete: 'name' },
  { key: 'contact.email', label: 'Email', type: 'email', autoComplete: 'email' },
  { key: 'contact.phone.mobile', label: 'Mobile number', type: 'tel', autoComplete: 'tel' },
  { key: 'address.city', label: 'City', type: 'text', autoComplete: 'address-level2' },
  {
    key: 'bio.headline',
    label: 'Headline',
    type: 'text',
    autoComplete: 'off',
    placeholder: 'e.g. Business Consultant for growing SMBs',
  },
  {
    key: 'skills',
    label: 'Skills',
    type: 'text',
    autoComplete: 'off',
    placeholder: 'Comma separated, e.g. Excel, SQL',
  },
] as const;

function QuickStart({ onDone }: { onDone: () => void }) {
  const [values, setValues] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const save = async (e: FormEvent) => {
    e.preventDefault();
    const set = QUICK_FIELDS.flatMap(({ key }) => {
      const raw = values[key]?.trim();
      if (!raw) return [];
      const value =
        key === 'skills'
          ? raw
              .split(',')
              .map((s) => s.trim())
              .filter(Boolean)
          : raw;
      return [{ key, value }];
    });
    if (set.length) {
      setBusy(true);
      const result = await call({ type: 'FACT_BATCH', set, remove: [] });
      setBusy(false);
      if (!result.ok) {
        setError(result.error.message);
        return;
      }
    }
    onDone();
  };

  return (
    <form onSubmit={(e) => void save(e)} className="space-y-3" aria-labelledby="quick-title">
      <h2 id="quick-title" className="text-lg font-semibold">
        A few details to start
      </h2>
      <p className="text-sm text-slate-600 dark:text-slate-400">
        All optional. Filler will also ask for anything it needs while filling.
      </p>
      <Card className="space-y-3">
        {QUICK_FIELDS.map((f) => (
          <TextField
            key={f.key}
            label={f.label}
            type={f.type}
            autoComplete={f.autoComplete}
            {...('placeholder' in f ? { placeholder: f.placeholder } : {})}
            value={values[f.key] ?? ''}
            onChange={(e) => setValues((v) => ({ ...v, [f.key]: e.target.value }))}
          />
        ))}
      </Card>
      {error && (
        <Banner tone="red" role="alert">
          {error}
        </Banner>
      )}
      <div className="flex gap-2">
        <Button variant="secondary" className="flex-1" onClick={onDone}>
          Skip for now
        </Button>
        <Button type="submit" className="flex-1" disabled={busy}>
          {busy ? 'Saving…' : 'Save and continue'}
        </Button>
      </div>
    </form>
  );
}
