/**
 * Label resolution: works out the human question each control asks, in the
 * priority order from PLAYBOOK Task 3.3, plus help text and section heading.
 */
import { humaniseIdentifier, isDynamicIdentifier, type LabelSource } from '@filler/core';
import type { Control } from './discover';
import {
  ancestors,
  byId,
  cleanLabel,
  collapse,
  collectElements,
  labelText,
  precedes,
  rawText,
} from './dom';

export interface ResolvedLabel {
  label: string;
  source: LabelSource;
  /** Label text before cleaning; used to spot "*" required markers. */
  raw: string;
  /** Element the label came from, so help-text search can skip it. */
  element?: Element;
}

const HEADINGISH =
  '[role="heading"], h1, h2, h3, h4, h5, h6, legend, label, [class*="label" i], [class*="question" i], [class*="title" i], [class*="lbl" i]';
const HELPISH =
  'small, [class*="help" i], [class*="hint" i], [class*="desc" i], [class*="note" i], [id*="help" i]';
const COUNTER_ONLY =
  /^(?:(?:at least|min\.?|minimum)\s*\d[\d,]*\s*characters?\s*[·•|-]?\s*)?\d[\d,]*\s*\/\s*\d[\d,]*$/i;

/** Lets label logic ask "how many controls live inside this element?" */
export class ControlIndex {
  private readonly members: Array<{ control: Control; el: Element }> = [];

  constructor(readonly controls: Control[]) {
    for (const control of controls) {
      this.members.push({ control, el: control.element });
      for (const m of control.members)
        if (m !== control.element) this.members.push({ control, el: m });
    }
  }

  /** Distinct controls with any element inside `container`. */
  countWithin(container: Element): number {
    const found = new Set<Control>();
    for (const { control, el } of this.members) if (container.contains(el)) found.add(control);
    return found.size;
  }

  groupsWithin(container: Element): number {
    const found = new Set<Control>();
    for (const { control, el } of this.members)
      if (control.group && container.contains(el)) found.add(control);
    return found.size;
  }

  containsAny(container: Element): boolean {
    return this.members.some(({ el }) => container !== el && container.contains(el));
  }
}

function fromLabelElements(el: Element): ResolvedLabel | null {
  const labels = (el as HTMLInputElement).labels;
  if (!labels) return null;
  for (const label of Array.from(labels)) {
    const text = labelText(label);
    if (text)
      return {
        label: text,
        raw: rawText(label),
        source: label.contains(el) ? 'label-wrap' : 'label-for',
        element: label,
      };
  }
  return null;
}

function fromAria(el: Element): ResolvedLabel | null {
  const ids = (el.getAttribute('aria-labelledby') ?? '').split(/\s+/).filter(Boolean);
  if (ids.length) {
    const parts = ids.map((id) => byId(el, id)).filter((n): n is Element => n !== null);
    const text = collapse(parts.map(labelText).join(' '));
    if (text)
      return {
        label: text,
        raw: collapse(parts.map(rawText).join(' ')),
        source: 'aria',
        element: parts[0],
      };
  }
  const aria = collapse(el.getAttribute('aria-label'));
  return aria ? { label: aria, raw: aria, source: 'aria' } : null;
}

/** A heading-like element inside the nearest ancestor that holds only this control. */
function fromContainer(el: Element, index: ControlIndex): ResolvedLabel | null {
  let depth = 0;
  for (const a of ancestors(el)) {
    if (++depth > 6 || a === el.ownerDocument.body) break;
    if (index.countWithin(a) > 1) break;
    let best: Element | null = null;
    for (const h of Array.from(a.querySelectorAll(HEADINGISH))) {
      if (h.contains(el) || index.containsAny(h) || !precedes(h, el)) continue;
      const text = labelText(h);
      if (text && text.length <= 200) best = h;
    }
    if (best)
      return { label: labelText(best), raw: rawText(best), source: 'container', element: best };
  }
  return null;
}

/** Nearest preceding text in the same row, climbing while the parent holds only this control. */
function fromProximity(el: Element, index: ControlIndex): ResolvedLabel | null {
  let cur: Element = el;
  for (let depth = 0; depth < 3; depth++) {
    for (let n = cur.previousSibling; n; n = n.previousSibling) {
      if (n.nodeType === Node.TEXT_NODE) {
        const text = collapse(n.textContent);
        if (text) return { label: text, raw: text, source: 'proximity' };
      } else if (n instanceof Element) {
        if (index.containsAny(n) || index.controls.some((c) => c.element === n)) return null;
        const text = labelText(n);
        if (text && text.length <= 120)
          return { label: text, raw: rawText(n), source: 'proximity', element: n };
      }
    }
    const parent = cur.parentElement;
    if (!parent || index.countWithin(parent) > 1) return null;
    cur = parent;
  }
  return null;
}

function fromPlaceholder(el: Element): ResolvedLabel | null {
  const text = collapse(
    el.getAttribute('placeholder') ??
      el.getAttribute('aria-placeholder') ??
      el.getAttribute('data-placeholder'),
  );
  return text ? { label: text, raw: text, source: 'placeholder' } : null;
}

function fromName(el: Element): ResolvedLabel | null {
  for (const attr of ['name', 'id']) {
    const value = el.getAttribute(attr);
    if (value && !isDynamicIdentifier(value)) {
      const text = humaniseIdentifier(value.replace(/\[\d*\]/g, ' '));
      if (text) return { label: text, raw: text, source: 'name' };
    }
  }
  return null;
}

/** Radio/checkbox groups: prefer the group's own label, then a fieldset legend that belongs to it alone. */
function fromGroup(control: Control, index: ControlIndex): ResolvedLabel | null {
  const first = control.members[0] ?? control.element;
  const radiogroup = control.element.matches('[role="radiogroup"], [role="group"], [role="list"]')
    ? control.element
    : first.closest('[role="radiogroup"], [role="group"]');
  const aria = radiogroup ? fromAria(radiogroup) : null;
  if (aria) return aria;
  for (const a of ancestors(first)) {
    if (index.countWithin(a) > 1) break;
    if (a instanceof HTMLFieldSetElement) {
      const legend = a.querySelector(':scope > legend');
      const text = legend ? labelText(legend) : '';
      if (legend && text)
        return { label: text, raw: rawText(legend), source: 'container', element: legend };
    }
  }
  return fromContainer(control.element, index) ?? fromProximity(control.element, index);
}

/**
 * Google-Forms-style grids: each row is a radiogroup labelled only by its
 * row name ("Communication"). Prefix the question heading so the label
 * still makes sense on its own ("Rate yourself: Communication").
 */
function withGridQuestion(
  control: Control,
  resolved: ResolvedLabel,
  index: ControlIndex,
): ResolvedLabel {
  if (
    resolved.source !== 'aria' ||
    !control.group ||
    control.element.hasAttribute('aria-labelledby')
  )
    return resolved;
  let depth = 0;
  for (const a of ancestors(control.element)) {
    if (++depth > 6) break;
    if (index.groupsWithin(a) < 2) continue;
    const heading = Array.from(
      a.querySelectorAll('[role="heading"], h1, h2, h3, h4, h5, h6, legend'),
    ).find((h) => !index.containsAny(h) && precedes(h, control.element));
    if (heading) {
      const question = cleanLabel(labelText(heading));
      if (question && question !== resolved.label)
        return { ...resolved, label: `${question}: ${resolved.label}` };
    }
    break;
  }
  return resolved;
}

export function resolveLabel(control: Control, index: ControlIndex): ResolvedLabel {
  const el = control.element;
  let resolved: ResolvedLabel | null;
  if (control.group) {
    resolved = fromGroup(control, index) ?? fromName(control.members[0] ?? el);
  } else {
    resolved =
      fromLabelElements(el) ??
      fromAria(el) ??
      fromContainer(el, index) ??
      fromProximity(el, index) ??
      fromPlaceholder(el) ??
      (control.inputType === 'aria-combobox' ? comboboxText(el) : null) ??
      fromName(el);
  }
  resolved ??= { label: control.inputType, raw: control.inputType, source: 'name' };
  resolved = { ...resolved, label: cleanLabel(resolved.label) || resolved.label };
  return withGridQuestion(control, resolved, index);
}

function comboboxText(el: Element): ResolvedLabel | null {
  const text = collapse(el.textContent);
  return text && text.length <= 120 ? { label: text, raw: text, source: 'placeholder' } : null;
}

/** Help text: aria-describedby first, then hint-like elements that belong to this control only. */
export function resolveHelpText(
  control: Control,
  index: ControlIndex,
  labelElement?: Element,
): string | undefined {
  const el = control.element;
  const ids = (el.getAttribute('aria-describedby') ?? '').split(/\s+/).filter(Boolean);
  if (ids.length) {
    const text = collapse(
      ids
        .map((id) => byId(el, id))
        .map((n) => (n ? labelText(n) : ''))
        .join(' '),
    );
    if (text) return text;
  }
  let depth = 0;
  for (const a of ancestors(el)) {
    if (++depth > 3 || index.countWithin(a) > 1) break;
    const texts: string[] = [];
    for (const h of Array.from(a.querySelectorAll(HELPISH))) {
      if (h === labelElement || h.contains(el) || index.containsAny(h)) continue;
      if (labelElement?.contains(h)) continue;
      const text = labelText(h);
      if (text && !COUNTER_ONLY.test(text) && !texts.includes(text)) texts.push(text);
    }
    if (texts.length) return texts.join(' ');
  }
  return undefined;
}

let headingCache: { doc: Document; list: Element[] } | null = null;

function headings(doc: Document): Element[] {
  if (headingCache?.doc !== doc)
    headingCache = { doc, list: collectElements(doc, (e) => /^h[1-4]$/.test(e.localName)) };
  return headingCache.list;
}

export function resetHeadingCache(): void {
  headingCache = null;
}

/** Nearest enclosing fieldset legend / labelled group, else the nearest preceding h1–h4. */
export function resolveSectionHeading(control: Control, label: string): string | undefined {
  const el = control.members[0] ?? control.element;
  for (const a of ancestors(el)) {
    if (a instanceof HTMLFieldSetElement) {
      const legend = a.querySelector(':scope > legend');
      const text = legend ? cleanLabel(labelText(legend)) : '';
      if (text && text !== label) return text;
    } else if (a.matches('[role="group"], [role="region"]') && a !== control.element) {
      const text = cleanLabel(fromAria(a)?.label ?? '');
      if (text && text !== label) return text;
    }
  }
  // Outermost light-DOM anchor for elements inside shadow roots.
  let anchor: Element = el;
  for (let root = anchor.getRootNode(); root instanceof ShadowRoot; root = anchor.getRootNode())
    anchor = root.host;
  let best: string | undefined;
  for (const h of headings(el.ownerDocument)) {
    if (!precedes(h, anchor)) break;
    const text = cleanLabel(labelText(h));
    if (text && text !== label) best = text;
  }
  return best;
}
