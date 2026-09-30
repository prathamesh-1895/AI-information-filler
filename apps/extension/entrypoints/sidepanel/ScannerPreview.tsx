import { classifyRisk, type FieldDescriptor } from '@filler/core';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  endSession,
  getTargetTab,
  highlightFields,
  onPageEvent,
  requestSiteAccess,
  scanTab,
  startObserving,
} from '@/src/messaging/client';
import type { ErrorCode, PageScan, TargetTab } from '@/src/messaging/protocol';

type State =
  | { phase: 'idle' }
  | { phase: 'scanning' }
  | { phase: 'done'; scan: PageScan }
  | { phase: 'error'; code: ErrorCode; message: string };

interface ChangeSummary {
  added: number;
  removed: number;
}

/**
 * Temporary developer view (PLAYBOOK Tasks 3.5 and 4.3–4.4): lists what the
 * scanner found, keeps the list live as the page changes, and can outline
 * the fields on the page. The session UI replaces it in Phase 6.
 */
export function ScannerPreview() {
  const [target, setTarget] = useState<TargetTab | null>(null);
  const [state, setState] = useState<State>({ phase: 'idle' });
  const [changes, setChanges] = useState<ChangeSummary | null>(null);
  const [highlighted, setHighlighted] = useState(false);
  const [focusedId, setFocusedId] = useState<string | null>(null);
  const sessionTab = useRef<number | null>(null);

  const refreshTarget = useCallback(async () => {
    const result = await getTargetTab();
    setTarget(result.ok ? result.data : null);
    return result.ok ? result.data : null;
  }, []);

  useEffect(() => {
    void refreshTarget();
    const refresh = () => void refreshTarget();
    browser.tabs.onActivated.addListener(refresh);
    browser.tabs.onUpdated.addListener(refresh);
    return () => {
      browser.tabs.onActivated.removeListener(refresh);
      browser.tabs.onUpdated.removeListener(refresh);
      if (sessionTab.current !== null) void endSession(sessionTab.current);
    };
  }, [refreshTarget]);

  // Keep the list in sync with the page while a scan is on screen.
  const tabId = state.phase === 'done' ? state.scan.tabId : null;
  useEffect(() => {
    if (tabId === null) return;
    return onPageEvent(tabId, (event) => {
      if (event.type === 'FIELD_FOCUSED') {
        setFocusedId(event.id);
        document.getElementById(`row-${event.id}`)?.scrollIntoView({ block: 'nearest' });
        return;
      }
      setChanges({ added: event.added.length, removed: event.removed.length });
      setState((prev) => {
        if (prev.phase !== 'done') return prev;
        const gone = new Set(event.removed);
        const fields = [...prev.scan.fields.filter((f) => !gone.has(f.id)), ...event.added];
        return { phase: 'done', scan: { ...prev.scan, url: event.url, fields } };
      });
    });
  }, [tabId]);

  const scan = async () => {
    setState({ phase: 'scanning' });
    setChanges(null);
    setHighlighted(false);
    const tab = (await refreshTarget()) ?? target;
    if (!tab) {
      setState({
        phase: 'error',
        code: 'NO_TAB',
        message: 'Open the page with the form you want to fill.',
      });
      return;
    }
    if (sessionTab.current !== null) await endSession(sessionTab.current);
    const result = await scanTab(tab.tabId);
    if (!result.ok) {
      setState({ phase: 'error', ...result.error });
      return;
    }
    sessionTab.current = tab.tabId;
    setState({ phase: 'done', scan: result.data });
    await startObserving(tab.tabId);
  };

  const allowAndScan = async () => {
    if (await requestSiteAccess()) await scan();
  };

  const toggleHighlights = async () => {
    if (state.phase !== 'done') return;
    const items = highlighted
      ? []
      : state.scan.fields.map((f) => ({
          fieldId: f.id,
          state: classifyRisk(f).allowed ? ('input' as const) : ('denied' as const),
          title: f.label.slice(0, 200),
        }));
    const result = await highlightFields(state.scan.tabId, items);
    if (result.ok) setHighlighted(!highlighted);
  };

  return (
    <section className="mt-4 space-y-3" aria-labelledby="scanner-heading">
      <div className="flex items-center justify-between gap-2">
        <h2 id="scanner-heading" className="text-sm font-semibold">
          Scanner preview
        </h2>
        <span className="rounded bg-amber-100 px-1.5 py-0.5 text-[10px] font-medium text-amber-900 dark:bg-amber-900/40 dark:text-amber-200">
          dev
        </span>
      </div>
      <p className="truncate text-xs text-slate-500 dark:text-slate-400" data-testid="target">
        {target
          ? `Page: ${target.title ?? target.url ?? `tab ${target.tabId}`}`
          : 'No page selected'}
      </p>
      <div className="flex gap-2">
        <button
          type="button"
          onClick={() => void scan()}
          disabled={state.phase === 'scanning'}
          className="flex-1 rounded-md bg-emerald-700 px-3 py-2 text-sm font-medium text-white hover:bg-emerald-800 disabled:opacity-60"
        >
          {state.phase === 'scanning' ? 'Scanning…' : 'Scan this page'}
        </button>
        {state.phase === 'done' && (
          <button
            type="button"
            onClick={() => void toggleHighlights()}
            aria-pressed={highlighted}
            className="rounded-md border border-slate-300 px-3 py-2 text-sm font-medium hover:bg-slate-50 dark:border-slate-700 dark:hover:bg-slate-900"
          >
            {highlighted ? 'Clear highlights' : 'Highlight fields'}
          </button>
        )}
      </div>

      {state.phase === 'error' && (
        <div
          role="alert"
          className="rounded-md border border-red-300 bg-red-50 p-2 text-xs text-red-900 dark:border-red-800 dark:bg-red-950 dark:text-red-200"
        >
          <p>{state.message}</p>
          {state.code === 'NO_PERMISSION' && (
            <button
              type="button"
              onClick={() => void allowAndScan()}
              className="mt-2 rounded bg-red-800 px-2 py-1 text-white"
            >
              Allow Filler to read forms on websites
            </button>
          )}
        </div>
      )}

      {changes && (
        <p
          role="status"
          data-testid="changes"
          className="rounded-md bg-sky-50 px-2 py-1.5 text-xs text-sky-900 dark:bg-sky-950 dark:text-sky-200"
        >
          The page changed: {changes.added} new {changes.added === 1 ? 'field' : 'fields'},{' '}
          {changes.removed} went away.
        </p>
      )}

      {state.phase === 'done' && <ScanResults scan={state.scan} focusedId={focusedId} />}
    </section>
  );
}

function ScanResults({ scan, focusedId }: { scan: PageScan; focusedId: string | null }) {
  return (
    <div className="space-y-2">
      <p className="text-xs text-slate-600 dark:text-slate-300" data-testid="field-count">
        {scan.fields.length} {scan.fields.length === 1 ? 'field' : 'fields'}
        {scan.frames > 1 ? ` in ${scan.frames} frames` : ''}
      </p>
      {scan.errors.length > 0 && (
        <p className="text-xs text-amber-800 dark:text-amber-300">
          {scan.errors.length} field(s) could not be read.
        </p>
      )}
      <ul className="divide-y divide-slate-200 rounded-md border border-slate-200 dark:divide-slate-800 dark:border-slate-800">
        {scan.fields.map((field) => (
          <FieldRow key={field.id} field={field} focused={field.id === focusedId} />
        ))}
      </ul>
    </div>
  );
}

function FieldRow({ field, focused }: { field: FieldDescriptor; focused: boolean }) {
  const risk = classifyRisk(field);
  return (
    <li
      id={`row-${field.id}`}
      className={`px-2 py-1.5 text-xs ${focused ? 'bg-emerald-50 ring-2 ring-emerald-600 ring-inset dark:bg-emerald-950' : ''}`}
      data-testid="field-row"
      aria-current={focused || undefined}
    >
      <div className="flex items-start justify-between gap-2">
        <span className="break-words font-medium" data-testid="field-label">
          {field.label}
          {field.required && (
            <span className="text-red-600" aria-label="required">
              {' '}
              *
            </span>
          )}
        </span>
        <span className="shrink-0 rounded bg-slate-100 px-1 text-[10px] text-slate-600 dark:bg-slate-800 dark:text-slate-300">
          {field.inputType}
        </span>
      </div>
      <div className="mt-0.5 flex flex-wrap gap-x-2 text-[10px] text-slate-500 dark:text-slate-400">
        <span>from {field.labelSource}</span>
        {field.options && <span>{field.options.length} options</span>}
        {field.maxLength && <span>max {field.maxLength}</span>}
        {field.sectionHeading && <span className="truncate">in “{field.sectionHeading}”</span>}
        {field.frameId > 0 && <span>frame {field.frameId}</span>}
      </div>
      {!risk.allowed && (
        <p
          className="mt-0.5 text-[10px] font-medium text-red-700 dark:text-red-400"
          data-testid="field-denied"
        >
          Never filled: {risk.reason}
        </p>
      )}
    </li>
  );
}
