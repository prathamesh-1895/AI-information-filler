/**
 * The AI seam backed by the Edge Functions (PLAYBOOK Task 8.4). Plugs into
 * the orchestrator exactly where `offlineAi` sat in Phase 5: rules first,
 * then `resolveUnmapped` for what they could not place. Any failure leaves
 * those fields unmapped, so the session still completes through questions.
 * Open-ended drafting stays offline until Phase 9.
 */
import {
  CLASSIFY_MAX_FIELDS,
  fromClassified,
  offlineAi,
  toAiField,
  type AiContext,
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

    // Phase 9 brings AI drafting; until then open-ended fields are asked.
    generateAnswer: (field, mapping, ctx) => offlineAi.generateAnswer(field, mapping, ctx),
  };
  return seam;
}
