/**
 * Session history, re-use, summaries and profile tips in the panel
 * (PLAYBOOK Tasks 11.3–11.4). Values are masked unless they are public.
 */
import {
  sessionSummary,
  siteOf,
  type HistoryEntry,
  type PlanItem,
  type SessionState,
} from '@filler/core';
import { Badge, Banner, Button } from '@filler/ui';
import { ClipboardCopy, History as HistoryIcon, Lightbulb } from 'lucide-react';
import { useEffect, useState } from 'react';
import { call } from '@/src/messaging/client';
import { asText, mask, sensitivityOf } from '../format';
import { usePanel } from '../store';

const shown = (key: string | undefined, value: string) =>
  sensitivityOf(key) === 'public' ? value : mask(value);
const when = (iso: string) =>
  new Date(iso).toLocaleString('en-IN', {
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  });

function useHistory(site: string | null) {
  const [entries, setEntries] = useState<HistoryEntry[]>([]);
  useEffect(() => {
    if (!site) return;
    let alive = true;
    void call<HistoryEntry[]>({ type: 'HISTORY_LIST', site }).then((r) => {
      if (alive && r.ok) setEntries(r.data);
    });
    return () => {
      alive = false;
    };
  }, [site]);
  return entries;
}

/** "Your past sessions on this site", on the start screen. */
export function PastSessions({ url }: { url: string | undefined }) {
  const site = url?.startsWith('http') ? siteOf(url) : null;
  const entries = useHistory(site);
  if (!site || !entries.length) return null;
  return (
    <details
      className="rounded-md border border-slate-200 p-2 text-sm dark:border-slate-800"
      data-testid="history"
    >
      <summary className="cursor-pointer font-medium">
        <HistoryIcon aria-hidden className="mr-1 inline h-4 w-4" />
        Past sessions on {site} ({entries.length})
      </summary>
      <ul className="mt-2 space-y-2">
        {entries.map((h) => {
          const filled = h.items.filter((i) => i.status === 'filled');
          return (
            <li key={h.id} data-testid="history-entry">
              <p className="font-medium">{h.title || h.site}</p>
              <p className="text-xs text-slate-600 dark:text-slate-400">
                {when(h.endedAt)} · {filled.length} filled
                {h.goal ? ` · ${h.goal}` : ''}
              </p>
              <ul className="mt-1 space-y-0.5 text-xs">
                {filled.slice(0, 12).map((i) => (
                  <li key={i.signature}>
                    {i.label}:{' '}
                    <span data-testid="history-value">{shown(i.key, asText(i.value))}</span>
                  </li>
                ))}
              </ul>
            </li>
          );
        })}
      </ul>
    </details>
  );
}

/** Offers the answers from the last session on this site for fields still waiting. */
export function ReuseBanner({ session }: { session: SessionState }) {
  const entries = useHistory(session.site || null);
  const setSession = usePanel((s) => s.setSession);
  const [done, setDone] = useState(false);
  const last = entries.find((h) => h.id !== session.id);
  const waiting = session.plan.some(
    (p) => p.status === 'pending' && p.value === undefined && p.kind !== 'denied',
  );
  if (!last || !waiting || done) return null;
  return (
    <Banner
      tone="blue"
      data-testid="reuse"
      action={
        <Button
          size="sm"
          onClick={() =>
            void call<SessionState>({ type: 'HISTORY_REUSE', tabId: session.tabId }).then((r) => {
              if (r.ok) setSession(r.data);
              setDone(true);
            })
          }
        >
          Re-use them
        </Button>
      }
    >
      You filled this site on {when(last.endedAt)}. Use those answers where this page still needs
      one? You approve each one as usual.
    </Banner>
  );
}

/** Tips from the platform profile, and how it was recognised. */
export function ProfileTips({ session }: { session: SessionState }) {
  const p = session.profile;
  if (!p) return null;
  return (
    <details
      className="rounded-md border border-slate-200 p-2 text-sm dark:border-slate-800"
      data-testid="profile"
    >
      <summary className="cursor-pointer">
        <Lightbulb aria-hidden className="mr-1 inline h-4 w-4" />
        <span className="font-medium">Tips for {p.name}</span>{' '}
        <Badge tone="neutral">{p.by === 'host' ? 'this site' : 'looks like one'}</Badge>
      </summary>
      <ul className="mt-1 list-disc space-y-0.5 pl-5 text-xs" data-testid="profile-tips">
        {p.tips.map((t) => (
          <li key={t}>{t}</li>
        ))}
      </ul>
    </details>
  );
}

/** Copies a plain-text summary of the session (personal values masked). */
export function CopySummary({ session }: { session: SessionState }) {
  const [copied, setCopied] = useState(false);
  const show = (p: PlanItem) => shown(p.canonicalKey, asText(p.value));
  return (
    <Button
      size="sm"
      variant="ghost"
      onClick={() =>
        void navigator.clipboard.writeText(sessionSummary(session, show)).then(() => {
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        })
      }
    >
      <ClipboardCopy aria-hidden className="h-3.5 w-3.5" />
      {copied ? 'Copied' : 'Copy summary'}
    </Button>
  );
}
