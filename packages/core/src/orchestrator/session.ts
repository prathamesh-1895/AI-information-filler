/**
 * Session state machine (PLAYBOOK Task 5.4, ARCHITECTURE §5.2):
 *
 *   IDLE → SCANNING → MAPPING → PLANNING → AWAITING_REVIEW → FILLING → VERIFYING
 *                ↑                                                     │
 *                └──────── next page / new fields detected ────────────┘
 *                                    │
 *                             READY_TO_SUBMIT  (the user clicks Submit)
 *
 * A pure reducer: `reduce(state, event)` returns the next state plus the
 * effects the host must run (scan, map, plan, fill, save…). The host feeds
 * effect results back in as events. No I/O happens here.
 */
import { z } from 'zod';
import type { MapResult } from '../mapper/map';
import type { AiStatus, GeneratedAnswer } from './ai';
import { parseGoal, platformOf } from './goal';
import { customKeyFor } from '../schema/keys';
import {
  FactValueSchema,
  GoalSchema,
  type FactValue,
  type FieldDescriptor,
  type Goal,
  type PageSnapshot,
  type PlanItem,
} from '../schema/records';
import { siteOf } from '../text/normalise';

export const SESSION_PHASES = [
  'IDLE',
  'SCANNING',
  'MAPPING',
  'PLANNING',
  'AWAITING_REVIEW',
  'FILLING',
  'VERIFYING',
  'READY_TO_SUBMIT',
  'ERROR',
  'ENDED',
] as const;
export type SessionPhase = (typeof SESSION_PHASES)[number];

export type SessionErrorCode =
  'SCAN_FAILED' | 'VAULT_LOCKED' | 'FILL_FAILED' | 'NO_PERMISSION' | 'RESTRICTED_PAGE' | 'NO_TAB';

export interface SessionState {
  id: string;
  tabId: number;
  phase: SessionPhase;
  goal?: Goal;
  site: string;
  url: string;
  title: string;
  fields: FieldDescriptor[];
  mappings: Record<string, MapResult>;
  plan: PlanItem[];
  pages: PageSnapshot[];
  /** Values used so far in this session, by canonical key (keeps later pages consistent). */
  used: Record<string, FactValue>;
  error?: { code: SessionErrorCode; message: string };
  /** AI mode reported by the latest mapping that needed the AI (Phase 8). */
  ai?: AiStatus;
  endReason?: string;
  startedAt: string;
  updatedAt: string;
}

export interface FillResultLite {
  fieldId: string;
  status: 'filled' | 'failed';
  error?: string;
  finalValue?: FactValue;
}

/** Events the user can send (validated at the boundary). */
export const UserEventSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('SET_GOAL'), goal: GoalSchema }),
  z.object({
    type: z.literal('ANSWER'),
    fieldId: z.string(),
    value: FactValueSchema,
    save: z.boolean(),
  }),
  z.object({ type: z.literal('EDIT'), fieldId: z.string(), value: FactValueSchema }),
  z.object({ type: z.literal('APPROVE'), fieldIds: z.array(z.string()) }),
  z.object({ type: z.literal('APPROVE_ALL_VAULT') }),
  z.object({ type: z.literal('SKIP'), fieldId: z.string() }),
  z.object({ type: z.literal('FILL'), fieldIds: z.array(z.string()).optional() }),
  z.object({ type: z.literal('RESCAN') }),
  /** Better labels for fields, read from the screen and accepted by the user (Phase 10). */
  z.object({
    type: z.literal('RELABEL'),
    labels: z.record(z.string(), z.string().trim().min(1).max(200)),
  }),
  /** Ask the AI for a draft using these fact keys (Phase 9). */
  z.object({
    type: z.literal('DRAFT'),
    fieldId: z.string(),
    keys: z.array(z.string().max(80)).max(60),
    hint: z.string().max(300).optional(),
  }),
  z.object({ type: z.literal('END') }),
]);
export type UserEvent = z.infer<typeof UserEventSchema>;

/** Events produced by the host while running effects or observing the browser. */
export type SystemEvent =
  | { type: 'START'; id: string; tabId: number; goal?: Goal; at: string }
  | { type: 'SCANNED'; url: string; title: string; fields: FieldDescriptor[]; at: string }
  | { type: 'SCAN_FAILED'; code: SessionErrorCode; message: string }
  | { type: 'MAPPED'; mappings: Record<string, MapResult>; ai?: AiStatus }
  | { type: 'PLANNED'; items: PlanItem[] }
  | { type: 'ANSWER_REJECTED'; fieldId: string; reason: string }
  | { type: 'DRAFTED'; fieldId: string; answer: GeneratedAnswer }
  | { type: 'FILL_RESULTS'; results: FillResultLite[] }
  | { type: 'FIELDS_CHANGED'; url: string; added: FieldDescriptor[]; removed: string[]; at: string }
  | { type: 'VAULT_LOCKED' }
  | { type: 'VAULT_UNLOCKED' }
  | { type: 'NAVIGATED'; url: string; at: string }
  | { type: 'TAB_CLOSED' };

export type SessionEvent = UserEvent | SystemEvent;

export type HighlightState = 'vault' | 'ai' | 'input' | 'denied' | 'filled' | 'failed';

export type Effect =
  | { type: 'SCAN' }
  | { type: 'MAP'; fieldIds: string[] }
  | { type: 'PLAN'; fieldIds: string[] }
  | {
      type: 'SAVE_ANSWER';
      fieldId: string;
      key: string;
      value: FactValue;
      signature: string;
      site: string;
    }
  | {
      type: 'FILL';
      items: Array<{ fieldId: string; selector: string; signature: string; value: FactValue }>;
    }
  | { type: 'HIGHLIGHT'; items: Array<{ fieldId: string; state: HighlightState; title: string }> }
  | { type: 'GENERATE'; fieldId: string; keys: string[]; hint?: string }
  | {
      type: 'RECORD_ANSWER';
      fieldId: string;
      question: string;
      value: string;
      platform: string;
      goal: string;
    }
  | { type: 'END_PAGE' };

export interface Transition {
  state: SessionState;
  effects: Effect[];
}

const APPROVED = new Set<PlanItem['status']>(['approved', 'edited']);
const OPEN = new Set<PlanItem['status']>(['pending', 'approved', 'edited']);

export function initialState(): SessionState {
  return {
    id: '',
    tabId: -1,
    phase: 'IDLE',
    site: '',
    url: '',
    title: '',
    fields: [],
    mappings: {},
    plan: [],
    pages: [],
    used: {},
    startedAt: '',
    updatedAt: '',
  };
}

function highlightStateOf(item: PlanItem): HighlightState | null {
  if (item.kind === 'denied') return 'denied';
  if (item.status === 'skipped') return null; // skipped fields are left alone on the page
  if (item.status === 'filled') return 'filled';
  if (item.status === 'failed') return 'failed';
  if (item.value === undefined) return 'input';
  return item.source === 'ai' ? 'ai' : 'vault';
}

function highlightOf(state: SessionState): Effect {
  const labels = new Map(state.fields.map((f) => [f.id, f.label]));
  const items = state.plan.flatMap((item) => {
    const hl = highlightStateOf(item);
    return hl ? [{ fieldId: item.fieldId, state: hl, title: labels.get(item.fieldId) ?? '' }] : [];
  });
  return { type: 'HIGHLIGHT', items };
}

/** Done with the page when nothing is waiting for review or filling. */
function settle(state: SessionState): SessionState {
  const open = state.plan.some((p) => OPEN.has(p.status));
  return {
    ...state,
    phase: open || state.plan.length === 0 ? 'AWAITING_REVIEW' : 'READY_TO_SUBMIT',
  };
}

function updateItem(
  state: SessionState,
  fieldId: string,
  patch: (item: PlanItem) => PlanItem,
): SessionState {
  return { ...state, plan: state.plan.map((p) => (p.fieldId === fieldId ? patch(p) : p)) };
}

function withoutQuestion(item: PlanItem): PlanItem {
  const { question: _q, ...rest } = item;
  return rest;
}

/** Approved AI drafts and the user's own written answers are kept for reuse (Task 9.3/9.5). */
function recordAnswer(state: SessionState, item: PlanItem, value: FactValue): Effect[] {
  const field = state.fields.find((f) => f.id === item.fieldId);
  if (!field || typeof value !== 'string' || !value.trim() || !field.label.trim()) return [];
  return [
    {
      type: 'RECORD_ANSWER',
      fieldId: item.fieldId,
      question: field.label,
      value,
      platform: state.goal?.platform ?? state.site,
      goal: state.goal?.text ?? '',
    },
  ];
}

/** Key under which a value is remembered for consistency across pages. */
function usedKey(state: SessionState, item: PlanItem): string | undefined {
  if (item.canonicalKey) return item.canonicalKey;
  const label = state.fields.find((f) => f.id === item.fieldId)?.label;
  return label ? customKeyFor(label) : undefined;
}

/** The reducer. Events that do not apply to the current phase are ignored (state unchanged, no effects). */
export function reduce(current: SessionState, event: SessionEvent): Transition {
  const none: Transition = { state: current, effects: [] };
  if (current.phase === 'ENDED' && event.type !== 'START') return none;
  const at = 'at' in event ? event.at : current.updatedAt;
  const s: SessionState = { ...current, updatedAt: at };

  switch (event.type) {
    case 'START':
      return {
        state: {
          ...initialState(),
          id: event.id,
          tabId: event.tabId,
          ...(event.goal ? { goal: parseGoal(event.goal, '')! } : {}),
          phase: 'SCANNING',
          startedAt: event.at,
          updatedAt: event.at,
        },
        effects: [{ type: 'SCAN' }],
      };

    case 'SET_GOAL':
      return { state: { ...s, goal: event.goal }, effects: [] };

    case 'RESCAN':
      if (current.phase === 'IDLE') return none;
      return { state: { ...s, phase: 'SCANNING' }, effects: [{ type: 'SCAN' }] };

    case 'SCANNED': {
      const page: PageSnapshot = {
        url: event.url,
        title: event.title,
        capturedAt: event.at,
        fieldIds: event.fields.map((f) => f.id),
      };
      const platform = s.goal && !s.goal.platform ? platformOf(event.url) : undefined;
      return {
        state: {
          ...s,
          ...(platform && s.goal ? { goal: { ...s.goal, platform } } : {}),
          phase: 'MAPPING',
          url: event.url,
          title: event.title,
          site: siteOf(event.url),
          fields: event.fields,
          mappings: {},
          plan: [],
          pages: [...s.pages, page],
        },
        effects: [{ type: 'MAP', fieldIds: event.fields.map((f) => f.id) }],
      };
    }

    case 'SCAN_FAILED':
      return {
        state: { ...s, phase: 'ERROR', error: { code: event.code, message: event.message } },
        effects: [],
      };

    case 'MAPPED': {
      const ids = Object.keys(event.mappings);
      const { error: _e, ...rest } = s;
      return {
        state: {
          ...rest,
          phase: 'PLANNING',
          mappings: { ...s.mappings, ...event.mappings },
          ...(event.ai ? { ai: event.ai } : {}),
        },
        effects: [{ type: 'PLAN', fieldIds: ids }],
      };
    }

    case 'PLANNED': {
      const byId = new Map(event.items.map((i) => [i.fieldId, i]));
      const known = new Set(s.plan.map((p) => p.fieldId));
      const plan = [
        ...s.plan.map((p) => byId.get(p.fieldId) ?? p),
        ...event.items.filter((i) => !known.has(i.fieldId)),
      ];
      // Keep plan order = field order on the page.
      const order = new Map(s.fields.map((f, i) => [f.id, i]));
      plan.sort((a, b) => (order.get(a.fieldId) ?? 1e9) - (order.get(b.fieldId) ?? 1e9));
      const { error: _e, ...rest } = s;
      const next = settle({ ...rest, plan });
      return { state: { ...next, phase: 'AWAITING_REVIEW' }, effects: [highlightOf(next)] };
    }

    case 'ANSWER': {
      const field = s.fields.find((f) => f.id === event.fieldId);
      const item = s.plan.find((p) => p.fieldId === event.fieldId);
      if (!field || !item || item.kind === 'denied') return none;
      const key = item.canonicalKey ?? customKeyFor(field.label);
      const next = updateItem(s, event.fieldId, (p) => ({
        ...withoutQuestion(p),
        canonicalKey: key,
        value: event.value,
        source: 'user',
        confidence: 1,
        status: 'approved',
        reason: event.save
          ? 'Your answer (saved to your vault)'
          : 'Your answer (used once, not saved)',
      }));
      const mappings = {
        ...next.mappings,
        [event.fieldId]: {
          ...(next.mappings[event.fieldId] ?? {
            kind: item.kind,
            confidence: 1,
            reason: '',
            source: 'none' as const,
          }),
          canonicalKey: key,
        },
      };
      const effects: Effect[] = [];
      if (event.save)
        effects.push({
          type: 'SAVE_ANSWER',
          fieldId: field.id,
          key,
          value: event.value,
          signature: field.signature,
          site: s.site,
        });
      if (event.save && item.kind === 'open_ended')
        effects.push(...recordAnswer(s, item, event.value));
      const settled = { ...next, mappings, phase: 'AWAITING_REVIEW' as const };
      effects.push(highlightOf(settled));
      return { state: settled, effects };
    }

    case 'ANSWER_REJECTED': {
      const field = s.fields.find((f) => f.id === event.fieldId);
      const next = updateItem(s, event.fieldId, (p) => {
        const { value: _v, source: _s, ...rest } = p;
        return {
          ...rest,
          status: 'pending',
          confidence: 0,
          reason: event.reason,
          question: `What should I put for “${field?.label ?? 'this field'}”?`,
        };
      });
      return { state: next, effects: [highlightOf(next)] };
    }

    case 'EDIT': {
      const item = s.plan.find((p) => p.fieldId === event.fieldId);
      if (!item || item.kind === 'denied') return none;
      const next = updateItem(s, event.fieldId, (p) => ({
        ...withoutQuestion(p),
        value: event.value,
        status: 'edited',
        reason: p.source === 'ai' ? 'AI draft, edited by you' : 'Edited by you',
      }));
      const effects = item.source === 'ai' ? recordAnswer(s, item, event.value) : [];
      return { state: { ...next, phase: 'AWAITING_REVIEW' }, effects };
    }

    case 'APPROVE': {
      const ids = new Set(event.fieldIds);
      const approving = s.plan.filter(
        (p) => ids.has(p.fieldId) && p.status === 'pending' && p.value !== undefined,
      );
      const now = new Set(approving.map((p) => p.fieldId));
      return {
        state: {
          ...s,
          plan: s.plan.map((p) => (now.has(p.fieldId) ? { ...p, status: 'approved' } : p)),
        },
        effects: approving
          .filter((p) => p.source === 'ai')
          .flatMap((p) => recordAnswer(s, p, p.value!)),
      };
    }

    case 'RELABEL': {
      // Never-fill fields keep their label: a screen reading must not talk Filler out of a denial.
      const deniedIds = new Set(s.plan.filter((p) => p.kind === 'denied').map((p) => p.fieldId));
      const ids = Object.keys(event.labels).filter(
        (id) => !deniedIds.has(id) && s.fields.some((f) => f.id === id),
      );
      if (
        !ids.length ||
        (current.phase !== 'AWAITING_REVIEW' && current.phase !== 'READY_TO_SUBMIT')
      )
        return none;
      const fields = s.fields.map((f) =>
        ids.includes(f.id)
          ? { ...f, label: event.labels[f.id]!, labelSource: 'vision' as const }
          : f,
      );
      return {
        state: { ...s, fields, phase: 'MAPPING' },
        effects: [{ type: 'MAP', fieldIds: ids }],
      };
    }

    case 'DRAFT': {
      const item = s.plan.find((p) => p.fieldId === event.fieldId);
      if (!item?.draft || item.draft.busy || item.kind === 'denied' || !OPEN.has(item.status))
        return none;
      const { error: _e, needsInput: _n, hint: _h, ...draft } = item.draft;
      const next = updateItem(s, event.fieldId, (p) => ({
        ...p,
        draft: { ...draft, busy: true, ...(event.hint ? { hint: event.hint } : {}) },
      }));
      return {
        state: next,
        effects: [
          {
            type: 'GENERATE',
            fieldId: event.fieldId,
            keys: event.keys,
            ...(event.hint ? { hint: event.hint } : {}),
          },
        ],
      };
    }

    case 'DRAFTED': {
      const item = s.plan.find((p) => p.fieldId === event.fieldId);
      if (!item?.draft) return none;
      const {
        busy: _b,
        error: _e,
        needsInput: _n,
        alternatives: _a,
        usedFacts: _u,
        ...draft
      } = item.draft;
      const answer = event.answer;
      const next = updateItem(s, event.fieldId, (p) =>
        'value' in answer
          ? {
              ...withoutQuestion(p),
              value: answer.value,
              source: 'ai',
              confidence: 0.6,
              status: 'pending',
              reason: answer.reason,
              draft: {
                ...draft,
                ...(answer.alternatives?.length ? { alternatives: answer.alternatives } : {}),
                ...(answer.usedFacts?.length ? { usedFacts: answer.usedFacts } : {}),
              },
            }
          : {
              ...p,
              draft: {
                ...draft,
                error: answer.reason,
                ...(answer.questions?.length ? { needsInput: answer.questions } : {}),
              },
            },
      );
      return { state: next, effects: [highlightOf(next)] };
    }

    case 'APPROVE_ALL_VAULT':
      return {
        state: {
          ...s,
          plan: s.plan.map((p) =>
            p.status === 'pending' &&
            p.value !== undefined &&
            (p.source === 'vault' || p.source === 'memory')
              ? { ...p, status: 'approved' }
              : p,
          ),
        },
        effects: [],
      };

    case 'SKIP': {
      const next = updateItem(s, event.fieldId, (p) =>
        OPEN.has(p.status)
          ? { ...withoutQuestion(p), status: 'skipped', reason: 'You skipped this field.' }
          : p,
      );
      return { state: settle(next), effects: [highlightOf(next)] };
    }

    case 'FILL': {
      if (current.phase !== 'AWAITING_REVIEW') return none;
      const wanted = event.fieldIds ? new Set(event.fieldIds) : null;
      const items = s.plan
        .filter(
          (p) =>
            APPROVED.has(p.status) &&
            p.value !== undefined &&
            p.kind !== 'denied' &&
            (!wanted || wanted.has(p.fieldId)),
        )
        .flatMap((p) => {
          const f = s.fields.find((x) => x.id === p.fieldId);
          return f
            ? [
                {
                  fieldId: p.fieldId,
                  selector: f.selector,
                  signature: f.signature,
                  value: p.value!,
                },
              ]
            : [];
        });
      if (!items.length) return none;
      return { state: { ...s, phase: 'FILLING' }, effects: [{ type: 'FILL', items }] };
    }

    case 'FILL_RESULTS': {
      const byId = new Map(event.results.map((r) => [r.fieldId, r]));
      const used = { ...s.used };
      const plan = s.plan.map((p) => {
        const r = byId.get(p.fieldId);
        if (!r) return p;
        if (r.status === 'filled') {
          const key = usedKey(s, p);
          if (key && p.value !== undefined) used[key] = p.value;
          return { ...p, status: 'filled' as const, reason: p.reason };
        }
        return {
          ...p,
          status: 'failed' as const,
          reason: r.error ?? 'The page did not accept this value.',
        };
      });
      const verified = settle({ ...s, phase: 'VERIFYING', plan, used });
      return { state: verified, effects: [highlightOf(verified)] };
    }

    case 'FIELDS_CHANGED': {
      const gone = new Set(event.removed);
      const fields = [...s.fields.filter((f) => !gone.has(f.id)), ...event.added];
      const plan = s.plan.filter((p) => !gone.has(p.fieldId));
      const mappings = Object.fromEntries(
        Object.entries(s.mappings).filter(([id]) => !gone.has(id)),
      );
      const pages =
        event.url !== s.url
          ? [
              ...s.pages,
              {
                url: event.url,
                title: s.title,
                capturedAt: event.at,
                fieldIds: event.added.map((f) => f.id),
              },
            ]
          : s.pages;
      const next = { ...s, fields, plan, mappings, pages, url: event.url };
      if (event.added.length) {
        return {
          state: { ...next, phase: 'MAPPING' },
          effects: [{ type: 'MAP', fieldIds: event.added.map((f) => f.id) }],
        };
      }
      return { state: settle(next), effects: [highlightOf(next)] };
    }

    case 'VAULT_LOCKED': {
      if (current.phase === 'IDLE') return none;
      // Hide vault values while locked; the user's own answers stay.
      const plan = s.plan.map((p) => {
        if (!OPEN.has(p.status) || (p.source !== 'vault' && p.source !== 'memory')) return p;
        const { value: _v, source: _s, ...rest } = p;
        return {
          ...rest,
          status: 'pending' as const,
          reason: 'Unlock your vault to see this value.',
        };
      });
      return {
        state: {
          ...s,
          plan,
          phase: 'ERROR',
          error: { code: 'VAULT_LOCKED', message: 'Your vault locked. Unlock it to continue.' },
        },
        effects: [],
      };
    }

    case 'VAULT_UNLOCKED': {
      if (current.error?.code !== 'VAULT_LOCKED') return none;
      const { error: _e, ...rest } = s;
      const ids = s.fields
        .map((f) => f.id)
        .filter(
          (id) =>
            !s.plan.some((p) => p.fieldId === id && (p.source === 'user' || p.status === 'filled')),
        );
      return { state: { ...rest, phase: 'MAPPING' }, effects: [{ type: 'MAP', fieldIds: ids }] };
    }

    case 'NAVIGATED': {
      if (siteOf(event.url) !== s.site && s.site) {
        return {
          state: { ...s, phase: 'ENDED', endReason: 'You left the site, so this session ended.' },
          effects: [{ type: 'END_PAGE' }],
        };
      }
      return { state: { ...s, phase: 'SCANNING', url: event.url }, effects: [{ type: 'SCAN' }] };
    }

    case 'TAB_CLOSED':
      return { state: { ...s, phase: 'ENDED', endReason: 'The tab was closed.' }, effects: [] };

    case 'END':
      return {
        state: { ...s, phase: 'ENDED', endReason: 'You ended the session.' },
        effects: [{ type: 'END_PAGE' }],
      };
  }
}
