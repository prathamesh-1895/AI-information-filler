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
  type AiSeam,
  type Effect,
  type Fact,
  type FieldDescriptor,
  type FieldMemory,
  type MapResult,
  type SessionErrorCode,
  type SessionEvent,
  type SessionState,
} from '@filler/core';
import type { Repositories, VaultService } from '@filler/vault';
import type { FillItem, FillResult, HighlightItem, PageScan, Result } from '../messaging/protocol';
import { DEFAULT_SETTINGS, isTrusted, type Settings } from '../settings';

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

export class SessionHost {
  private readonly sessions = new Map<number, SessionState>();
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
          const all = mapFields(state.fields, {
            site: state.site,
            policy: createPolicy({ extraPatterns: settings.denyPatterns }),
            memory: new Map(memories.map((m: FieldMemory) => [m.signature, m])),
            factKeys: new Set(facts.map((f) => f.key)),
            factValues: new Map(
              facts
                .filter((f) => typeof f.value === 'string')
                .map((f) => [f.key, f.value as string]),
            ),
          });
          const wanted = new Set(effect.fieldIds);
          const mappings: Record<string, MapResult> = {};
          for (const [id, m] of all) if (wanted.has(id)) mappings[id] = m;
          // Rules first; whatever they could not place goes to the AI seam (offline: nothing).
          const unmapped = state.fields.filter(
            (f) => wanted.has(f.id) && mappings[f.id]?.source === 'none',
          );
          if (!unmapped.length) return [{ type: 'MAPPED', mappings }];
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
          return [{ type: 'MAPPED', mappings, ai }];
        }
        case 'PLAN': {
          if (!this.deps.vault.isUnlocked()) return [{ type: 'VAULT_LOCKED' }];
          const facts = new Map((await this.deps.repos.facts.list()).map((f: Fact) => [f.key, f]));
          const fields = state.fields.filter((f: FieldDescriptor) =>
            effect.fieldIds.includes(f.id),
          );
          const items = await buildPlan(fields, new Map(Object.entries(state.mappings)), {
            lookup: (key) => facts.get(key),
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
        case 'END_PAGE':
          await this.deps.endTab(tabId);
          return [];
      }
    } catch (error) {
      // An effect that throws must not wedge the session.
      if (effect.type === 'SCAN')
        return [{ type: 'SCAN_FAILED', code: 'SCAN_FAILED', message: String(error) }];
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
