/**
 * Vision mode and the field helper, background side (PLAYBOOK Tasks 10.2–10.4).
 * The panel sends a frame it has already blurred and downscaled; this reads
 * it with `ai-vision`, turns the result into copyable suggestions from the
 * vault, and (for a tab with a session) proposes better labels for DOM
 * fields the boxes line up with.
 */
import type { AiClient } from '@filler/ai-client';
import {
  createPolicy,
  explainField,
  fromClassified,
  matchVisionToDom,
  similarity,
  suggestFromVision,
  toAiField,
  weakLabel,
  type Box,
  type Explanation,
  type Fact,
  type ScreenSuggestion,
  type SessionState,
  type VisionField,
  type VisionRequest,
} from '@filler/core';
import type { Repositories, VaultService } from '@filler/vault';
import { fail, ok, type Result } from '../messaging/protocol';
import type { Settings } from '../settings';

export interface ScreenReading {
  formPurpose: string;
  warnings: string[];
  fields: VisionField[];
  suggestions: ScreenSuggestion[];
  /** Tier 1: DOM fields on the tab that would get a better label. */
  relabel: Array<{ domId: string; current: string; label: string }>;
  rejected: number;
}

/** How image pixels map to the page: image px per CSS px, and the scroll when captured. */
export interface ToPage {
  scale: number;
  scrollX: number;
  scrollY: number;
}

export interface VisionDeps {
  aiClient: AiClient;
  vault: VaultService;
  repos: Repositories;
  settings: () => Settings;
  session: (tabId: number) => SessionState | undefined;
}

async function vaultFacts(deps: VisionDeps): Promise<Map<string, Fact> | null> {
  if (!deps.vault.isUnlocked()) return null;
  return new Map((await deps.repos.facts.list()).map((f) => [f.key, f]));
}

export async function readScreen(
  deps: VisionDeps,
  request: VisionRequest,
  target?: { tabId: number; toPage: ToPage },
): Promise<Result<ScreenReading>> {
  const facts = await vaultFacts(deps);
  if (!facts) return fail('VAULT_LOCKED', 'Unlock your vault so Filler can suggest values.');
  const result = await deps.aiClient.vision(request);
  if (!result.ok) return fail('CLOUD', result.message);
  const { fields } = result.data;
  const policy = createPolicy({ extraPatterns: deps.settings().denyPatterns });
  const suggestions = suggestFromVision(fields, (k) => facts.get(k), {
    site: request.page?.host ?? '',
    policy,
    factKeys: new Set(facts.keys()),
  });

  let relabel: ScreenReading['relabel'] = [];
  const state = target ? deps.session(target.tabId) : undefined;
  if (target && state && (state.phase === 'AWAITING_REVIEW' || state.phase === 'READY_TO_SUBMIT')) {
    const { scale, scrollX, scrollY } = target.toPage;
    const toDom = (b: Box): Box => ({
      x: b.x / scale + scrollX,
      y: b.y / scale + scrollY,
      width: b.width / scale,
      height: b.height / scale,
    });
    const dom = state.fields.filter((f) => f.frameId === 0 && f.bbox);
    relabel = matchVisionToDom(fields, dom, toDom).flatMap((m) => {
      const f = dom.find((d) => d.id === m.domId)!;
      const item = state.plan.find((p) => p.fieldId === f.id);
      const unsure = weakLabel(f) || state.mappings[f.id]?.source === 'none';
      if (!unsure || item?.kind === 'denied' || similarity(f.label, m.label) >= 0.9) return [];
      return [{ domId: f.id, current: f.label, label: m.label }];
    });
  }
  return ok({
    formPurpose: result.data.formPurpose,
    warnings: result.data.warnings,
    fields,
    suggestions,
    relabel,
    rejected: result.data.rejected,
  });
}

/**
 * "What should I fill here?" for one field of a session (DOM mode). Works
 * offline from rules, memory and policy; asks the AI (text only) only for a
 * field the rules could not place, and only when AI help is on.
 */
export async function explainSessionField(
  deps: VisionDeps,
  tabId: number,
  fieldId: string,
): Promise<Result<Explanation>> {
  const state = deps.session(tabId);
  const field = state?.fields.find((f) => f.id === fieldId);
  if (!state || !field) return fail('NO_SESSION', 'Start Filler on this page first.');
  const facts = (await vaultFacts(deps)) ?? new Map<string, Fact>();
  const lookup = (k: string) => facts.get(k);
  const policy = createPolicy({ extraPatterns: deps.settings().denyPatterns });
  const mapping = state.mappings[fieldId];
  if (
    mapping?.source === 'none' &&
    deps.settings().aiAssist &&
    policy.classifyRisk(field).allowed
  ) {
    const ai = await deps.aiClient.classify({
      fields: [toAiField(field)],
      page: { host: state.site || 'unknown' },
    });
    const item = ai.ok ? ai.data.results[0] : undefined;
    const mapped = item ? fromClassified(field, item, policy) : null;
    if (item && mapped)
      return ok(
        explainField(field, mapped, lookup, { policy, source: 'ai', aiReason: item.reason }),
      );
  }
  return ok(explainField(field, mapping, lookup, { policy }));
}
