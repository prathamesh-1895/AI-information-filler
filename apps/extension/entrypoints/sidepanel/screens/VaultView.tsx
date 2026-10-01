import {
  customKeyFor,
  DENIED_CATEGORIES,
  getKeyDef,
  KEY_REGISTRY,
  LIST_GROUPS,
  parseKey,
  SENSITIVITIES,
  type Fact,
  type FactValue,
  type ListGroup,
  type Sensitivity,
} from '@filler/core';
import { Badge, Banner, Button, Card, TextField } from '@filler/ui';
import { ArrowUp, Download, Eye, EyeOff, Lock, Plus, Trash2, Upload } from 'lucide-react';
import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react';
import { call } from '@/src/messaging/client';
import { asText, keyLabel, mask } from '../format';
import { usePanel } from '../store';
import { ImportCard } from './Import';

const GROUP_TITLES: Record<string, string> = {
  person: 'About you',
  family: 'Family',
  contact: 'Contact',
  address: 'Address',
  education: 'Education',
  experience: 'Work experience',
  projects: 'Projects',
  skills: 'Skills',
  languages: 'Languages',
  links: 'Links',
  preferences: 'Work preferences',
  bio: 'Bio',
  professional: 'Professional',
  certifications: 'Certifications',
  custom: 'Other details (learned from forms)',
};
const SCALAR_ORDER = [
  'person',
  'family',
  'contact',
  'address',
  'skills',
  'links',
  'preferences',
  'bio',
  'professional',
  'custom',
];
const LIST_ORDER: ListGroup[] = [
  'education',
  'experience',
  'projects',
  'languages',
  'certifications',
];
const ITEM_NOUN: Record<ListGroup, string> = {
  education: 'education',
  experience: 'job',
  projects: 'project',
  languages: 'language',
  certifications: 'certification',
};
const RANK: Record<Sensitivity, number> = { public: 0, personal: 1, restricted: 2 };
const SENS_TONE = { public: 'neutral', personal: 'violet', restricted: 'red' } as const;

const DENY_NAMES: Record<string, string> = {
  password: 'Passwords',
  otp: 'One-time and verification codes',
  card_number: 'Card numbers',
  card_security_code: 'Card security codes (CVV/CVC)',
  card_expiry: 'Card expiry dates',
  bank_account: 'Bank account details (account no., IFSC, IBAN)',
  upi_pin: 'UPI and ATM PINs',
  passport: 'Passport details',
  aadhaar: 'Aadhaar numbers',
  pan: 'PAN numbers',
  ssn: 'Social Security numbers',
  government_id: 'Other government IDs (voter ID, driving licence…)',
  security_question: 'Security questions and answers',
  captcha: 'CAPTCHAs',
};

/** The vault manager (PLAYBOOK Task 6.2). */
export function VaultView() {
  const [facts, setFacts] = useState<Fact[]>([]);
  const [query, setQuery] = useState('');
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    const result = await call<Fact[]>({ type: 'FACT_LIST' });
    if (result.ok) setFacts(result.data);
    else setError(result.error.message);
  }, []);
  useEffect(() => void reload(), [reload]);

  const run = async (message: Parameters<typeof call>[0]) => {
    setError(null);
    const result = await call(message);
    if (!result.ok) setError(result.error.message);
    await reload();
    return result.ok;
  };

  const q = query.trim().toLowerCase();
  const matches = (f: Fact) =>
    !q || keyLabel(f.key).toLowerCase().includes(q) || asText(f.value).toLowerCase().includes(q);
  const scalar = facts.filter((f) => !f.key.includes('[') && matches(f));
  const listFacts = facts.filter((f) => f.key.includes('['));

  return (
    <div className="space-y-4">
      <ImportCard onSaved={() => void reload()} />
      <TextField
        label="Search your details"
        type="search"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder="e.g. phone, Pune, LinkedIn"
      />
      {error && (
        <Banner tone="red" role="alert">
          {error}
        </Banner>
      )}
      <AddDetail
        onSave={(key, value, sensitivity) => run({ type: 'FACT_SET', key, value, sensitivity })}
      />

      {facts.length === 0 && (
        <p className="text-sm text-slate-600 dark:text-slate-400">
          Nothing saved yet. Add details above, or answer Filler's questions while filling.
        </p>
      )}

      {SCALAR_ORDER.map((group) => {
        const rows = scalar.filter(
          (f) =>
            parseKey(f.key)?.group === group || (group === 'custom' && f.key.startsWith('custom.')),
        );
        if (!rows.length) return null;
        return (
          <section key={group} aria-labelledby={`g-${group}`} className="space-y-1.5">
            <h3 id={`g-${group}`} className="text-sm font-semibold">
              {GROUP_TITLES[group]}
            </h3>
            <ul className="space-y-1.5">
              {rows.map((f) => (
                <FactRow
                  key={f.key}
                  fact={f}
                  onSave={(value) =>
                    run({ type: 'FACT_SET', key: f.key, value, sensitivity: f.sensitivity })
                  }
                  onDelete={() => run({ type: 'FACT_DELETE', key: f.key })}
                />
              ))}
            </ul>
          </section>
        );
      })}

      {LIST_ORDER.map((group) => (
        <ListSection key={group} group={group} facts={listFacts} query={q} run={run} />
      ))}

      <DenyList />
      <Backup onChanged={reload} />
    </div>
  );
}

// ------------------------------------------------------------ add detail

function AddDetail({
  onSave,
}: {
  onSave: (key: string, value: FactValue, sensitivity: Sensitivity) => Promise<boolean>;
}) {
  const [open, setOpen] = useState(false);
  const [key, setKey] = useState('');
  const [customLabel, setCustomLabel] = useState('');
  const [value, setValue] = useState('');
  const [sensitivity, setSensitivity] = useState<Sensitivity>('public');
  const def = key && key !== '__custom' ? getKeyDef(key) : undefined;
  const floor = def?.sensitivity ?? 'public';
  const scalarKeys = KEY_REGISTRY.filter((d) => !d.key.includes('[]'));

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const finalKey = key === '__custom' ? customKeyFor(customLabel) : key;
    if (!finalKey || !value.trim()) return;
    const v: FactValue =
      def?.valueType === 'list'
        ? value
            .split(',')
            .map((s) => s.trim())
            .filter(Boolean)
        : value.trim();
    const effective = RANK[sensitivity] < RANK[floor] ? floor : sensitivity;
    if (await onSave(finalKey, v, effective)) {
      setValue('');
      setKey('');
      setCustomLabel('');
      setOpen(false);
    }
  };

  if (!open) {
    return (
      <Button variant="secondary" className="w-full" onClick={() => setOpen(true)}>
        <Plus aria-hidden className="h-4 w-4" />
        Add a detail
      </Button>
    );
  }
  return (
    <Card>
      <form onSubmit={(e) => void submit(e)} className="space-y-2" aria-label="Add a detail">
        <div className="space-y-1">
          <label htmlFor="add-key" className="block text-xs font-medium">
            What is it?
          </label>
          <select
            id="add-key"
            value={key}
            onChange={(e) => {
              setKey(e.target.value);
              setSensitivity(getKeyDef(e.target.value)?.sensitivity ?? 'public');
            }}
            className="w-full rounded-md border border-slate-300 bg-white px-2 py-1.5 text-sm dark:border-slate-700 dark:bg-slate-950"
          >
            <option value="">Choose…</option>
            {SCALAR_ORDER.filter((g) => g !== 'custom').map((group) => (
              <optgroup key={group} label={GROUP_TITLES[group]}>
                {scalarKeys
                  .filter((d) => d.group === group)
                  .map((d) => (
                    <option key={d.key} value={d.key}>
                      {d.label}
                    </option>
                  ))}
              </optgroup>
            ))}
            <option value="__custom">Something else…</option>
          </select>
        </div>
        {key === '__custom' && (
          <TextField
            label="Name of the detail"
            value={customLabel}
            onChange={(e) => setCustomLabel(e.target.value)}
            placeholder="e.g. Team name"
          />
        )}
        <TextField
          label="Value"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          {...(def?.valueType === 'list'
            ? { hint: 'Separate items with commas.' }
            : def?.examples[0]
              ? { placeholder: def.examples[0] }
              : {})}
        />
        <div className="space-y-1">
          <label htmlFor="add-sens" className="block text-xs font-medium">
            Privacy
          </label>
          <select
            id="add-sens"
            value={sensitivity}
            onChange={(e) => setSensitivity(e.target.value as Sensitivity)}
            className="w-full rounded-md border border-slate-300 bg-white px-2 py-1.5 text-sm dark:border-slate-700 dark:bg-slate-950"
          >
            {SENSITIVITIES.filter((s) => RANK[s] >= RANK[floor]).map((s) => (
              <option key={s} value={s}>
                {s === 'public'
                  ? 'Public'
                  : s === 'personal'
                    ? 'Personal (hidden on screen)'
                    : 'Restricted (never sent to AI)'}
              </option>
            ))}
          </select>
        </div>
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={() => setOpen(false)}>
            Cancel
          </Button>
          <Button
            type="submit"
            disabled={!key || !value.trim() || (key === '__custom' && !customLabel.trim())}
          >
            Save
          </Button>
        </div>
      </form>
    </Card>
  );
}

// -------------------------------------------------------------- fact row

function FactRow({
  fact,
  onSave,
  onDelete,
}: {
  fact: Fact;
  onSave: (v: FactValue) => Promise<boolean>;
  onDelete: () => Promise<boolean>;
}) {
  const hidden = fact.sensitivity !== 'public';
  const [revealed, setRevealed] = useState(!hidden);
  const [editing, setEditing] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [draft, setDraft] = useState(asText(fact.value));
  const label = keyLabel(fact.key);
  const text = asText(fact.value);

  return (
    <li
      className="rounded-md border border-slate-200 p-2 text-sm dark:border-slate-800"
      data-testid="fact-row"
    >
      <div className="flex items-start justify-between gap-2">
        <span className="font-medium" data-testid="fact-label">
          {label}
        </span>
        <Badge tone={SENS_TONE[fact.sensitivity]}>
          {fact.sensitivity === 'public'
            ? 'Public'
            : fact.sensitivity === 'personal'
              ? 'Personal'
              : 'Restricted'}
        </Badge>
      </div>
      {editing ? (
        <form
          className="mt-1 space-y-1.5"
          onSubmit={(e) => {
            e.preventDefault();
            const v: FactValue = Array.isArray(fact.value)
              ? draft
                  .split(',')
                  .map((s) => s.trim())
                  .filter(Boolean)
              : draft.trim();
            void onSave(v).then((ok) => ok && setEditing(false));
          }}
        >
          <TextField
            label={`New value for ${label}`}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            autoFocus
          />
          <div className="flex justify-end gap-1.5">
            <Button size="sm" variant="ghost" onClick={() => setEditing(false)}>
              Cancel
            </Button>
            <Button size="sm" type="submit">
              Save
            </Button>
          </div>
        </form>
      ) : (
        <div className="mt-0.5 flex items-start justify-between gap-2">
          <p className="min-w-0 break-words" data-testid="fact-value">
            {revealed ? text : mask(text)}
          </p>
          {hidden && (
            <button
              type="button"
              onClick={() => setRevealed((r) => !r)}
              aria-label={revealed ? `Hide ${label}` : `Show ${label}`}
              className="shrink-0 text-slate-500"
            >
              {revealed ? (
                <EyeOff aria-hidden className="h-4 w-4" />
              ) : (
                <Eye aria-hidden className="h-4 w-4" />
              )}
            </button>
          )}
        </div>
      )}
      {fact.learnedOn && (
        <p className="text-xs text-slate-500 dark:text-slate-400">Learned on {fact.learnedOn}</p>
      )}
      {!editing && (
        <div className="mt-1 flex justify-end gap-1">
          <Button
            size="sm"
            variant="ghost"
            onClick={() => setEditing(true)}
            aria-label={`Edit ${label}`}
          >
            Edit
          </Button>
          {confirming ? (
            <Button size="sm" variant="danger" onClick={() => void onDelete()}>
              Confirm delete
            </Button>
          ) : (
            <Button
              size="sm"
              variant="ghost"
              onClick={() => setConfirming(true)}
              aria-label={`Delete ${label}`}
            >
              <Trash2 aria-hidden className="h-3.5 w-3.5" />
              Delete
            </Button>
          )}
        </div>
      )}
    </li>
  );
}

// ---------------------------------------------------- repeating sections

type Item = Record<string, string>;

function itemsOf(group: ListGroup, facts: Fact[]): Item[] {
  const items: Item[] = [];
  for (const f of facts) {
    const parsed = parseKey(f.key);
    if (parsed?.group !== group || parsed.index === undefined) continue;
    const field = f.key.slice(f.key.indexOf('].') + 2);
    items[parsed.index] ??= {};
    items[parsed.index]![field] = asText(f.value);
  }
  return items.filter(Boolean);
}

function ListSection({
  group,
  facts,
  query,
  run,
}: {
  group: ListGroup;
  facts: Fact[];
  query: string;
  run: (m: Parameters<typeof call>[0]) => Promise<boolean>;
}) {
  const saved = useMemo(() => itemsOf(group, facts), [group, facts]);
  const [adding, setAdding] = useState(false);
  const fields = LIST_GROUPS[group];
  const existingKeys = facts.filter((f) => parseKey(f.key)?.group === group).map((f) => f.key);
  const visible = saved.filter(
    (item) => !query || Object.values(item).some((v) => v.toLowerCase().includes(query)),
  );
  if (!saved.length && !adding && query) return null;

  /** Rewrites the whole group so indexes stay 0..n-1 (no gaps the mapper would trip on). */
  const rewrite = (items: Item[]) =>
    run({
      type: 'FACT_BATCH',
      remove: existingKeys,
      set: items.flatMap((item, i) =>
        fields.flatMap((field) => {
          const raw = item[field]?.trim();
          if (!raw) return [];
          const def = getKeyDef(`${group}[].${field}`);
          return [
            {
              key: `${group}[${i}].${field}`,
              value:
                def?.valueType === 'list'
                  ? raw
                      .split(',')
                      .map((s) => s.trim())
                      .filter(Boolean)
                  : raw,
            },
          ];
        }),
      ),
    });

  const noun = ITEM_NOUN[group];
  return (
    <section aria-labelledby={`l-${group}`} className="space-y-1.5">
      <div className="flex items-center justify-between">
        <h3 id={`l-${group}`} className="text-sm font-semibold">
          {GROUP_TITLES[group]}
        </h3>
        <Button size="sm" variant="ghost" onClick={() => setAdding(true)}>
          <Plus aria-hidden className="h-3.5 w-3.5" />
          Add {noun}
        </Button>
      </div>
      {visible.map((item) => {
        const index = saved.indexOf(item);
        return (
          <ItemCard
            key={`${group}-${index}-${JSON.stringify(item)}`}
            title={`${noun[0]!.toUpperCase()}${noun.slice(1)} ${index + 1}`}
            group={group}
            item={item}
            onSave={(next) => rewrite(saved.map((it, i) => (i === index ? next : it)))}
            onDelete={() => rewrite(saved.filter((_, i) => i !== index))}
            {...(index > 0
              ? {
                  onMoveUp: () => {
                    const copy = [...saved];
                    [copy[index - 1], copy[index]] = [copy[index]!, copy[index - 1]!];
                    return rewrite(copy);
                  },
                }
              : {})}
          />
        );
      })}
      {adding && (
        <ItemCard
          title={`New ${noun}`}
          group={group}
          item={{}}
          startEditing
          onSave={async (next) => {
            const ok = await rewrite([...saved, next]);
            if (ok) setAdding(false);
            return ok;
          }}
          onCancel={() => setAdding(false)}
        />
      )}
    </section>
  );
}

function ItemCard({
  title,
  group,
  item,
  startEditing = false,
  onSave,
  onDelete,
  onMoveUp,
  onCancel,
}: {
  title: string;
  group: ListGroup;
  item: Item;
  startEditing?: boolean;
  onSave: (item: Item) => Promise<boolean>;
  onDelete?: () => Promise<boolean>;
  onMoveUp?: () => Promise<boolean>;
  onCancel?: () => void;
}) {
  const [editing, setEditing] = useState(startEditing);
  const [draft, setDraft] = useState<Item>(item);
  const fields = LIST_GROUPS[group];
  const summary = fields
    .map((f) => item[f])
    .filter(Boolean)
    .slice(0, 2)
    .join(' · ');

  return (
    <Card data-testid={`item-${group}`} className="space-y-2">
      <div className="flex items-start justify-between gap-2">
        <p className="text-sm font-medium">{title}</p>
        {!editing && (
          <div className="flex gap-1">
            {onMoveUp && (
              <Button
                size="sm"
                variant="ghost"
                onClick={() => void onMoveUp()}
                aria-label={`Move ${title} up`}
              >
                <ArrowUp aria-hidden className="h-3.5 w-3.5" />
              </Button>
            )}
            <Button
              size="sm"
              variant="ghost"
              onClick={() => setEditing(true)}
              aria-label={`Edit ${title}`}
            >
              Edit
            </Button>
            {onDelete && (
              <Button
                size="sm"
                variant="ghost"
                onClick={() => void onDelete()}
                aria-label={`Delete ${title}`}
              >
                <Trash2 aria-hidden className="h-3.5 w-3.5" />
              </Button>
            )}
          </div>
        )}
      </div>
      {editing ? (
        <form
          className="space-y-2"
          onSubmit={(e) => {
            e.preventDefault();
            void onSave(draft).then((ok) => ok && setEditing(false));
          }}
        >
          {fields.map((f) => (
            <TextField
              key={f}
              label={getKeyDef(`${group}[].${f}`)?.label ?? f}
              value={draft[f] ?? ''}
              onChange={(e) => setDraft((d) => ({ ...d, [f]: e.target.value }))}
            />
          ))}
          <div className="flex justify-end gap-1.5">
            <Button
              size="sm"
              variant="ghost"
              onClick={() => (onCancel ? onCancel() : setEditing(false))}
            >
              Cancel
            </Button>
            <Button size="sm" type="submit">
              Save
            </Button>
          </div>
        </form>
      ) : (
        <p className="text-xs text-slate-600 dark:text-slate-400">{summary || 'Empty'}</p>
      )}
    </Card>
  );
}

// ------------------------------------------------------------- deny list

function DenyList() {
  const settings = usePanel((s) => s.settings);
  const updateSettings = usePanel((s) => s.updateSettings);
  const [phrase, setPhrase] = useState('');
  const add = (e: FormEvent) => {
    e.preventDefault();
    const p = phrase.trim();
    if (!p) return;
    void updateSettings({ denyPatterns: [...settings.denyPatterns, p] });
    setPhrase('');
  };
  return (
    <section aria-labelledby="deny-title" className="space-y-2">
      <h3 id="deny-title" className="text-sm font-semibold">
        Never filled
      </h3>
      <p className="text-xs text-slate-600 dark:text-slate-400">
        Filler never stores or fills these. The built-in list cannot be turned off.
      </p>
      <ul className="space-y-1" data-testid="deny-builtin">
        {DENIED_CATEGORIES.filter((c) => c !== 'user_rule').map((c) => (
          <li key={c} className="flex items-center gap-1.5 text-xs">
            <Lock aria-hidden className="h-3 w-3 text-slate-500" />
            {DENY_NAMES[c] ?? c}
            <span className="sr-only">(built in, cannot be removed)</span>
          </li>
        ))}
      </ul>
      {settings.denyPatterns.length > 0 && (
        <ul className="space-y-1" data-testid="deny-user">
          {settings.denyPatterns.map((p) => (
            <li key={p} className="flex items-center justify-between gap-2 text-xs">
              <span>{p}</span>
              <Button
                size="sm"
                variant="ghost"
                onClick={() =>
                  void updateSettings({
                    denyPatterns: settings.denyPatterns.filter((x) => x !== p),
                  })
                }
                aria-label={`Remove ${p}`}
              >
                Remove
              </Button>
            </li>
          ))}
        </ul>
      )}
      <form onSubmit={add} className="flex items-end gap-2">
        <TextField
          className="flex-1"
          label="Also never fill fields about…"
          value={phrase}
          onChange={(e) => setPhrase(e.target.value)}
          placeholder="e.g. blood group"
        />
        <Button type="submit" variant="secondary" disabled={!phrase.trim()}>
          Add
        </Button>
      </form>
    </section>
  );
}

// ---------------------------------------------------------------- backup

function Backup({ onChanged }: { onChanged: () => Promise<void> }) {
  const refreshVault = usePanel((s) => s.refreshVault);
  const [message, setMessage] = useState<{ tone: 'green' | 'red'; text: string } | null>(null);
  const [importJson, setImportJson] = useState<string | null>(null);
  const [importPass, setImportPass] = useState('');
  const [wipeText, setWipeText] = useState('');

  const exportBackup = async () => {
    const result = await call<{ json: string; filename: string }>({ type: 'VAULT_EXPORT' });
    if (!result.ok) return setMessage({ tone: 'red', text: result.error.message });
    const url = URL.createObjectURL(new Blob([result.data.json], { type: 'application/json' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = result.data.filename;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
    setMessage({
      tone: 'green',
      text: 'Encrypted backup downloaded. It only opens with your passphrase.',
    });
  };

  const doImport = async (e: FormEvent) => {
    e.preventDefault();
    if (!importJson) return;
    const result = await call({ type: 'VAULT_IMPORT', json: importJson, passphrase: importPass });
    if (!result.ok) return setMessage({ tone: 'red', text: result.error.message });
    setImportJson(null);
    setImportPass('');
    setMessage({
      tone: 'green',
      text: 'Backup restored. Your vault now uses the backup’s passphrase.',
    });
    await onChanged();
  };

  const wipe = async () => {
    const result = await call({ type: 'VAULT_WIPE', confirm: 'DELETE' });
    if (!result.ok) return setMessage({ tone: 'red', text: result.error.message });
    await refreshVault();
  };

  return (
    <section
      aria-labelledby="backup-title"
      className="space-y-2 border-t border-slate-200 pt-3 dark:border-slate-800"
    >
      <h3 id="backup-title" className="text-sm font-semibold">
        Backup and reset
      </h3>
      {message && (
        <Banner tone={message.tone} role={message.tone === 'red' ? 'alert' : 'status'}>
          {message.text}
        </Banner>
      )}
      <div className="flex flex-wrap gap-2">
        <Button variant="secondary" onClick={() => void exportBackup()}>
          <Download aria-hidden className="h-4 w-4" />
          Export backup
        </Button>
        <label className="inline-flex cursor-pointer items-center gap-1.5 rounded-md border border-slate-300 px-3 py-2 text-sm font-medium focus-within:outline-2 focus-within:outline-emerald-600 dark:border-slate-700">
          <Upload aria-hidden className="h-4 w-4" />
          Import backup
          <input
            type="file"
            accept=".filler,application/json"
            className="sr-only"
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) void file.text().then(setImportJson);
            }}
          />
        </label>
      </div>
      {importJson && (
        <form onSubmit={(e) => void doImport(e)} className="space-y-2">
          <Banner tone="amber">Importing replaces everything in your vault with the backup.</Banner>
          <TextField
            label="Backup passphrase"
            type="password"
            value={importPass}
            onChange={(e) => setImportPass(e.target.value)}
            autoFocus
          />
          <Button type="submit" disabled={!importPass}>
            Restore backup
          </Button>
        </form>
      )}
      <details className="text-sm">
        <summary className="cursor-pointer text-red-700 dark:text-red-400">
          Delete everything
        </summary>
        <div className="mt-2 space-y-2">
          <p className="text-xs">
            This permanently deletes your vault from this device. Type DELETE to confirm.
          </p>
          <TextField
            label="Type DELETE"
            value={wipeText}
            onChange={(e) => setWipeText(e.target.value)}
          />
          <Button variant="danger" disabled={wipeText !== 'DELETE'} onClick={() => void wipe()}>
            Delete my vault
          </Button>
        </div>
      </details>
    </section>
  );
}
