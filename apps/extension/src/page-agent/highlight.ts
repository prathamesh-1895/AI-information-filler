/**
 * Highlighter overlay (PLAYBOOK Task 4.4). Outlines each planned field with
 * its state, shows a tooltip on hover and reports clicks/focus on a
 * highlighted field so the panel can scroll to its row.
 *
 * The overlay lives in its own shadow root (page CSS cannot reach it) and
 * uses `pointer-events: none` everywhere, so it never blocks the page.
 */
import type { Control } from './discover';
import { OVERLAY_ATTR, isRendered } from './dom';
import { getEntry, isNativeGroup } from './scan';

export const HIGHLIGHT_STATES = ['vault', 'ai', 'input', 'denied', 'filled', 'failed'] as const;
export type HighlightState = (typeof HIGHLIGHT_STATES)[number];

export interface HighlightItem {
  /** Frame-local field id. */
  id: string;
  state: HighlightState;
  /** Tooltip heading, e.g. "From your vault: Email". */
  title?: string;
  /** Value preview, already masked by the caller for personal data. */
  preview?: string;
}

export interface FieldFocused {
  type: 'FIELD_FOCUSED';
  id: string;
}

const BADGE: Record<HighlightState, string> = {
  vault: 'Vault',
  ai: 'AI draft',
  input: 'Needs you',
  denied: 'Never filled',
  filled: '✓ Filled',
  failed: '! Failed',
};

const STYLE = `
:host { all: initial; }
.layer { position: absolute; top: 0; left: 0; width: 0; height: 0; pointer-events: none; z-index: 2147483646; }
.box { position: absolute; box-sizing: border-box; border: 2px solid var(--c); border-radius: 4px;
  background: color-mix(in srgb, var(--c) 8%, transparent); pointer-events: none; transition: opacity .15s; }
.box[hidden] { display: none; }
.badge { position: absolute; top: -9px; right: 4px; /* labels sit top-left; keep them readable */ font: 600 10px/14px system-ui, sans-serif; color: #fff;
  background: var(--c); padding: 0 5px; border-radius: 7px; white-space: nowrap; pointer-events: none; }
.vault { --c: #15803d; } .ai { --c: #b45309; } .input { --c: #1d4ed8; }
.denied { --c: #b91c1c; } .filled { --c: #475569; } .failed { --c: #9f1239; }
.tip { position: fixed; max-width: 280px; font: 12px/1.4 system-ui, sans-serif; color: #0f172a; background: #fff;
  border: 1px solid #cbd5e1; border-radius: 6px; padding: 6px 8px; box-shadow: 0 4px 16px rgba(15,23,42,.18);
  pointer-events: none; z-index: 2147483647; }
.tip[hidden] { display: none; }
.tip b { display: block; margin-bottom: 2px; }
.tip span { color: #475569; word-break: break-word; }
`;

interface Shown {
  item: HighlightItem;
  control: Control;
  box: HTMLDivElement;
}

let host: HTMLElement | null = null;
let layer: HTMLDivElement | null = null;
let tip: HTMLDivElement | null = null;
let shown: Shown[] = [];
let frame = 0;
let interval: ReturnType<typeof setInterval> | null = null;
let focusListener: ((e: FieldFocused) => void) | null = null;

function defaultFocusListener(event: FieldFocused): void {
  const runtime = (
    globalThis as {
      chrome?: { runtime?: { id?: string; sendMessage?: (m: unknown) => Promise<unknown> } };
    }
  ).chrome?.runtime;
  if (runtime?.id && runtime.sendMessage) void runtime.sendMessage(event).catch(() => undefined);
}

function targets(control: Control): Element[] {
  if (!isNativeGroup(control)) return [control.element];
  const fieldset = control.members[0]?.closest('fieldset');
  if (fieldset) return [fieldset];
  return control.members.flatMap((m) => [m, ...Array.from((m as HTMLInputElement).labels ?? [])]);
}

/** Union rectangle of the control's visible parts, in document coordinates. */
function rectOf(control: Control): DOMRect | null {
  const rects = targets(control)
    .filter((el) => el.isConnected && isRendered(el))
    .map((el) => el.getBoundingClientRect())
    .filter((r) => r.width > 0 && r.height > 0);
  if (!rects.length) return null;
  const left = Math.min(...rects.map((r) => r.left));
  const top = Math.min(...rects.map((r) => r.top));
  const right = Math.max(...rects.map((r) => r.right));
  const bottom = Math.max(...rects.map((r) => r.bottom));
  return new DOMRect(
    left + window.scrollX - 3,
    top + window.scrollY - 3,
    right - left + 6,
    bottom - top + 6,
  );
}

function position(): void {
  frame = 0;
  for (const s of shown) {
    const r = rectOf(s.control);
    s.box.hidden = r === null;
    if (!r) continue;
    Object.assign(s.box.style, {
      left: `${r.x}px`,
      top: `${r.y}px`,
      width: `${r.width}px`,
      height: `${r.height}px`,
    });
  }
}

const schedule = () => {
  if (!frame) frame = requestAnimationFrame(position);
};

function owning(target: EventTarget | null): Shown | undefined {
  if (!(target instanceof Node)) return undefined;
  return shown.find(
    (s) =>
      targets(s.control).some((t) => t.contains(target)) ||
      s.control.members.some((m) => m.contains(target)),
  );
}

function onPointerMove(e: MouseEvent): void {
  if (!tip) return;
  const hit = owning(e.target);
  if (!hit || (!hit.item.title && !hit.item.preview)) {
    tip.hidden = true;
    return;
  }
  tip.replaceChildren();
  const b = document.createElement('b');
  b.textContent = hit.item.title ?? BADGE[hit.item.state];
  tip.append(b);
  if (hit.item.preview) {
    const span = document.createElement('span');
    span.textContent = hit.item.preview;
    tip.append(span);
  }
  tip.hidden = false;
  const x = Math.min(e.clientX + 12, window.innerWidth - 290);
  const y = Math.min(e.clientY + 16, window.innerHeight - 60);
  Object.assign(tip.style, { left: `${Math.max(4, x)}px`, top: `${Math.max(4, y)}px` });
}

function onFocus(e: Event): void {
  const hit = owning(e.target);
  if (hit) focusListener?.({ type: 'FIELD_FOCUSED', id: hit.item.id });
}

function mount(): void {
  if (host?.isConnected) return;
  host = document.createElement('div');
  host.setAttribute(OVERLAY_ATTR, '');
  Object.assign(host.style, {
    position: 'absolute',
    top: '0',
    left: '0',
    width: '0',
    height: '0',
    overflow: 'visible',
    pointerEvents: 'none',
  });
  const root = host.attachShadow({ mode: 'open' });
  const style = document.createElement('style');
  style.textContent = STYLE;
  layer = document.createElement('div');
  layer.className = 'layer';
  tip = document.createElement('div');
  tip.className = 'tip';
  tip.hidden = true;
  root.append(style, layer, tip);
  document.documentElement.append(host);
  window.addEventListener('scroll', schedule, { capture: true, passive: true });
  window.addEventListener('resize', schedule, { passive: true });
  document.addEventListener('mousemove', onPointerMove, { capture: true, passive: true });
  document.addEventListener('focusin', onFocus, true);
  document.addEventListener('click', onFocus, true);
  interval = setInterval(position, 500); // catch layout shifts nobody announces
}

/** Shows (or replaces) highlights. Returns ids that could not be found on the page. */
export function highlight(
  items: HighlightItem[],
  onFieldFocused?: (e: FieldFocused) => void,
): { shown: number; missing: string[] } {
  mount();
  focusListener = onFieldFocused ?? defaultFocusListener;
  layer!.replaceChildren();
  shown = [];
  const missing: string[] = [];
  for (const item of items) {
    const entry = getEntry(item.id);
    if (!entry || !entry.control.element.isConnected) {
      missing.push(item.id);
      continue;
    }
    const box = document.createElement('div');
    box.className = `box ${item.state}`;
    box.dataset.id = item.id;
    const badge = document.createElement('span');
    badge.className = 'badge';
    badge.textContent = BADGE[item.state];
    box.append(badge);
    layer!.append(box);
    shown.push({ item, control: entry.control, box });
  }
  position();
  return { shown: shown.length, missing };
}

export function clearHighlights(): void {
  window.removeEventListener('scroll', schedule, { capture: true });
  window.removeEventListener('resize', schedule);
  document.removeEventListener('mousemove', onPointerMove, { capture: true });
  document.removeEventListener('focusin', onFocus, true);
  document.removeEventListener('click', onFocus, true);
  if (interval) clearInterval(interval);
  if (frame) cancelAnimationFrame(frame);
  interval = null;
  frame = 0;
  host?.remove();
  host = layer = tip = null;
  shown = [];
  focusListener = null;
}
