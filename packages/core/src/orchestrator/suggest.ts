/**
 * "Fields on this page you might want to strengthen" (PLAYBOOK Task 9.4).
 * Suggestions only: nothing here changes a value.
 */
import type { SessionState } from './session';

export interface Suggestion {
  fieldId: string;
  label: string;
  message: string;
}

/** Long-answer fields filled with much less than the page allows. */
export function strengthenSuggestions(state: SessionState): Suggestion[] {
  const out: Suggestion[] = [];
  for (const item of state.plan) {
    if (item.kind !== 'open_ended' || typeof item.value !== 'string') continue;
    if (item.status === 'skipped' || item.status === 'failed') continue;
    const field = state.fields.find((f) => f.id === item.fieldId);
    const max = field?.maxLength;
    if (!field || !max || max < 300) continue;
    const length = item.value.trim().length;
    if (length >= max * 0.25) continue;
    out.push({
      fieldId: item.fieldId,
      label: field.label,
      message: `${field.label} uses ${length.toLocaleString('en-IN')} of ${max.toLocaleString('en-IN')} characters. A fuller answer usually reads better here.`,
    });
  }
  return out;
}
