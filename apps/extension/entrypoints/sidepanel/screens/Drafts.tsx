/**
 * AI drafting in the panel (PLAYBOOK Tasks 9.1, 9.3, 9.4): which facts a
 * draft may use, the yellow draft card, goal chips and "strengthen"
 * suggestions. Nothing here approves AI text; the user always does.
 */
import {
  strengthenSuggestions,
  type FieldDescriptor,
  type Goal,
  type PlanItem,
  type SessionState,
  type UserEvent,
} from '@filler/core';
import { Badge, Banner, Button, Spinner, TextField } from '@filler/ui';
import { RefreshCw, Sparkles } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { keyLabel } from '../format';

type Send = (e: UserEvent) => Promise<unknown>;
type Draft = NonNullable<PlanItem['draft']>;

const chip = (on: boolean) =>
  `rounded-full border px-2 py-0.5 text-xs focus-visible:outline-2 focus-visible:outline-emerald-600 ${
    on
      ? 'border-amber-600 bg-amber-50 text-amber-950 dark:bg-amber-900/40 dark:text-amber-50'
      : 'border-slate-300 text-slate-500 line-through dark:border-slate-700 dark:text-slate-400'
  }`;

/** "Using: Projects (3), Skills" with untick, an optional hint, and Draft with AI. */
export function DraftControls({
  item,
  send,
  aiOn,
}: {
  item: PlanItem & { draft: Draft };
  send: Send;
  aiOn: boolean;
}) {
  const draft = item.draft;
  const [off, setOff] = useState<Set<string>>(new Set());
  const [hint, setHint] = useState('');
  const keys = draft.groups.filter((g) => !off.has(g.id)).flatMap((g) => g.keys);
  const toggle = (id: string) =>
    setOff((s) => {
      const next = new Set(s);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  if (!aiOn)
    // AI went offline: no Draft button, but say why the last attempt gave nothing.
    return draft.error ? (
      <p
        className="text-xs text-amber-900 dark:text-amber-200"
        role="status"
        data-testid="draft-error"
      >
        {draft.error}
      </p>
    ) : null;
  return (
    <div
      className="space-y-1.5 rounded-md border border-amber-300 bg-amber-50/60 p-2 dark:border-amber-800 dark:bg-amber-950/30"
      data-testid="draft-controls"
    >
      {draft.groups.length > 0 ? (
        <div
          className="flex flex-wrap items-center gap-1"
          role="group"
          aria-label="Details the AI may use"
        >
          <span className="text-xs font-medium">Using:</span>
          {draft.groups.map((g) => (
            <button
              key={g.id}
              type="button"
              aria-pressed={!off.has(g.id)}
              className={chip(!off.has(g.id))}
              onClick={() => toggle(g.id)}
              title={off.has(g.id) ? `Include ${g.label}` : `Leave out ${g.label}`}
            >
              {g.label}
              {g.count > 1 ? ` (${g.count})` : ''}
            </button>
          ))}
        </div>
      ) : (
        <p className="text-xs">
          Your vault has nothing the AI may use for this yet; it can only use your goal.
        </p>
      )}
      <TextField
        label="Anything to add? (optional)"
        placeholder="e.g. mention my GST project, keep it short"
        value={hint}
        maxLength={300}
        onChange={(e) => setHint(e.target.value)}
      />
      {draft.error && (
        <p
          className="text-xs text-amber-900 dark:text-amber-200"
          role="status"
          data-testid="draft-error"
        >
          {draft.error}
        </p>
      )}
      {draft.needsInput?.length ? (
        <ul className="list-disc pl-4 text-xs" data-testid="draft-needs">
          {draft.needsInput.map((q) => (
            <li key={q}>{q}</li>
          ))}
        </ul>
      ) : null}
      {draft.busy ? (
        <Spinner label="Writing a draft…" />
      ) : (
        <Button
          size="sm"
          variant="secondary"
          onClick={() =>
            void send({
              type: 'DRAFT',
              fieldId: item.fieldId,
              keys,
              ...(hint.trim() ? { hint: hint.trim() } : {}),
            })
          }
        >
          <Sparkles aria-hidden className="h-3.5 w-3.5" />
          Draft with AI
        </Button>
      )}
      <p className="text-[11px] text-slate-600 dark:text-slate-400">
        Only the ticked details are sent. Contact details and anything private never are.
      </p>
    </div>
  );
}

/** Counter, "Why this", alternatives and Regenerate for an AI draft in the review list. */
export function DraftDetails({
  item,
  field,
  send,
  aiOn,
}: {
  item: PlanItem & { draft: Draft };
  field: FieldDescriptor | undefined;
  send: Send;
  aiOn: boolean;
}) {
  const [hint, setHint] = useState('');
  const text = typeof item.value === 'string' ? item.value : '';
  const max = field?.maxLength;
  const over = max !== undefined && text.length > max;
  const used = [
    ...new Set(
      (item.draft.usedFacts ?? []).map(
        (k) => item.draft.groups.find((g) => g.keys.includes(k))?.label ?? keyLabel(k),
      ),
    ),
  ];
  const keys = item.draft.groups.flatMap((g) => g.keys);

  const regenerate = (e: FormEvent) => {
    e.preventDefault();
    void send({
      type: 'DRAFT',
      fieldId: item.fieldId,
      keys,
      ...(hint.trim() ? { hint: hint.trim() } : {}),
    });
  };

  return (
    <div className="mt-1.5 space-y-1.5" data-testid="draft-details">
      <p
        className={`text-xs ${over ? 'text-red-700 dark:text-red-400' : 'text-slate-600 dark:text-slate-400'}`}
        data-testid="draft-count"
      >
        {text.length.toLocaleString('en-IN')}
        {max !== undefined ? ` / ${max.toLocaleString('en-IN')}` : ''} characters
      </p>
      {used.length > 0 && (
        <p className="text-xs text-slate-700 dark:text-slate-300" data-testid="draft-why">
          <span className="font-medium">Why this:</span> written from your {used.join(', ')}.
        </p>
      )}
      {item.draft.alternatives?.length ? (
        <details className="text-xs">
          <summary className="cursor-pointer font-medium">
            Other versions ({item.draft.alternatives.length})
          </summary>
          <ul className="mt-1 space-y-1">
            {item.draft.alternatives.map((alt, i) => (
              <li
                key={i}
                className="rounded border border-slate-200 p-1.5 dark:border-slate-700"
                data-testid="draft-alternative"
              >
                <p className="break-words whitespace-pre-wrap">{alt}</p>
                <div className="mt-1 flex justify-end">
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => void send({ type: 'EDIT', fieldId: item.fieldId, value: alt })}
                  >
                    Use this instead
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        </details>
      ) : null}
      {aiOn && item.status !== 'filled' && (
        <form
          onSubmit={regenerate}
          className="flex items-end gap-1.5"
          aria-label="Regenerate the draft"
        >
          <div className="min-w-0 flex-1">
            <TextField
              label="Change it how?"
              placeholder="more formal, shorter, mention…"
              value={hint}
              maxLength={300}
              onChange={(e) => setHint(e.target.value)}
            />
          </div>
          <Button size="sm" variant="secondary" type="submit" disabled={item.draft.busy}>
            <RefreshCw aria-hidden className="h-3.5 w-3.5" />
            {item.draft.busy ? 'Writing…' : 'Regenerate'}
          </Button>
        </form>
      )}
      {item.draft.error && (
        <p className="text-xs text-amber-900 dark:text-amber-200" role="status">
          {item.draft.error}
        </p>
      )}
    </div>
  );
}

const GOAL_PARTS: Array<{
  key: 'platform' | 'role' | 'targetAudience' | 'tone' | 'language';
  label: string;
}> = [
  { key: 'platform', label: 'Platform' },
  { key: 'role', label: 'Role' },
  { key: 'targetAudience', label: 'Audience' },
  { key: 'tone', label: 'Tone' },
  { key: 'language', label: 'Language' },
];

/** The session goal as editable chips; changes apply to the next draft (Task 9.4). */
export function GoalChips({ goal, send }: { goal: Goal | undefined; send: Send }) {
  const [editing, setEditing] = useState(false);
  const [form, setForm] = useState<Partial<Goal>>({});
  const open = () => {
    setForm(goal ?? {});
    setEditing(true);
  };
  const save = async (e: FormEvent) => {
    e.preventDefault();
    const text = (form.text ?? goal?.text ?? '').trim() || 'Fill this form';
    const next: Goal = { text };
    for (const { key } of GOAL_PARTS) {
      const v = form[key]?.trim();
      if (v) next[key] = v;
    }
    await send({ type: 'SET_GOAL', goal: next });
    setEditing(false);
  };

  if (editing)
    return (
      <form
        onSubmit={(e) => void save(e)}
        className="space-y-1.5 rounded-md border border-slate-200 p-2 dark:border-slate-800"
        aria-label="Edit goal"
      >
        <TextField
          label="Goal"
          value={form.text ?? ''}
          onChange={(e) => setForm({ ...form, text: e.target.value })}
          maxLength={2000}
        />
        {GOAL_PARTS.map(({ key, label }) => (
          <TextField
            key={key}
            label={label}
            value={form[key] ?? ''}
            maxLength={key === 'targetAudience' ? 500 : 200}
            onChange={(e) => setForm({ ...form, [key]: e.target.value })}
          />
        ))}
        <div className="flex justify-end gap-1.5">
          <Button size="sm" variant="ghost" onClick={() => setEditing(false)}>
            Cancel
          </Button>
          <Button size="sm" type="submit">
            Save goal
          </Button>
        </div>
      </form>
    );

  return (
    <div className="space-y-1 rounded bg-slate-50 px-2 py-1 dark:bg-slate-900" data-testid="goal">
      {goal ? (
        <p className="text-xs text-slate-700 dark:text-slate-300">Goal: {goal.text}</p>
      ) : (
        <p className="text-xs text-slate-600 dark:text-slate-400">
          No goal set. Drafts are better with one.
        </p>
      )}
      <div className="flex flex-wrap items-center gap-1">
        {goal &&
          GOAL_PARTS.filter(({ key }) => goal[key]).map(({ key, label }) => (
            <Badge key={key} tone="neutral" data-testid={`goal-${key}`}>
              {label}: {goal[key]}
            </Badge>
          ))}
        <Button size="sm" variant="ghost" onClick={open}>
          {goal ? 'Edit goal' : 'Add a goal'}
        </Button>
      </div>
    </div>
  );
}

/** "Fields you might want to strengthen": suggestions only. */
export function Suggestions({
  session,
  send,
  aiOn,
}: {
  session: SessionState;
  send: Send;
  aiOn: boolean;
}) {
  const list = strengthenSuggestions(session);
  if (!list.length) return null;
  return (
    <Banner tone="blue" data-testid="suggestions">
      <p className="font-medium">You might want to strengthen:</p>
      <ul className="mt-1 space-y-1">
        {list.map((s) => {
          const item = session.plan.find((p) => p.fieldId === s.fieldId);
          return (
            <li key={s.fieldId} className="text-xs">
              {s.message}
              {aiOn && item?.draft && item.status !== 'filled' && (
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() =>
                    void send({
                      type: 'DRAFT',
                      fieldId: s.fieldId,
                      keys: item.draft!.groups.flatMap((g) => g.keys),
                      hint: 'Write a fuller version, closer to the length limit',
                    })
                  }
                >
                  Draft a fuller version
                </Button>
              )}
            </li>
          );
        })}
      </ul>
    </Banner>
  );
}
