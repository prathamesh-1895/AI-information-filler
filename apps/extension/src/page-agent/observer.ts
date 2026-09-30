/**
 * Watches the page during a session (PLAYBOOK Task 4.3): new fields (next
 * wizard step, "Add another" modal, conditional questions), fields that went
 * away, and URL changes in single-page apps. Changes are debounced and
 * reported as a diff, never as a full rescan.
 */
import type { FieldDescriptor } from '@filler/core';
import { discoverControls, isVisibleControl } from './discover';
import { OVERLAY_ATTR } from './dom';
import { describeControls, entries, forget, primary } from './scan';

export interface FieldsChanged {
  type: 'FIELDS_CHANGED';
  reason: 'mutation' | 'navigation';
  url: string;
  added: FieldDescriptor[];
  /** Frame-local ids of fields that disappeared or became hidden. */
  removed: string[];
}

export type ChangeListener = (change: FieldsChanged) => void;

const DEBOUNCE_MS = 250;
const URL_POLL_MS = 500;

let observer: MutationObserver | null = null;
let timer: ReturnType<typeof setTimeout> | null = null;
let urlTimer: ReturnType<typeof setInterval> | null = null;
let lastUrl = '';
let pendingReason: FieldsChanged['reason'] = 'mutation';
let listener: ChangeListener | null = null;
let running = Promise.resolve();
let cleanupUrl: (() => void) | null = null;

/** Sends changes to the extension (isolated world), or to a local listener (tests). */
function defaultListener(change: FieldsChanged): void {
  const runtime = (
    globalThis as {
      chrome?: { runtime?: { id?: string; sendMessage?: (m: unknown) => Promise<unknown> } };
    }
  ).chrome?.runtime;
  if (runtime?.id && runtime.sendMessage) void runtime.sendMessage(change).catch(() => undefined);
}

async function diff(reason: FieldsChanged['reason']): Promise<void> {
  const visible = discoverControls(document).filter(isVisibleControl);
  const known = new Map<Element, string>();
  for (const [id, entry] of entries()) known.set(primary(entry.control), id);

  const visiblePrimaries = new Set(visible.map(primary));
  const removed: string[] = [];
  for (const [el, id] of known) {
    if (!el.isConnected || !visiblePrimaries.has(el)) {
      removed.push(id);
      forget(id);
    }
  }
  const fresh = visible.filter((c) => !known.has(primary(c)) || !primary(c).isConnected);
  const { fields: added } = await describeControls(fresh, visible);
  if (added.length || removed.length) {
    listener?.({ type: 'FIELDS_CHANGED', reason, url: location.href, added, removed });
  }
}

function schedule(reason: FieldsChanged['reason']): void {
  if (reason === 'navigation') pendingReason = 'navigation';
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => {
    const r = pendingReason;
    pendingReason = 'mutation';
    running = running.then(() => diff(r)).catch(() => undefined);
  }, DEBOUNCE_MS);
}

/** True when every record is about Filler's own overlay (so the page itself did not change). */
function isOwnMutation(records: MutationRecord[]): boolean {
  return records.every((r) => {
    const target = r.target instanceof Element ? r.target : r.target.parentElement;
    if (target?.closest(`[${OVERLAY_ATTR}]`)) return true;
    if (r.type !== 'childList') return false;
    const nodes = [...r.addedNodes, ...r.removedNodes];
    return (
      nodes.length > 0 && nodes.every((n) => n instanceof Element && n.hasAttribute(OVERLAY_ATTR))
    );
  });
}

export function observe(onChange?: ChangeListener): void {
  stopObserving();
  listener = onChange ?? defaultListener;
  lastUrl = location.href;
  observer = new MutationObserver((records) => {
    if (!isOwnMutation(records)) schedule('mutation');
  });
  observer.observe(document.documentElement, {
    subtree: true,
    childList: true,
    attributes: true,
    attributeFilter: [
      'hidden',
      'style',
      'class',
      'aria-hidden',
      'aria-expanded',
      'disabled',
      'open',
    ],
  });
  // SPA navigations don't fire load events; history changes in the page's own
  // world are invisible to an isolated-world patch, so poll the URL as well.
  const checkUrl = () => {
    if (location.href !== lastUrl) {
      lastUrl = location.href;
      schedule('navigation');
    }
  };
  window.addEventListener('popstate', checkUrl);
  window.addEventListener('hashchange', checkUrl);
  urlTimer = setInterval(checkUrl, URL_POLL_MS);
  cleanupUrl = () => {
    window.removeEventListener('popstate', checkUrl);
    window.removeEventListener('hashchange', checkUrl);
  };
}

export function stopObserving(): void {
  observer?.disconnect();
  observer = null;
  if (timer) clearTimeout(timer);
  if (urlTimer) clearInterval(urlTimer);
  timer = null;
  urlTimer = null;
  cleanupUrl?.();
  cleanupUrl = null;
  listener = null;
}

export function isObserving(): boolean {
  return observer !== null;
}
