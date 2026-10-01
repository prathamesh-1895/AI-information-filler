import type { FactValue, FieldDescriptor, PlanItem, SessionState, UserEvent } from '@filler/core';
import { Badge, Banner, Button, Card, Spinner, TextArea, TextField } from '@filler/ui';
import { Check, Eye, EyeOff, Pencil, SkipForward, Wand2 } from 'lucide-react';
import { useEffect, useMemo, useRef, useState, type FormEvent, type KeyboardEvent } from 'react';
import { call, onPageEvent, onSessionState, requestSiteAccess } from '@/src/messaging/client';
import { asText, keyLabel, mask, PHASE, sensitivityOf, SOURCE, STATUS } from '../format';
import { AiChip } from '../AiChip';
import { usePanel } from '../store';

const CHOICE_TYPES = new Set([
  'radio',
  'aria-radiogroup',
  'select-one',
  'aria-listbox',
  'aria-combobox',
]);
const MULTI_TYPES = new Set(['checkbox-group', 'aria-checkbox-group', 'select-multiple', 'tags']);
const LONG_TYPES = new Set(['textarea', 'contenteditable', 'aria-textbox']);

/** The session screen (PLAYBOOK Task 6.3). */
export function FillView() {
  const target = usePanel((s) => s.target);
  const session = usePanel((s) => s.session);
  const setSession = usePanel((s) => s.setSession);
  const [focusedId, setFocusedId] = useState<string | null>(null);

  // Load the tab's session, then follow it live.
  useEffect(() => {
    if (!target) return;
    let alive = true;
    void call<SessionState | null>({ type: 'SESSION_GET', tabId: target.tabId }).then((r) => {
      if (alive && r.ok) setSession(r.data);
    });
    const offState = onSessionState(target.tabId, (s) => setSession(s as SessionState));
    const offPage = onPageEvent(target.tabId, (e) => {
      if (e.type === 'FIELD_FOCUSED') {
        setFocusedId(e.id);
        document.getElementById(`item-${e.id}`)?.scrollIntoView({ block: 'nearest' });
      }
    });
    return () => {
      alive = false;
      offState();
      offPage();
    };
  }, [target, setSession]);

  if (!target) return <Banner tone="amber">Open the page with the form you want to fill.</Banner>;
  if (!session || session.phase === 'IDLE' || session.phase === 'ENDED') {
    return (
      <StartPanel
        tabId={target.tabId}
        title={target.title ?? target.url ?? ''}
        ended={session?.endReason}
      />
    );
  }
  return <SessionPanel session={session} focusedId={focusedId} />;
}

// ----------------------------------------------------------------- start

function StartPanel({
  tabId,
  title,
  ended,
}: {
  tabId: number;
  title: string;
  ended?: string | undefined;
}) {
  const setSession = usePanel((s) => s.setSession);
  const [goal, setGoal] = useState('');
  const [role, setRole] = useState('');
  const [tone, setTone] = useState('professional');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const start = async (e?: FormEvent) => {
    e?.preventDefault();
    setBusy(true);
    setError(null);
    const goalValue = goal.trim()
      ? { text: goal.trim(), ...(role.trim() ? { role: role.trim() } : {}), tone }
      : undefined;
    const result = await call<SessionState>({
      type: 'SESSION_START',
      tabId,
      ...(goalValue ? { goal: goalValue } : {}),
    });
    setBusy(false);
    if (result.ok) setSession(result.data);
    else setError(result.error.message);
  };

  return (
    <form onSubmit={(e) => void start(e)} className="space-y-3" aria-labelledby="start-title">
      {ended && <Banner tone="neutral">{ended}</Banner>}
      <div className="flex items-start justify-between gap-2">
        <h2 id="start-title" className="text-base font-semibold">
          Fill this page
        </h2>
        <AiChip />
      </div>
      <p className="truncate text-xs text-slate-500 dark:text-slate-400" data-testid="target">
        Page: {title}
      </p>
      <TextArea
        label="What are we doing? (optional)"
        placeholder="e.g. Create my Upwork profile as a business consultant"
        value={goal}
        onChange={(e) => setGoal(e.target.value)}
        hint="Filler uses this for answers that need judgement."
      />
      <div className="grid grid-cols-2 gap-2">
        <TextField
          label="Role"
          placeholder="Business consultant"
          value={role}
          onChange={(e) => setRole(e.target.value)}
        />
        <div className="space-y-1">
          <label
            htmlFor="tone"
            className="block text-xs font-medium text-slate-700 dark:text-slate-300"
          >
            Tone
          </label>
          <select
            id="tone"
            value={tone}
            onChange={(e) => setTone(e.target.value)}
            className="w-full rounded-md border border-slate-300 bg-white px-2 py-1.5 text-sm dark:border-slate-700 dark:bg-slate-950"
          >
            <option value="professional">Professional</option>
            <option value="friendly">Friendly</option>
            <option value="confident">Confident</option>
          </select>
        </div>
      </div>
      {error && (
        <Banner tone="red" role="alert">
          {error}
        </Banner>
      )}
      <Button type="submit" className="w-full" disabled={busy}>
        <Wand2 aria-hidden className="h-4 w-4" />
        {busy ? 'Reading the page…' : 'Start on this page'}
      </Button>
    </form>
  );
}

// --------------------------------------------------------------- session

function useSend(tabId: number) {
  const setSession = usePanel((s) => s.setSession);
  return async (event: UserEvent) => {
    const result = await call<SessionState>({ type: 'SESSION_EVENT', tabId, event });
    if (result.ok) setSession(result.data);
    return result;
  };
}

function SessionPanel({ session, focusedId }: { session: SessionState; focusedId: string | null }) {
  const send = useSend(session.tabId);
  const setSession = usePanel((s) => s.setSession);
  const fieldById = useMemo(() => new Map(session.fields.map((f) => [f.id, f])), [session.fields]);
  const questions = session.plan.filter(
    (p) => p.question !== undefined && p.value === undefined && p.status === 'pending',
  );
  const review = session.plan.filter((p) => p.value !== undefined && p.status !== 'skipped');
  const notFilled = session.plan.filter((p) => p.status === 'skipped');
  const vaultPending = review.filter(
    (p) => p.status === 'pending' && (p.source === 'vault' || p.source === 'memory'),
  );
  const approved = review.filter((p) => p.status === 'approved' || p.status === 'edited');
  const busy = ['SCANNING', 'MAPPING', 'PLANNING', 'FILLING', 'VERIFYING'].includes(session.phase);

  // "New fields appeared" banner when fields show up after the first plan (wizard step, modal…).
  const seen = useRef<{ session: string; ids: Set<string> }>({ session: '', ids: new Set() });
  const [newFields, setNewFields] = useState(false);
  useEffect(() => {
    if (seen.current.session !== session.id) {
      // Start tracking only once the first plan exists, so the first scan never counts as "new".
      if (session.plan.length === 0) return;
      seen.current = { session: session.id, ids: new Set(session.fields.map((f) => f.id)) };
      setNewFields(false);
      return;
    }
    const fresh = session.fields.some((f) => !seen.current.ids.has(f.id));
    for (const f of session.fields) seen.current.ids.add(f.id);
    if (fresh) setNewFields(true);
  }, [session.id, session.fields]);

  const restart = async () => {
    const result = await call<SessionState>({
      type: 'SESSION_START',
      tabId: session.tabId,
      ...(session.goal ? { goal: session.goal } : {}),
    });
    if (result.ok) setSession(result.data);
  };

  return (
    <div className="space-y-3">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="truncate text-sm font-medium" title={session.title}>
            {session.title || session.site}
          </p>
          <p
            className="text-xs text-slate-600 dark:text-slate-400"
            data-testid="phase"
            aria-live="polite"
          >
            {PHASE[session.phase] ?? session.phase}
          </p>
        </div>
        <AiChip status={session.ai} />
      </div>
      {session.goal && (
        <p className="rounded bg-slate-50 px-2 py-1 text-xs text-slate-700 dark:bg-slate-900 dark:text-slate-300">
          Goal: {session.goal.text}
        </p>
      )}

      {busy && <Spinner label={PHASE[session.phase] ?? 'Working…'} />}
      <ErrorBanner session={session} onRetry={restart} />
      {newFields && session.phase === 'AWAITING_REVIEW' && (
        <Banner
          tone="blue"
          data-testid="next-page"
          action={
            <Button size="sm" variant="ghost" onClick={() => setNewFields(false)}>
              OK
            </Button>
          }
        >
          New fields appeared on the page. They are planned below.
        </Banner>
      )}
      {session.phase === 'READY_TO_SUBMIT' && (
        <Banner tone="green" data-testid="ready">
          <strong>Filler is done.</strong> Review the page and press Submit yourself.
        </Banner>
      )}

      {questions.length > 0 && (
        <section aria-labelledby="questions-title" className="space-y-2">
          <h3 id="questions-title" className="text-sm font-semibold">
            Filler needs you ({questions.length})
          </h3>
          {questions.map((item) => (
            <QuestionCard
              key={item.fieldId}
              item={item}
              field={fieldById.get(item.fieldId)}
              send={send}
              focused={focusedId === item.fieldId}
            />
          ))}
        </section>
      )}

      {review.length > 0 && (
        <section aria-labelledby="review-title" className="space-y-2">
          <div className="flex items-center justify-between gap-2">
            <h3 id="review-title" className="text-sm font-semibold">
              Review ({review.length})
            </h3>
            {vaultPending.length > 0 && (
              <Button
                size="sm"
                variant="secondary"
                onClick={() => void send({ type: 'APPROVE_ALL_VAULT' })}
              >
                <Check aria-hidden className="h-3.5 w-3.5" />
                Approve all from vault ({vaultPending.length})
              </Button>
            )}
          </div>
          <ReviewList items={review} fieldById={fieldById} send={send} focusedId={focusedId} />
        </section>
      )}

      {notFilled.length > 0 && (
        <details
          className="rounded-md border border-slate-200 p-2 text-sm dark:border-slate-800"
          data-testid="not-filled"
        >
          <summary className="cursor-pointer font-medium">
            Not filled by Filler ({notFilled.length})
          </summary>
          <ul className="mt-2 space-y-1.5">
            {notFilled.map((item) => (
              <li key={item.fieldId} className="text-xs" data-testid="not-filled-row">
                <span className="font-medium" data-testid="not-filled-label">
                  {fieldById.get(item.fieldId)?.label ?? item.fieldId}
                </span>
                {item.kind === 'denied' && (
                  <Badge tone="red" className="ml-1">
                    Never filled
                  </Badge>
                )}
                <p className="text-slate-600 dark:text-slate-400">{item.reason}</p>
              </li>
            ))}
          </ul>
        </details>
      )}

      <div className="sticky bottom-0 flex gap-2 border-t border-slate-200 bg-white/95 pt-2 dark:border-slate-800 dark:bg-slate-950/95">
        <Button
          className="flex-1"
          disabled={approved.length === 0 || session.phase !== 'AWAITING_REVIEW'}
          onClick={() => void send({ type: 'FILL' })}
        >
          Fill {approved.length > 0 ? `${approved.length} approved` : 'approved'}
        </Button>
        <Button variant="secondary" onClick={() => void send({ type: 'END' })}>
          End
        </Button>
      </div>
    </div>
  );
}

function ErrorBanner({
  session,
  onRetry,
}: {
  session: SessionState;
  onRetry: () => Promise<void>;
}) {
  const refreshVault = usePanel((s) => s.refreshVault);
  if (session.phase !== 'ERROR' || !session.error) return null;
  const { code, message } = session.error;
  const action =
    code === 'NO_PERMISSION' ? (
      <Button
        size="sm"
        onClick={() =>
          void requestSiteAccess().then((granted) => {
            if (granted) void onRetry();
          })
        }
      >
        Allow access
      </Button>
    ) : code === 'VAULT_LOCKED' ? (
      <Button size="sm" onClick={() => void refreshVault()}>
        Unlock
      </Button>
    ) : (
      <Button size="sm" variant="secondary" onClick={() => void onRetry()}>
        Try again
      </Button>
    );
  return (
    <Banner tone="red" role="alert" action={action}>
      {message}
    </Banner>
  );
}

// ------------------------------------------------------------- questions

function QuestionCard({
  item,
  field,
  send,
  focused,
}: {
  item: PlanItem;
  field: FieldDescriptor | undefined;
  send: (e: UserEvent) => Promise<unknown>;
  focused: boolean;
}) {
  const [value, setValue] = useState<string | string[]>(
    MULTI_TYPES.has(field?.inputType ?? '') ? [] : '',
  );
  const [save, setSave] = useState(true);
  const [busy, setBusy] = useState(false);
  if (!field) return null;
  const options = field.options ?? [];
  const multi = MULTI_TYPES.has(field.inputType) && options.length > 0;
  const single = CHOICE_TYPES.has(field.inputType) && options.length > 0;
  const long = LONG_TYPES.has(field.inputType) || item.kind === 'open_ended';
  const empty = Array.isArray(value) ? value.length === 0 : !value.trim();
  const tooLong =
    field.maxLength !== undefined && !Array.isArray(value) && value.length > field.maxLength;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (empty || tooLong) return;
    setBusy(true);
    const answer: FactValue = Array.isArray(value) ? value : value.trim();
    await send({ type: 'ANSWER', fieldId: item.fieldId, value: answer, save });
    setBusy(false);
  };

  const inputLabel = item.question ?? `What should I put for “${field.label}”?`;
  return (
    <Card
      id={`item-${item.fieldId}`}
      className={focused ? 'ring-2 ring-emerald-600' : ''}
      data-testid="question"
    >
      <form onSubmit={(e) => void submit(e)} className="space-y-2">
        {field.helpText && (
          <p className="text-xs text-slate-600 dark:text-slate-400">{field.helpText}</p>
        )}
        {item.reason && item.reason !== 'Filler does not know this field yet.' && (
          <p className="text-xs text-slate-500 dark:text-slate-400">{item.reason}</p>
        )}
        {single ? (
          <fieldset>
            <legend className="mb-1 text-sm font-medium">{inputLabel}</legend>
            <div className="flex flex-wrap gap-1.5">
              {options.map((o) => (
                <button
                  key={o.value}
                  type="button"
                  aria-pressed={value === o.text}
                  onClick={() => setValue(o.text)}
                  className={`rounded-full border px-2.5 py-1 text-xs focus-visible:outline-2 focus-visible:outline-emerald-600 ${
                    value === o.text
                      ? 'border-emerald-700 bg-emerald-700 text-white'
                      : 'border-slate-300 dark:border-slate-700'
                  }`}
                >
                  {o.text}
                </button>
              ))}
            </div>
          </fieldset>
        ) : multi ? (
          <fieldset>
            <legend className="mb-1 text-sm font-medium">{inputLabel}</legend>
            <div className="flex flex-wrap gap-1.5">
              {options.map((o) => {
                const on = Array.isArray(value) && value.includes(o.text);
                return (
                  <button
                    key={o.value}
                    type="button"
                    aria-pressed={on}
                    onClick={() =>
                      setValue((v) =>
                        Array.isArray(v)
                          ? on
                            ? v.filter((x) => x !== o.text)
                            : [...v, o.text]
                          : [o.text],
                      )
                    }
                    className={`rounded-full border px-2.5 py-1 text-xs focus-visible:outline-2 focus-visible:outline-emerald-600 ${
                      on
                        ? 'border-emerald-700 bg-emerald-700 text-white'
                        : 'border-slate-300 dark:border-slate-700'
                    }`}
                  >
                    {on ? '✓ ' : ''}
                    {o.text}
                  </button>
                );
              })}
            </div>
          </fieldset>
        ) : long ? (
          <TextArea
            label={inputLabel}
            value={value as string}
            onChange={(e) => setValue(e.target.value)}
            {...(field.maxLength
              ? { hint: `${(value as string).length} / ${field.maxLength} characters` }
              : {})}
          />
        ) : (
          <TextField
            label={inputLabel}
            type={
              field.inputType === 'date' ||
              field.inputType === 'month' ||
              field.inputType === 'email' ||
              field.inputType === 'url' ||
              field.inputType === 'number'
                ? field.inputType
                : field.inputType === 'tel'
                  ? 'tel'
                  : 'text'
            }
            value={value as string}
            onChange={(e) => setValue(e.target.value)}
            {...(tooLong
              ? { error: `Too long: this field allows ${field.maxLength} characters.` }
              : {})}
          />
        )}
        <div className="flex flex-wrap items-center justify-between gap-2">
          <label className="flex items-center gap-1.5 text-xs">
            <input type="checkbox" checked={save} onChange={(e) => setSave(e.target.checked)} />
            Save to my vault
          </label>
          <div className="flex gap-1.5">
            <Button
              size="sm"
              variant="ghost"
              onClick={() => void send({ type: 'SKIP', fieldId: item.fieldId })}
            >
              Skip
            </Button>
            <Button size="sm" type="submit" disabled={empty || tooLong || busy}>
              Use this answer
            </Button>
          </div>
        </div>
      </form>
    </Card>
  );
}

// ---------------------------------------------------------------- review

function ReviewList({
  items,
  fieldById,
  send,
  focusedId,
}: {
  items: PlanItem[];
  fieldById: Map<string, FieldDescriptor>;
  send: (e: UserEvent) => Promise<unknown>;
  focusedId: string | null;
}) {
  const listRef = useRef<HTMLUListElement>(null);
  const move = (from: HTMLElement, delta: number) => {
    const rows = Array.from(listRef.current?.querySelectorAll<HTMLElement>('[data-row]') ?? []);
    const next = rows[rows.indexOf(from) + delta];
    next?.focus();
  };
  return (
    <ul
      ref={listRef}
      className="space-y-1.5"
      aria-label="Values Filler will fill. Use arrow keys to move, A to approve, E to edit, S to skip."
    >
      {items.map((item) => (
        <ReviewRow
          key={item.fieldId}
          item={item}
          field={fieldById.get(item.fieldId)}
          send={send}
          focused={item.fieldId === focusedId}
          move={move}
        />
      ))}
    </ul>
  );
}

function ReviewRow({
  item,
  field,
  send,
  focused,
  move,
}: {
  item: PlanItem;
  field: FieldDescriptor | undefined;
  send: (e: UserEvent) => Promise<unknown>;
  focused: boolean;
  move: (from: HTMLElement, delta: number) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(asText(item.value));
  const sensitive = sensitivityOf(item.canonicalKey) !== 'public';
  const [revealed, setRevealed] = useState(!sensitive);
  const text = asText(item.value);
  const source = item.source ? SOURCE[item.source] : null;
  const status = STATUS[item.status];
  const canApprove = item.status === 'pending';
  const canFillOne = item.status === 'approved' || item.status === 'edited';

  const saveEdit = async () => {
    const value: FactValue = Array.isArray(item.value)
      ? draft
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean)
      : draft;
    await send({ type: 'EDIT', fieldId: item.fieldId, value });
    setEditing(false);
  };

  const onKey = (e: KeyboardEvent<HTMLLIElement>) => {
    if (e.target !== e.currentTarget) return;
    if (e.key === 'ArrowDown') move(e.currentTarget, 1);
    else if (e.key === 'ArrowUp') move(e.currentTarget, -1);
    else if (e.key.toLowerCase() === 'a' && canApprove)
      void send({ type: 'APPROVE', fieldIds: [item.fieldId] });
    else if (e.key.toLowerCase() === 's') void send({ type: 'SKIP', fieldId: item.fieldId });
    else if (e.key.toLowerCase() === 'e') setEditing(true);
    else return;
    e.preventDefault();
  };

  return (
    <li
      id={`item-${item.fieldId}`}
      data-row
      data-testid="review-row"
      tabIndex={0}
      onKeyDown={onKey}
      aria-label={`${field?.label ?? 'Field'}: ${revealed ? text : 'hidden value'}. ${status.label}.`}
      className={`rounded-md border border-slate-200 p-2 text-sm focus-visible:outline-2 focus-visible:outline-emerald-600 dark:border-slate-800 ${
        focused ? 'ring-2 ring-emerald-600' : ''
      }`}
    >
      <div className="flex items-start justify-between gap-2">
        <span className="font-medium break-words" data-testid="review-label">
          {field?.label ?? item.fieldId}
        </span>
        <div className="flex flex-wrap justify-end gap-1">
          {source && <Badge tone={source.tone}>{source.label}</Badge>}
          <Badge tone={status.tone} data-testid="review-status">
            {status.label}
          </Badge>
        </div>
      </div>
      {editing ? (
        <div className="mt-1.5 space-y-1.5">
          <TextArea
            label="Edit value"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            autoFocus
          />
          <div className="flex justify-end gap-1.5">
            <Button size="sm" variant="ghost" onClick={() => setEditing(false)}>
              Cancel
            </Button>
            <Button size="sm" onClick={() => void saveEdit()}>
              Save
            </Button>
          </div>
        </div>
      ) : (
        <div className="mt-1 flex items-start justify-between gap-2">
          <p
            className="min-w-0 break-words whitespace-pre-wrap text-slate-800 dark:text-slate-200"
            data-testid="review-value"
          >
            {revealed ? text : mask(text)}
          </p>
          {sensitive && (
            <button
              type="button"
              onClick={() => setRevealed((r) => !r)}
              aria-label={revealed ? 'Hide value' : 'Show value'}
              className="shrink-0 rounded p-0.5 text-slate-500 focus-visible:outline-2 focus-visible:outline-emerald-600"
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
      <p className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">
        {item.status === 'failed' ? (
          <span className="text-red-700 dark:text-red-400">{item.reason}</span>
        ) : (
          item.reason
        )}
        {item.confidence < 1 && item.source !== 'user' && item.status === 'pending'
          ? ` · ${Math.round(item.confidence * 100)}% sure`
          : ''}
      </p>
      {!editing && item.status !== 'filled' && (
        <div className="mt-1.5 flex flex-wrap justify-end gap-1">
          {canApprove && (
            <Button
              size="sm"
              variant="secondary"
              onClick={() => void send({ type: 'APPROVE', fieldIds: [item.fieldId] })}
            >
              <Check aria-hidden className="h-3.5 w-3.5" />
              Approve
            </Button>
          )}
          {canFillOne && (
            <Button
              size="sm"
              variant="secondary"
              onClick={() => void send({ type: 'FILL', fieldIds: [item.fieldId] })}
            >
              Fill this
            </Button>
          )}
          <Button
            size="sm"
            variant="ghost"
            onClick={() => setEditing(true)}
            aria-label={`Edit ${field?.label ?? 'value'}`}
          >
            <Pencil aria-hidden className="h-3.5 w-3.5" />
            Edit
          </Button>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => void send({ type: 'SKIP', fieldId: item.fieldId })}
            aria-label={`Skip ${field?.label ?? 'field'}`}
          >
            <SkipForward aria-hidden className="h-3.5 w-3.5" />
            Skip
          </Button>
        </div>
      )}
      {item.canonicalKey && <span className="sr-only">Saved as {keyLabel(item.canonicalKey)}</span>}
    </li>
  );
}
