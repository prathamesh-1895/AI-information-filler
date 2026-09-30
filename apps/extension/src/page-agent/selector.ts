/**
 * Robust selectors that survive re-renders: stable id → stable name →
 * aria-label → short structural path from the nearest stable-id ancestor.
 * Shadow-DOM hops are joined with " >>> ".
 */
import { isDynamicIdentifier } from '@filler/core';
import { rootOf, type Root } from './dom';
import type { Control } from './discover';

const SHADOW_HOP = ' >>> ';

function unique(root: Root, selector: string, el: Element): boolean {
  try {
    const found = root.querySelectorAll(selector);
    return found.length === 1 && found[0] === el;
  } catch {
    return false;
  }
}

function localSelector(el: Element, root: Root): string {
  const tag = el.localName;
  const id = el.id;
  if (id && !isDynamicIdentifier(id) && unique(root, `#${CSS.escape(id)}`, el))
    return `#${CSS.escape(id)}`;
  const name = el.getAttribute('name');
  if (name && !isDynamicIdentifier(name)) {
    const s = `${tag}[name="${CSS.escape(name)}"]`;
    if (unique(root, s, el)) return s;
  }
  const aria = el.getAttribute('aria-label');
  if (aria) {
    const s = `${tag}[aria-label="${CSS.escape(aria)}"]`;
    if (unique(root, s, el)) return s;
  }
  const parts: string[] = [];
  let cur: Element | null = el;
  while (cur) {
    if (
      cur !== el &&
      cur.id &&
      !isDynamicIdentifier(cur.id) &&
      unique(root, `#${CSS.escape(cur.id)}`, cur)
    ) {
      parts.unshift(`#${CSS.escape(cur.id)}`);
      break;
    }
    const parent: Element | null = cur.parentElement;
    const siblings = parent
      ? Array.from(parent.children).filter((c) => c.localName === cur!.localName)
      : [cur];
    parts.unshift(`${cur.localName}:nth-of-type(${siblings.indexOf(cur) + 1})`);
    cur = parent;
  }
  return parts.join(' > ');
}

export function buildSelector(el: Element): string {
  const root = rootOf(el);
  const local = localSelector(el, root);
  return root instanceof ShadowRoot ? `${buildSelector(root.host)}${SHADOW_HOP}${local}` : local;
}

/** Selector for a whole control. Native radio/checkbox groups with a stable name use the name. */
export function buildControlSelector(control: Control): string {
  const first = control.members[0];
  if ((control.inputType === 'radio' || control.inputType === 'checkbox-group') && first) {
    const name = first.getAttribute('name');
    if (name && !isDynamicIdentifier(name)) {
      const root = rootOf(first);
      const local = `input[type="${(first as HTMLInputElement).type}"][name="${CSS.escape(name)}"]`;
      return root instanceof ShadowRoot
        ? `${buildSelector(root.host)}${SHADOW_HOP}${local}`
        : local;
    }
    return buildSelector(first);
  }
  return buildSelector(control.element);
}

export function resolveSelector(selector: string, doc: Document = document): Element | null {
  let scope: Root = doc;
  let el: Element | null = null;
  const parts = selector.split(SHADOW_HOP);
  for (let i = 0; i < parts.length; i++) {
    try {
      el = scope.querySelector(parts[i]!);
    } catch {
      return null;
    }
    if (!el) return null;
    if (i < parts.length - 1) {
      if (!el.shadowRoot) return null;
      scope = el.shadowRoot;
    }
  }
  return el;
}
