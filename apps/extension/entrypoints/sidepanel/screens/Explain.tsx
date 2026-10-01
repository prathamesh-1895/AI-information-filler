/** "What should I fill here?" for one field (PLAYBOOK Task 10.4), DOM mode. */
import type { Explanation } from '@filler/core';
import { Button } from '@filler/ui';
import { CircleHelp } from 'lucide-react';
import { useState } from 'react';
import { call } from '@/src/messaging/client';
import { mask, sensitivityOf } from '../format';

export function ExplainButton({
  tabId,
  fieldId,
  label,
}: {
  tabId: number;
  fieldId: string;
  label: string;
}) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<Explanation | string | null>(null);
  const [revealed, setRevealed] = useState(false);

  const toggle = async () => {
    if (open) {
      setOpen(false);
      return;
    }
    setOpen(true);
    if (result) return;
    setBusy(true);
    const r = await call<Explanation>({ type: 'EXPLAIN', tabId, fieldId });
    setBusy(false);
    setResult(r.ok ? r.data : r.error.message);
  };

  const e = typeof result === 'object' ? result : null;
  const sensitive = e?.key ? sensitivityOf(e.key) !== 'public' : false;
  return (
    <>
      <Button
        size="sm"
        variant="ghost"
        aria-expanded={open}
        aria-label={`What is “${label}”?`}
        onClick={() => void toggle()}
      >
        <CircleHelp aria-hidden className="h-3.5 w-3.5" />
        What is this?
      </Button>
      {open && (
        <div
          className="mt-1 basis-full rounded-md bg-slate-50 p-2 text-xs dark:bg-slate-900"
          role="status"
          data-testid="explanation"
        >
          {busy && 'Looking…'}
          {typeof result === 'string' && result}
          {e && (
            <div className="space-y-0.5">
              <p className="text-sm text-slate-900 dark:text-slate-100">{e.summary}</p>
              {e.value !== undefined && (
                <p>
                  Filler would use:{' '}
                  <span className="font-medium">
                    {sensitive && !revealed ? mask(e.value) : e.value}
                  </span>
                  {sensitive && (
                    <button
                      type="button"
                      className="ml-1 underline"
                      onClick={() => setRevealed((r) => !r)}
                    >
                      {revealed ? 'Hide' : 'Show'}
                    </button>
                  )}
                </p>
              )}
              {e.risk && <p className="text-red-800 dark:text-red-300">{e.risk}</p>}
              <p className="text-slate-600 dark:text-slate-400" data-testid="explanation-source">
                Source: {e.sourceLabel}
              </p>
            </div>
          )}
        </div>
      )}
    </>
  );
}
