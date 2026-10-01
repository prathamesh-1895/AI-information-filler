/**
 * The AI seam (PLAYBOOK Task 5.4). Phase 8/9 plug real implementations in;
 * until then — and whenever AI is unavailable — `offlineAi` answers every
 * request with "ask the user", so the deterministic product always works.
 */
import { questionFor } from '../mapper/format';
import type { MapResult } from '../mapper/map';
import type { FactValue, FieldDescriptor, Goal } from '../schema/records';

export interface AiContext {
  goal?: Goal;
  site: string;
  /** Page title (sent to the AI redacted, as context). */
  title?: string;
  /** Values already used in this session, keyed by canonical key, for consistency. */
  filled: Readonly<Record<string, FactValue>>;
}

export type GeneratedAnswer =
  | { value: string; reason: string; alternatives?: string[] }
  | { needsInput: string; reason: string };

/** Which mode is active, and why it is offline. Shown in the side panel at all times. */
export interface AiStatus {
  mode: 'offline' | 'ai';
  /** Plain-language reason when offline ("not signed in", "daily limit reached"…). */
  reason?: string;
}

export interface AiSeam {
  /** Which mode answered; shown in the UI so the user always knows. */
  readonly mode: 'offline' | 'ai';
  /** Status after the latest call (optional: offline-only seams have none). */
  status?(): AiStatus;
  /** Classifies fields the rules could not (Phase 8). Missing entries stay unmapped. */
  resolveUnmapped(fields: FieldDescriptor[], ctx: AiContext): Promise<Map<string, MapResult>>;
  /** Drafts an answer for an open-ended field (Phase 9). */
  generateAnswer(
    field: FieldDescriptor,
    mapping: MapResult,
    ctx: AiContext,
  ): Promise<GeneratedAnswer>;
}

export const offlineAi: AiSeam = {
  mode: 'offline',
  status: () => ({ mode: 'offline', reason: 'AI is not available' }),
  async resolveUnmapped() {
    return new Map();
  },
  async generateAnswer(field) {
    return {
      needsInput: questionFor(field),
      reason: 'Offline mode: Filler needs you to write this one.',
    };
  },
};
