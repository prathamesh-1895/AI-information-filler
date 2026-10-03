/**
 * The AI seam backed by the Edge Functions (PLAYBOOK Task 8.4). Plugs into
 * the orchestrator exactly where `offlineAi` sat in Phase 5: rules first,
 * then `resolveUnmapped` for what they could not place. Any failure leaves
 * those fields unmapped, so the session still completes through questions.
 * Open-ended drafting stays offline until Phase 9.
 */
import {
  checkDraft,
  CLASSIFY_MAX_FIELDS,
  fromClassified,
  isDraftContextKey,
  questionFor,
  toAiField,
  type AiContext,
  type FactValue,
  type GeneratedAnswer,
  type GenerateRequest,
  type AiSeam,
  type AiStatus,
  type FieldDescriptor,
  type MapResult,
  type Policy,
} from '@filler/core';
import { OFFLINE_TEXT, type AiClient, type OfflineReason } from './client';

export interface AiSeamOptions {
  client: AiClient;
  /** Settings → "Use AI to understand new fields". */
  enabled(): boolean | Promise<boolean>;
  /** The user's policy (built-in deny list + their own phrases), re-applied to AI output. */
  policy?(): Pick<Policy, 'classifyRisk'>;
  /** How long a health check result is trusted. */
  statusTtlMs?: number;
  now?: () => number;
}

export interface CloudAiSeam extends AiSeam {
  status(): AiStatus;
  /** Re-checks the backend (health) unless a recent answer is cached. */
  refreshStatus(force?: boolean): Promise<AiStatus>;
}

// Short, fixed reasons for the chip; the server's full message is shown by the connection check.
const offlineStatus = (reason: OfflineReason): AiStatus => ({
  mode: 'offline',
  reason: OFFLINE_TEXT[reason],
});

export function createAiSeam(options: AiSeamOptions): CloudAiSeam {
  const now = options.now ?? (() => Date.now());
  const ttl = options.statusTtlMs ?? 5 * 60_000;
  let current: AiStatus = { mode: 'offline', reason: 'checking…' };
  let checkedAt = -Infinity;

  const set = (status: AiStatus): AiStatus => {
    current = status;
    checkedAt = now();
    return status;
  };

  const seam: CloudAiSeam = {
    get mode() {
      return current.mode;
    },
    status: () => current,

    async refreshStatus(force = false) {
      if (!(await options.enabled())) return set(offlineStatus('disabled'));
      if (!force && now() - checkedAt < ttl && current.reason !== 'checking…') return current;
      const health = await options.client.health();
      if (!health.ok) return set(offlineStatus(health.reason));
      return set(health.data.providerConfigured ? { mode: 'ai' } : offlineStatus('no_provider'));
    },

    async resolveUnmapped(fields: FieldDescriptor[], ctx: AiContext) {
      const out = new Map<string, MapResult>();
      if (!(await options.enabled())) {
        set(offlineStatus('disabled'));
        return out;
      }
      const batch = fields.slice(0, CLASSIFY_MAX_FIELDS);
      if (!batch.length) return out;
      const goal = ctx.goal
        ? {
            text: ctx.goal.text.slice(0, 500),
            ...(ctx.goal.platform ? { platform: ctx.goal.platform.slice(0, 253) } : {}),
            ...(ctx.goal.role ? { role: ctx.goal.role.slice(0, 200) } : {}),
          }
        : undefined;
      const result = await options.client.classify({
        fields: batch.map(toAiField),
        page: {
          host: ctx.site.slice(0, 253) || 'unknown',
          ...(ctx.title ? { title: ctx.title.slice(0, 200) } : {}),
        },
        ...(goal ? { goal } : {}),
      });
      if (!result.ok) {
        set(offlineStatus(result.reason));
        return out;
      }
      set({ mode: 'ai' });
      const policy = options.policy?.();
      const byId = new Map(batch.map((f) => [f.id, f]));
      for (const item of result.data.results) {
        const field = byId.get(item.id);
        const mapped = field ? fromClassified(field, item, policy) : null;
        if (field && mapped) out.set(field.id, mapped);
      }
      return out;
    },

    async generateAnswer(field, _mapping, ctx): Promise<GeneratedAnswer> {
      const ask = (reason: string, questions: string[] = []): GeneratedAnswer => ({
        needsInput: questions[0] ?? questionFor(field),
        reason,
        ...(questions.length ? { questions } : {}),
      });
      if (!(await options.enabled())) {
        set(offlineStatus('disabled'));
        return ask('AI help is turned off in Settings. Write this one yourself.');
      }
      const request = generateRequest(field, ctx);
      const result = await options.client.generate(request);
      if (!result.ok) {
        set(offlineStatus(result.reason));
        return ask(
          `${capitalise(OFFLINE_TEXT[result.reason])}. Write this one yourself, or try again later.`,
        );
      }
      set({ mode: 'ai' });
      const r = result.data;
      // The server already checked the draft; checked again here so a bad reply never reaches the page.
      const main = r.value !== undefined ? checkDraft(r.value, request) : null;
      const alternatives = r.alternatives
        .map((a) => checkDraft(a, request))
        .flatMap((c) => (c.ok ? [c.value] : []));
      const best = main?.ok ? main.value : alternatives[0];
      if (best !== undefined)
        return {
          value: best,
          reason: 'AI draft from your details. Check it, then approve or edit.',
          alternatives: alternatives.filter((a) => a !== best).slice(0, 2),
          usedFacts: r.usedFacts,
        };
      if (r.needsInput.length) return ask('The AI needs a bit more from you first.', r.needsInput);
      return ask(
        r.problem ??
          'The AI could not write a draft that follows Filler’s rules. Write it yourself.',
      );
    },
  };
  return seam;
}

const capitalise = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

const clipValue = (v: FactValue): FactValue =>
  Array.isArray(v) ? v.slice(0, 60).map((x) => x.slice(0, 500)) : v.slice(0, 4_000);

/**
 * Builds the generate request from what the host selected. Values filled
 * earlier in the session are sent for consistency only when they are public
 * profile details (a headline, a rate), never names, contact or address data.
 */
export function generateRequest(field: FieldDescriptor, ctx: AiContext): GenerateRequest {
  const goal = ctx.goal;
  const options = field.options
    ?.map((o) => (o.text || o.value).trim().slice(0, 200))
    .filter(Boolean)
    .slice(0, 100);
  return {
    field: {
      ...toAiField(field),
      ...(options?.length ? { options } : {}),
      ...(ctx.lengthWindow ? { lengthWindow: ctx.lengthWindow } : {}),
    },
    page: { host: ctx.site.slice(0, 253) || 'unknown' },
    goal: {
      ...(goal?.text ? { text: goal.text.slice(0, 500) } : {}),
      ...(goal?.platform ? { platform: goal.platform.slice(0, 253) } : {}),
      ...(goal?.role ? { role: goal.role.slice(0, 200) } : {}),
      ...(goal?.targetAudience ? { audience: goal.targetAudience.slice(0, 300) } : {}),
      ...(goal?.tone ? { tone: goal.tone.slice(0, 100) } : {}),
      ...(goal?.language ? { language: goal.language.slice(0, 50) } : {}),
    },
    facts: (ctx.facts ?? []).slice(0, 60).map((f) => ({ key: f.key, value: clipValue(f.value) })),
    filled: Object.entries(ctx.filled)
      .filter(([key]) => isDraftContextKey(key))
      .slice(0, 40)
      .map(([key, value]) => ({ key, value: clipValue(value) })),
    examples: (ctx.examples ?? [])
      .slice(0, 3)
      .map((e) => ({ question: e.question.slice(0, 500), answer: e.answer.slice(0, 6_000) })),
    ...(ctx.hint ? { hint: ctx.hint.slice(0, 300) } : {}),
  };
}
