/**
 * Session host (background worker): runs the core session reducer for each
 * tab and executes its effects against the real page agent and the vault.
 * Every dependency is injected, so the host is unit-testable without a browser.
 */
import {
  buildPlan,
  createPolicy,
  siteOf,
  initialState,
  mapFields,
  offlineAi,
  reduce,
  restrictSelection,
  selectFacts,
  historyItems,
  applyProfile,
  detectProfile,
  type ActiveProfile,
  type FieldConstraint,
  type AiSeam,
  type Answer,
  type Effect,
  type Fact,
  type FieldDescriptor,
  type FieldMemory,
  type MapResult,
  type SessionErrorCode,
  type SessionEvent,
  type SessionState,
} from '@filler/core';
import { questionSimilarity, type Repositories, type VaultService } from '@filler/vault';
import type { FillItem, FillResult, HighlightItem, PageScan, Result } from '../messaging/protocol';
import { DEFAULT_SETTINGS, isTrusted, type Settings } from '../settings';
import { builtInProfiles } from '../platforms/profiles';

export interface HostDeps {
  vault: VaultService;
  repos: Repositories;
  ai?: AiSeam;
  scanTab(tabId: number): Promise<Result<PageScan>>;
  fillTab(tabId: number, items: FillItem[]): Promise<Result<FillResult[]>>;
  highlightTab(tabId: number, items: HighlightItem[]): Promise<unknown>;
  observeTab(tabId: number): Promise<unknown>;
  endTab(tabId: number): Promise<unknown>;
  /** Called with every new state (the background broadcasts it to the panel). */
  publish(tabId: number, state: SessionState): void;
  /** Current user settings (Task 6.4). Defaults when omitted. */
  getSettings?: () => Promise<Settings>;
  now?: () => string;
  newId?: () => string;
}

const SCAN_CODES = new Set<SessionErrorCode>(['NO_PERMISSION', 'RESTRICTED_PAGE', 'NO_TAB']);

/** How close an earlier question must be to offer its answer offline (Task 9.5). */
const PAST_ANSWER_MIN = 0.6;

/** The best earlier answer for a question: most similar, same platform first. */
export function bestPastAnswer(
  answers: readonly Answer[],
  question: string,
  platform: string,
): Answer | undefined {
  let best: { answer: Answer; score: number } | undefined;
  for (const answer of answers) {
    const score =
      questionSimilarity(question, answer.questionText) +
      (answer.platform.toLowerCase() === platform.toLowerCase() ? 0.01 : 0);
    if (score >= PAST_ANSWER_MIN && (!best || score > best.score)) best = { answer, score };
  }
  return best?.answer;
}

export class SessionHost {
  private readonly sessions = new Map<number, SessionState>();
  /** History being collected per session id, merged across pages by field signature. */
  private readonly histories = new Map<
    string,
    Map<string, ReturnType<typeof historyItems>[number]>
  >();
  private readonly queues = new Map<number, Promise<unknown>>();
  private readonly ai: AiSeam;
  private readonly now: () => string;
  private readonly newId: () => string;

  constructor(private readonly deps: HostDeps) {
    this.ai = deps.ai ?? offlineAi;
    this.now = deps.now ?? (() => new Date().toISOString());
    this.newId = deps.newId ?? (() => globalThis.crypto.randomUUID());
  }

  get(tabId: number): SessionState | undefined {
    return this.sessions.get(tabId);
  }

  tabs(): number[] {
    return [...this.sessions.keys()];
  }

  /** Starts (or restarts) the session for a tab. Resolves once the plan is ready or the start failed. */
  async start(tabId: number, goal?: SessionState['goal']): Promise<SessionState> {
    const settings = await this.settings();
    // Generated answers use the language from Settings unless the goal says otherwise.
    const withLanguage = goal
      ? { ...goal, language: goal.language ?? settings.answerLanguage }
      : undefined;
    return this.dispatch(tabId, {
      type: 'START',
      id: this.newId(),
      tabId,
      ...(withLanguage ? { goal: withLanguage } : {}),
      at: this.now(),
    });
  }

  private settings(): Promise<Settings> {
    return this.deps.getSettings?.() ?? Promise.resolve(DEFAULT_SETTINGS);
  }

  /**
   * Applies an event and runs the resulting effects (which may dispatch more
   * events) before resolving. Events for one tab are processed strictly in order.
   */
  dispatch(tabId: number, event: SessionEvent): Promise<SessionState> {
    const previous = this.queues.get(tabId) ?? Promise.resolve();
    const run = previous.then(() => this.apply(tabId, event));
    this.queues.set(
      tabId,
      run.catch(() => undefined),
    );
    return run;
  }

  private async apply(tabId: number, event: SessionEvent): Promise<SessionState> {
    const current = this.sessions.get(tabId) ?? initialState();
    const { state, effects } = reduce(current, event);
    if (state !== current) {
      this.sessions.set(tabId, state);
      this.deps.publish(tabId, state);
      await this.recordHistory(current, state);
    }
    for (const effect of effects) {
      const follow = await this.run(tabId, effect);
      for (const next of follow) await this.apply(tabId, next);
    }
    if (state.phase === 'ENDED') this.queues.delete(tabId);
    return this.sessions.get(tabId) ?? state;
  }

  /** Runs one effect and returns the events it produced. Never throws. */
  private async run(tabId: number, effect: Effect): Promise<SessionEvent[]> {
    const state = this.sessions.get(tabId);
    if (!state) return [];
    try {
      switch (effect.type) {
        case 'SCAN': {
          const scan = await this.deps.scanTab(tabId);
          if (!scan.ok) {
            const code = SCAN_CODES.has(scan.error.code as SessionErrorCode)
              ? (scan.error.code as SessionErrorCode)
              : 'SCAN_FAILED';
            return [{ type: 'SCAN_FAILED', code, message: scan.error.message }];
          }
          await this.deps.observeTab(tabId);
          return [
            {
              type: 'SCANNED',
              url: scan.data.url,
              title: scan.data.title,
              fields: scan.data.fields,
              at: this.now(),
            },
          ];
        }
        case 'MAP': {
          if (!this.deps.vault.isUnlocked()) return [{ type: 'VAULT_LOCKED' }];
          const [facts, memories] = await Promise.all([
            this.deps.repos.facts.list(),
            this.deps.repos.fieldMemory.list(),
          ]);
          const settings = await this.settings();
          const policy = createPolicy({ extraPatterns: settings.denyPatterns });
          const all = mapFields(state.fields, {
            site: state.site,
            policy,
            memory: new Map(memories.map((m: FieldMemory) => [m.signature, m])),
            factKeys: new Set(facts.map((f) => f.key)),
            factValues: new Map(
              facts
                .filter((f) => typeof f.value === 'string')
                .map((f) => [f.key, f.value as string]),
            ),
          });
          const wanted = new Set(effect.fieldIds);
          let mappings: Record<string, MapResult> = {};
          for (const [id, m] of all) if (wanted.has(id)) mappings[id] = m;
          // Platform profile (optional): tunes what the rules found; never required.
          let profile: ActiveProfile | undefined;
          let constraints: Record<string, FieldConstraint> | undefined;
          if (settings.platformProfiles) {
            const found = detectProfile(builtInProfiles(), {
              url: state.url,
              title: state.title,
              fields: state.fields,
            });
            if (found) {
              const applied = applyProfile(
                found.profile,
                state.fields.filter((f) => wanted.has(f.id)),
                mappings,
                policy,
              );
              mappings = applied.mappings;
              constraints = applied.constraints;
              const p = found.profile.profile;
              profile = {
                id: p.id,
                name: p.name,
                family: p.family,
                by: found.by,
                tips: p.tips,
                neverClick: p.navigation.neverClick,
                goal: p.goal,
              };
            }
          }
          const extra = {
            ...(profile ? { profile } : {}),
            ...(constraints ? { constraints } : {}),
          };
          // Rules first; whatever they could not place goes to the AI seam (offline: nothing).
          const unmapped = state.fields.filter(
            (f) => wanted.has(f.id) && mappings[f.id]?.source === 'none',
          );
          if (!unmapped.length) return [{ type: 'MAPPED', mappings, ...extra }];
          const byAi = await this.ai.resolveUnmapped(unmapped, {
            site: state.site,
            ...(state.title ? { title: state.title } : {}),
            filled: state.used,
            ...(state.goal ? { goal: state.goal } : {}),
          });
          const signatures = new Map(unmapped.map((f) => [f.id, f.signature]));
          for (const [id, m] of byAi) {
            if (mappings[id]?.source !== 'none') continue;
            mappings[id] = m;
            // Remember the AI's reading of this field, so the same field never costs a second call.
            const signature = signatures.get(id);
            if (signature && m.kind !== 'denied')
              await this.deps.repos.fieldMemory
                .upsert({
                  signature,
                  site: state.site,
                  via: 'ai',
                  kind: m.kind,
                  ...(m.canonicalKey ? { canonicalKey: m.canonicalKey } : {}),
                })
                .catch(() => undefined);
          }
          const ai = this.ai.status?.() ?? { mode: this.ai.mode };
          return [{ type: 'MAPPED', mappings, ai, ...extra }];
        }
        case 'PLAN': {
          if (!this.deps.vault.isUnlocked()) return [{ type: 'VAULT_LOCKED' }];
          const all = await this.deps.repos.facts.list();
          const facts = new Map(all.map((f: Fact) => [f.key, f]));
          const fields = state.fields.filter((f: FieldDescriptor) =>
            effect.fieldIds.includes(f.id),
          );
          // Earlier approved answers are offered for open-ended questions (Task 9.5); with AI
          // down this is the main help, with AI on the user can still ask for a fresh draft.
          const answers = await this.deps.repos.answers.list();
          const platform = state.goal?.platform ?? state.site;
          const items = await buildPlan(fields, new Map(Object.entries(state.mappings)), {
            lookup: (key) => facts.get(key),
            facts: all,
            pastAnswer: (field) => {
              const past = bestPastAnswer(answers, field.label, platform);
              return past ? { value: past.value, platform: past.platform } : undefined;
            },
            ai: this.ai,
            aiContext: {
              site: state.site,
              filled: state.used,
              ...(state.goal ? { goal: state.goal } : {}),
            },
          });
          // Trusted sites: vault values are approved straight away (AI text never is).
          const trusted = isTrusted(await this.settings(), state.site || siteOf(state.url));
          return trusted
            ? [{ type: 'PLANNED', items }, { type: 'APPROVE_ALL_VAULT' }]
            : [{ type: 'PLANNED', items }];
        }
        case 'SAVE_ANSWER': {
          try {
            await this.deps.repos.facts.setValue(effect.key, effect.value, {
              learnedOn: effect.site,
            });
            await this.deps.repos.fieldMemory.upsert({
              signature: effect.signature,
              site: effect.site,
              canonicalKey: effect.key,
            });
            return [];
          } catch (error) {
            return [
              {
                type: 'ANSWER_REJECTED',
                fieldId: effect.fieldId,
                reason: error instanceof Error ? error.message : String(error),
              },
            ];
          }
        }
        case 'FILL': {
          const { typingMode } = await this.settings();
          const items = effect.items.map((i) =>
            typingMode === 'typing' ? { ...i, mode: 'typing' as const } : i,
          );
          const result = await this.deps.fillTab(tabId, items);
          const results = result.ok
            ? result.data.map((r) => ({
                fieldId: r.fieldId,
                status: r.status,
                ...(r.error ? { error: r.error } : {}),
              }))
            : effect.items.map((i) => ({
                fieldId: i.fieldId,
                status: 'failed' as const,
                error: result.error.message,
              }));
          return [{ type: 'FILL_RESULTS', results }];
        }
        case 'HIGHLIGHT':
          // Highlighting off: send an empty list, which clears any outlines already shown.
          await this.deps.highlightTab(
            tabId,
            (await this.settings()).highlight ? effect.items : [],
          );
          return [];
        case 'GENERATE': {
          const fieldId = effect.fieldId;
          const field = state.fields.find((f) => f.id === fieldId);
          if (!field) return [];
          if (!this.deps.vault.isUnlocked())
            return [
              {
                type: 'DRAFTED',
                fieldId,
                answer: {
                  needsInput: '',
                  reason: 'Unlock your vault so Filler can use your details.',
                },
              },
            ];
          const facts = await this.deps.repos.facts.list();
          // The panel may untick groups, never add: keys are re-checked against the selection rules.
          const allowed = new Set(
            restrictSelection(selectFacts(field, facts, state.goal), effect.keys),
          );
          const platform = state.goal?.platform ?? state.site;
          const examples = (
            await this.deps.repos.answers.search(field.label, { platform, limit: 3 })
          ).map((r) => ({ question: r.answer.questionText, answer: r.answer.value }));
          const { answerLanguage } = await this.settings();
          // The profile's length window (e.g. Upwork overviews: 1,000–5,000) guides the draft.
          const window = state.constraints?.[fieldId]?.lengthWindow;
          const hint = effect.hint;
          const goal = state.goal
            ? { ...state.goal, language: state.goal.language ?? answerLanguage }
            : { text: state.title || state.site || 'Fill this form', language: answerLanguage };
          const answer = await this.ai.generateAnswer(
            field,
            state.mappings[fieldId] ?? {
              kind: 'open_ended',
              confidence: 0,
              reason: '',
              source: 'none',
            },
            {
              site: state.site,
              ...(state.title ? { title: state.title } : {}),
              goal,
              filled: state.used,
              facts: facts
                .filter((f) => allowed.has(f.key))
                .map((f) => ({ key: f.key, value: f.value })),
              examples,
              ...(hint ? { hint } : {}),
              ...(window ? { lengthWindow: window } : {}),
            },
          );
          const ai = this.ai.status?.();
          return [{ type: 'DRAFTED', fieldId, answer, ...(ai ? { ai } : {}) }];
        }
        case 'RECORD_ANSWER':
          await this.deps.repos.answers.add({
            id: this.newId(),
            questionText: effect.question.slice(0, 2_000),
            platform: effect.platform.slice(0, 253),
            goal: effect.goal.slice(0, 2_000),
            value: effect.value.slice(0, 20_000),
            approvedAt: this.now(),
          });
          return [];
        case 'END_PAGE':
          await this.deps.endTab(tabId);
          return [];
      }
    } catch (error) {
      // An effect that throws must not wedge the session.
      if (effect.type === 'SCAN')
        return [{ type: 'SCAN_FAILED', code: 'SCAN_FAILED', message: String(error) }];
      if (effect.type === 'GENERATE')
        return [
          {
            type: 'DRAFTED',
            fieldId: effect.fieldId,
            answer: { needsInput: '', reason: `The draft failed: ${String(error)}` },
          },
        ];
      if (effect.type === 'FILL') {
        return [
          {
            type: 'FILL_RESULTS',
            results: effect.items.map((i) => ({
              fieldId: i.fieldId,
              status: 'failed' as const,
              error: String(error),
            })),
          },
        ];
      }
      return [];
    }
  }

  /**
   * Session history (Task 11.4): after a fill, the page's outcome is merged
   * into this session's record and saved (encrypted). Nothing is recorded
   * for a session that filled nothing.
   */
  private async recordHistory(before: SessionState, after: SessionState): Promise<void> {
    if (!after.id || !after.site || !this.deps.vault.isUnlocked()) return;
    const filledNow =
      after.phase === 'READY_TO_SUBMIT' ||
      (after.phase === 'VERIFYING' && before.phase === 'FILLING') ||
      after.plan.some((p, i) => p.status === 'filled' && before.plan[i]?.status !== 'filled');
    if (!filledNow) return;
    const items = this.histories.get(after.id) ?? new Map();
    for (const item of historyItems(after)) items.set(item.signature, item);
    this.histories.set(after.id, items);
    if (![...items.values()].some((i) => i.status === 'filled')) return;
    await this.deps.repos.history
      .add({
        id: after.id,
        site: after.site,
        url: after.url.slice(0, 2_000),
        title: after.title.slice(0, 1_000),
        ...(after.goal ? { goal: after.goal.text } : {}),
        startedAt: after.startedAt,
        endedAt: this.now(),
        items: [...items.values()].slice(0, 500),
      })
      .catch(() => undefined);
  }

  /** Vault locked/unlocked: tell every live session. */
  async broadcast(
    event: Extract<SessionEvent, { type: 'VAULT_LOCKED' | 'VAULT_UNLOCKED' }>,
  ): Promise<void> {
    await Promise.all(this.tabs().map((tabId) => this.dispatch(tabId, event)));
  }

  forget(tabId: number): void {
    this.sessions.delete(tabId);
    this.queues.delete(tabId);
  }
}
