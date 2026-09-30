/** Options, constraints and current values of a control (PLAYBOOK Task 3.4). */
import { detectSensitiveValue, redactedValue, type FieldOption } from '@filler/core';
import type { Control } from './discover';
import { tagContainer } from './discover';
import { ancestors, byId, collapse, labelText } from './dom';
import type { ControlIndex } from './label';

const TEXTLIKE = new Set([
  'text',
  'textarea',
  'contenteditable',
  'aria-textbox',
  'email',
  'url',
  'tel',
  'search',
  'tags',
]);

function optionLabel(el: Element): string {
  const labels = (el as HTMLInputElement).labels;
  const fromLabel = labels?.length ? labelText(labels[0]!) : '';
  return (
    fromLabel ||
    collapse(el.getAttribute('aria-label')) ||
    collapse(el.textContent) ||
    (el as HTMLInputElement).value
  );
}

function ariaOptionValue(el: Element): string {
  return (
    el.getAttribute('data-value') ??
    (collapse(el.getAttribute('aria-label')) || collapse(el.textContent))
  );
}

function ariaOptionText(el: Element): string {
  return collapse(el.getAttribute('aria-label')) || collapse(el.textContent);
}

function listboxOptions(listbox: Element): FieldOption[] {
  return Array.from(listbox.querySelectorAll('[role="option"]'))
    .filter((o) => o.getAttribute('aria-disabled') !== 'true' && ariaOptionValue(o) !== '')
    .map((o) => ({ value: ariaOptionValue(o), text: ariaOptionText(o) }));
}

export function extractOptions(control: Control): FieldOption[] | undefined {
  const el = control.element;
  switch (control.inputType) {
    case 'select-one':
    case 'select-multiple':
      return Array.from((el as HTMLSelectElement).options)
        .filter((o) => o.value !== '')
        .map((o) => ({ value: o.value, text: collapse(o.text) }));
    case 'radio':
    case 'checkbox-group':
      return control.members.map((m) => ({
        value: (m as HTMLInputElement).value,
        text: optionLabel(m),
      }));
    case 'aria-radiogroup':
    case 'aria-checkbox-group':
      return control.members.map((m) => ({ value: ariaOptionValue(m), text: ariaOptionText(m) }));
    case 'aria-listbox':
      return listboxOptions(el);
    case 'aria-combobox': {
      const id = el.getAttribute('aria-controls') ?? el.getAttribute('aria-owns');
      const listbox = id ? byId(el, id) : null;
      const options = listbox ? listboxOptions(listbox) : [];
      return options.length ? options : undefined;
    }
    default:
      return undefined;
  }
}

function parseCount(text: string): number {
  return Number(text.replace(/,/g, ''));
}

/** Finds a max length in on-page counters: "0/5000", "0 / 70", "Maximum 70 characters". */
export function maxLengthFromText(text: string): number | undefined {
  for (const m of text.matchAll(/(\d[\d,]*)\s*\/\s*(\d[\d,]*)(?!\s*\/)/g)) {
    const current = parseCount(m[1] ?? '');
    const max = parseCount(m[2] ?? '');
    if (max >= 10 && current <= max) return max;
  }
  const words =
    /(?:max(?:imum)?\.?|up to|limit(?:ed)? to)\s*(\d[\d,]*)\s*(?:characters|chars)\b|(\d[\d,]*)\s*(?:characters|chars)\s*(?:max(?:imum)?|limit)\b/i.exec(
      text,
    );
  const value = words ? parseCount(words[1] ?? words[2] ?? '') : NaN;
  return Number.isFinite(value) && value > 0 ? value : undefined;
}

export function extractMaxLength(control: Control, index: ControlIndex): number | undefined {
  const el = control.element;
  const attr = (el as HTMLInputElement).maxLength;
  if (typeof attr === 'number' && attr > 0) return attr;
  const ariaMax = Number(el.getAttribute('aria-valuemax') ?? el.getAttribute('data-maxlength'));
  if (ariaMax > 0) return ariaMax;
  if (!TEXTLIKE.has(control.inputType)) return undefined;
  let depth = 0;
  for (const a of ancestors(el)) {
    if (++depth > 3 || index.countWithin(a) > 1) break;
    const found = maxLengthFromText(labelText(a));
    if (found) return found;
  }
  return undefined;
}

export function isRequired(
  control: Control,
  rawLabel: string,
  hasMarker: (t: string) => boolean,
): boolean {
  const els = [control.element, ...control.members];
  if (
    els.some(
      (e) =>
        (e as HTMLInputElement).required === true || e.getAttribute('aria-required') === 'true',
    )
  )
    return true;
  return hasMarker(rawLabel);
}

export function isDisabled(control: Control): boolean {
  const el = control.element;
  if ((el as HTMLInputElement).disabled === true || el.getAttribute('aria-disabled') === 'true')
    return true;
  return (
    control.members.length > 0 &&
    control.members.every(
      (m) =>
        (m as HTMLInputElement).disabled === true || m.getAttribute('aria-disabled') === 'true',
    )
  );
}

function rawCurrentValue(control: Control): string | string[] | undefined {
  const el = control.element;
  switch (control.inputType) {
    case 'password':
    case 'file':
      return undefined; // never read
    case 'select-one': {
      const v = (el as HTMLSelectElement).value;
      return v || undefined;
    }
    case 'select-multiple': {
      const v = Array.from((el as HTMLSelectElement).selectedOptions)
        .map((o) => o.value)
        .filter(Boolean);
      return v.length ? v : undefined;
    }
    case 'radio':
      return control.members.map((m) => m as HTMLInputElement).find((m) => m.checked)?.value;
    case 'checkbox-group': {
      const v = control.members
        .map((m) => m as HTMLInputElement)
        .filter((m) => m.checked)
        .map((m) => m.value);
      return v.length ? v : undefined;
    }
    case 'checkbox':
      return (el as HTMLInputElement).checked ? 'checked' : undefined;
    case 'aria-checkbox':
      return el.getAttribute('aria-checked') === 'true' ? 'checked' : undefined;
    case 'aria-radiogroup': {
      const on = control.members.find((m) => m.getAttribute('aria-checked') === 'true');
      return on ? ariaOptionValue(on) : undefined;
    }
    case 'aria-checkbox-group': {
      const v = control.members
        .filter((m) => m.getAttribute('aria-checked') === 'true')
        .map(ariaOptionValue);
      return v.length ? v : undefined;
    }
    case 'aria-listbox': {
      const on = el.querySelector('[role="option"][aria-selected="true"]');
      const v = on ? ariaOptionValue(on) : '';
      return v || undefined;
    }
    case 'aria-combobox':
      return undefined; // visible text is usually a placeholder ("Select occupation")
    case 'contenteditable':
    case 'aria-textbox':
      return collapse((el as HTMLElement).innerText) || undefined;
    case 'tags': {
      const container = tagContainer(el);
      const chips = container
        ? Array.from(container.querySelectorAll('*'))
            .filter((n) => n !== el && n.children.length === 0 && !(n instanceof HTMLInputElement))
            .map((n) => collapse(n.textContent))
            .filter(Boolean)
        : [];
      return chips.length ? chips : undefined;
    }
    default: {
      const v = (el as HTMLInputElement).value;
      return v || undefined;
    }
  }
}

/** Current value, with sensitive values replaced so they never leave the page. */
export function extractCurrentValue(control: Control): string | string[] | undefined {
  const value = rawCurrentValue(control);
  const redact = (v: string) => {
    const category = detectSensitiveValue(v);
    return category ? redactedValue(category) : v.slice(0, 2_000);
  };
  if (value === undefined) return undefined;
  return Array.isArray(value) ? value.map(redact) : redact(value);
}
