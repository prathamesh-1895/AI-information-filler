/** DOM helpers shared by the scanner. Everything here is read-only. */

export type Root = Document | ShadowRoot;

/** Elements Filler's own overlay adds (Phase 4); never scanned. */
export const OVERLAY_ATTR = 'data-filler-overlay';

/** Ancestors of an element, crossing shadow-root boundaries into the host. */
export function* ancestors(el: Element): Generator<Element> {
  let node: Node | null = el.parentNode;
  while (node) {
    if (node instanceof ShadowRoot) node = node.host;
    if (!(node instanceof Element)) return;
    yield node;
    node = node.parentNode;
  }
}

/** Walks `root` in tree order, descending into open shadow roots where they occur. */
export function collectElements(
  root: Root,
  matches: (el: Element) => boolean,
  out: Element[] = [],
): Element[] {
  const doc = root instanceof Document ? root : root.ownerDocument;
  const walker = doc.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const el = node as Element;
    if (el.hasAttribute(OVERLAY_ATTR)) continue;
    if (matches(el)) out.push(el);
    if (el.shadowRoot) collectElements(el.shadowRoot, matches, out);
  }
  return out;
}

export function rootOf(el: Element): Root {
  const root = el.getRootNode();
  return root instanceof ShadowRoot ? root : el.ownerDocument;
}

export function byId(el: Element, id: string): Element | null {
  return rootOf(el).getElementById(id);
}

export function collapse(text: string | null | undefined): string {
  return (text ?? '').replace(/\s+/g, ' ').trim();
}

const CONTROL_TAGS =
  'input, select, textarea, button, [role="listbox"], [role="combobox"], [role="radio"], [role="checkbox"], [contenteditable]';
const NOISE = 'script, style, template, noscript, small, sup, [aria-hidden="true"]';

/**
 * Human-readable text of a label-like element, without the text of controls
 * nested in it (e.g. a <select>'s options inside its <label>) and without
 * badges such as "<small>Private</small>".
 */
export function labelText(el: Element): string {
  const clone = el.cloneNode(true) as Element;
  clone.querySelectorAll(`${CONTROL_TAGS}, ${NOISE}`).forEach((n) => n.remove());
  return collapse(clone.textContent);
}

/** Raw text including small/asterisk markers; used to detect "required" hints. */
export function rawText(el: Element): string {
  const clone = el.cloneNode(true) as Element;
  clone.querySelectorAll(CONTROL_TAGS).forEach((n) => n.remove());
  return collapse(clone.textContent);
}

/** Removes required markers and trailing colons: "Full name *:" → "Full name". */
export function cleanLabel(text: string): string {
  return collapse(text)
    .replace(/^[*\s]+/, '')
    .replace(/[\s*:：]+$/u, '')
    .replace(/\s*\*\s*$/, '')
    .trim();
}

export function hasRequiredMarker(text: string): boolean {
  return /(^|\s)\*(\s|$)|\*\s*:?\s*$/.test(text);
}

export function isAriaHidden(el: Element): boolean {
  if (el.getAttribute('aria-hidden') === 'true') return true;
  for (const a of ancestors(el)) if (a.getAttribute('aria-hidden') === 'true') return true;
  return false;
}

/** Rendered and not hidden by CSS (display/visibility/content-visibility). Opacity is ignored on purpose. */
export function isRendered(el: Element): boolean {
  if (typeof el.checkVisibility === 'function') {
    return el.checkVisibility({ visibilityProperty: true, contentVisibilityAuto: true });
  }
  const style = getComputedStyle(el);
  return (
    style.display !== 'none' &&
    style.visibility !== 'hidden' &&
    (el as HTMLElement).offsetParent !== null
  );
}

/** Positioned completely outside the page (a classic honeypot trick). */
export function isOffscreen(el: Element): boolean {
  const r = el.getBoundingClientRect();
  const doc = el.ownerDocument.documentElement;
  const left = r.left + window.scrollX;
  const top = r.top + window.scrollY;
  return (
    left + r.width <= 0 ||
    top + r.height <= 0 ||
    left >= Math.max(doc.scrollWidth, window.innerWidth)
  );
}

export function hasSize(el: Element, min = 2): boolean {
  const r = el.getBoundingClientRect();
  return r.width >= min && r.height >= min;
}

export function documentBox(el: Element): { x: number; y: number; width: number; height: number } {
  const r = el.getBoundingClientRect();
  return {
    x: Math.round(r.left + window.scrollX),
    y: Math.round(r.top + window.scrollY),
    width: Math.round(r.width),
    height: Math.round(r.height),
  };
}

/** True if `a` comes before `b` in document order (both in the same tree). */
export function precedes(a: Node, b: Node): boolean {
  return Boolean(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);
}
