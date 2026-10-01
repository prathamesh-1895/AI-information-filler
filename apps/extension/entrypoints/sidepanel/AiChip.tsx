import type { AiStatus } from '@filler/core';
import { Badge } from '@filler/ui';
import { Sparkles } from 'lucide-react';
import { useEffect } from 'react';
import { usePanel } from './store';

/**
 * The mode chip (PLAYBOOK Task 8.4): always says whether AI is on, and if
 * not, why. A session's own status (from its latest AI call) wins over the
 * general one.
 */
export function AiChip({ status }: { status?: AiStatus | undefined }) {
  const general = usePanel((s) => s.aiStatus);
  const refreshAi = usePanel((s) => s.refreshAi);
  useEffect(() => {
    void refreshAi();
  }, [refreshAi]);
  const current = status ?? general;
  if (!current) return null;
  const on = current.mode === 'ai';
  const why = on ? 'Filler uses AI for fields it does not recognise.' : current.reason;
  return (
    <div className="flex min-w-0 flex-col items-end gap-0.5" data-testid="ai-chip">
      <Badge tone={on ? 'green' : 'neutral'} title={why}>
        {on && <Sparkles aria-hidden className="h-3 w-3" />}
        {on ? 'AI on' : 'Offline mode'}
      </Badge>
      {!on && current.reason && (
        <span
          className="max-w-[11rem] text-right text-[11px] leading-tight text-slate-600 dark:text-slate-400"
          data-testid="ai-reason"
        >
          {current.reason}
        </span>
      )}
    </div>
  );
}
