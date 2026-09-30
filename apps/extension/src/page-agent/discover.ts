/**
 * Control discovery: finds every fillable control on the page (light DOM and
 * open shadow roots) and groups radios/checkboxes into single questions.
 */
import {
  ancestors,
  collectElements,
  hasSize,
  isAriaHidden,
  isOffscreen,
  isRendered,
  type Root,
} from './dom';

export interface Control {
  /** Element that represents the question: the input itself, or the group container / first member. */
  element: Element;
  /** Every element the user interacts with (radio buttons, checkboxes, options). */
  members: Element[];
  inputType: string;
  group: boolean;
}

const SELECTOR = [
  'input',
  'textarea',
  'select',
  '[contenteditable]',
  '[role="textbox"]',
  '[role="combobox"]',
  '[aria-haspopup="listbox"]',
  '[role="listbox"]',
  '[role="radio"]',
  '[role="checkbox"]',
  '[role="switch"]',
].join(', ');

const SKIPPED_INPUT_TYPES = new Set([
  'hidden',
  'submit',
  'button',
  'reset',
  'image',
  'range',
  'color',
]);
const TAG_CONTAINER =
  /(^|[\s_-])(tags?|chips?|tokens?)([\s_-]|$)|tag-?input|chip-?input|token-?input/i;
const CHECKBOX_CONTAINER = '[role="group"], [role="list"], [role="radiogroup"], fieldset';

const isNative = (el: Element) =>
  el instanceof HTMLInputElement ||
  el instanceof HTMLSelectElement ||
  el instanceof HTMLTextAreaElement;

function isTagInput(el: Element): boolean {
  let depth = 0;
  for (const a of ancestors(el)) {
    if (++depth > 3) break;
    if (TAG_CONTAINER.test(a.getAttribute('class') ?? '')) return true;
  }
  return false;
}

/** The container of a tag input (holds the chips), if any. */
export function tagContainer(el: Element): Element | null {
  let depth = 0;
  for (const a of ancestors(el)) {
    if (++depth > 3) break;
    if (TAG_CONTAINER.test(a.getAttribute('class') ?? '')) return a;
  }
  return null;
}

function comboboxPopupIds(root: Root): Set<string> {
  const ids = new Set<string>();
  root.querySelectorAll('[role="combobox"], [aria-haspopup="listbox"]').forEach((c) => {
    for (const attr of ['aria-controls', 'aria-owns']) {
      for (const id of (c.getAttribute(attr) ?? '').split(/\s+/)) if (id) ids.add(id);
    }
  });
  return ids;
}

export function discoverControls(root: Root = document): Control[] {
  const elements = collectElements(root, (el) => el.matches(SELECTOR));
  const controls: Control[] = [];
  const nativeRadio = new Map<string, Control>();
  const nativeCheckbox = new Map<string, Control>();
  const ariaRadio = new Map<Element, Control>();
  const ariaCheckbox = new Map<Element, Control>();
  const popupIdsByRoot = new Map<Root, Set<string>>();
  let anon = 0;
  const scopeIds = new WeakMap<object, number>();
  let scopes = 0;

  // Radios/checkboxes share a group when they share a name within the same form (or tree).
  const groupKey = (el: HTMLInputElement, name: string) => {
    const scope: object = el.form ?? el.getRootNode();
    let id = scopeIds.get(scope);
    if (id === undefined) scopeIds.set(scope, (id = scopes++));
    return `${id}|${name}`;
  };

  for (const el of elements) {
    if (el instanceof HTMLInputElement) {
      const type = el.type.toLowerCase();
      if (SKIPPED_INPUT_TYPES.has(type)) continue;
      if (type === 'radio' || type === 'checkbox') {
        const map = type === 'radio' ? nativeRadio : nativeCheckbox;
        const key = el.name ? groupKey(el, el.name) : `anon-${anon++}`;
        const existing = map.get(key);
        if (existing) existing.members.push(el);
        else {
          const control: Control = { element: el, members: [el], inputType: type, group: true };
          map.set(key, control);
          controls.push(control);
        }
        continue;
      }
      controls.push({
        element: el,
        members: [el],
        inputType: isTagInput(el) ? 'tags' : type,
        group: false,
      });
      continue;
    }
    if (el instanceof HTMLTextAreaElement) {
      controls.push({ element: el, members: [el], inputType: 'textarea', group: false });
      continue;
    }
    if (el instanceof HTMLSelectElement) {
      controls.push({
        element: el,
        members: [el],
        inputType: el.multiple ? 'select-multiple' : 'select-one',
        group: false,
      });
      continue;
    }

    // Non-native widgets.
    const role = el.getAttribute('role');
    if (el instanceof HTMLElement && el.isContentEditable) {
      if (el.parentElement?.isContentEditable) continue; // part of an outer editor
      controls.push({ element: el, members: [el], inputType: 'contenteditable', group: false });
      continue;
    }
    if (el.getAttribute('contenteditable') !== null && !role) continue; // contenteditable="false"
    if (role === 'textbox') {
      controls.push({ element: el, members: [el], inputType: 'aria-textbox', group: false });
      continue;
    }
    if (
      role === 'combobox' ||
      (el.getAttribute('aria-haspopup') === 'listbox' && role !== 'listbox')
    ) {
      controls.push({ element: el, members: [el], inputType: 'aria-combobox', group: false });
      continue;
    }
    if (role === 'listbox') {
      const r = el.getRootNode() as Root;
      if (!popupIdsByRoot.has(r)) popupIdsByRoot.set(r, comboboxPopupIds(r));
      const isPopup =
        (el.id && popupIdsByRoot.get(r)?.has(el.id)) || el.closest('[role="combobox"]');
      if (isPopup) continue;
      controls.push({ element: el, members: [el], inputType: 'aria-listbox', group: false });
      continue;
    }
    if (role === 'radio') {
      if (isNative(el)) continue;
      const container = el.closest('[role="radiogroup"]') ?? el.parentElement ?? el;
      const existing = ariaRadio.get(container);
      if (existing) existing.members.push(el);
      else {
        const control: Control = {
          element: container,
          members: [el],
          inputType: 'aria-radiogroup',
          group: true,
        };
        ariaRadio.set(container, control);
        controls.push(control);
      }
      continue;
    }
    if (role === 'checkbox' || role === 'switch') {
      if (isNative(el)) continue;
      const container = el.parentElement?.closest(CHECKBOX_CONTAINER) ?? el;
      const existing = ariaCheckbox.get(container);
      if (existing) existing.members.push(el);
      else {
        const control: Control = {
          element: container,
          members: [el],
          inputType: 'aria-checkbox-group',
          group: true,
        };
        ariaCheckbox.set(container, control);
        controls.push(control);
      }
    }
  }

  // Singles: a lone checkbox is a yes/no question, not a group.
  for (const control of controls) {
    if (control.inputType === 'checkbox') {
      if (control.members.length > 1) control.inputType = 'checkbox-group';
      else control.group = false;
    }
    if (control.inputType === 'aria-checkbox-group' && control.members.length === 1) {
      control.inputType = 'aria-checkbox';
      control.element = control.members[0]!;
      control.group = false;
    }
  }
  return controls;
}

function memberVisible(el: Element): boolean {
  if (isAriaHidden(el) || !isRendered(el)) return false;
  if (el instanceof HTMLInputElement && (el.type === 'radio' || el.type === 'checkbox')) {
    // Custom-styled boxes often hide the native input; its label is what users see.
    if (hasSize(el, 1) && !isOffscreen(el)) return true;
    return Array.from(el.labels ?? []).some((l) => isRendered(l) && hasSize(l) && !isOffscreen(l));
  }
  return hasSize(el) && !isOffscreen(el);
}

/** A control is visible if the user could see and use at least one of its members. */
export function isVisibleControl(control: Control): boolean {
  return control.members.some(memberVisible);
}
