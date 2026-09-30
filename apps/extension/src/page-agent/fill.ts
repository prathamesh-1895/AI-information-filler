/**
 * Fill primitives (PLAYBOOK Tasks 4.1–4.2): write a value into one control
 * the way a person would, then read it back and verify.
 *
 * Safety is enforced here, at the lowest level, regardless of what the caller
 * asked for: denied fields (policy), password and file inputs are refused.
 */
import {
  classifyRisk,
  formatIsoDate,
  matchOption,
  normaliseLabel,
  parseLooseDate,
  type FieldOption,
} from '@filler/core';
import { extractCurrentValue, extractOptions, rawCurrentValue } from './constraints';
import { tagContainer, type Control } from './discover';
import { byId, collapse } from './dom';
import {
  blur,
  fire,
  focus,
  humanClick,
  pasteValue,
  pressKey,
  setNativeValue,
  sleep,
  typeValue,
  waitFor,
} from './events';
import { getEntry, resolveControl } from './scan';

export interface FillItem {
  /** Frame-local field id from the scan (`f3`). */
  id: string;
  selector: string;
  signature: string;
  value: string | string[];
  /** `typing` forces key-by-key input; `auto` pastes first and types on retry. */
  mode?: 'auto' | 'typing';
}

export interface FillResult {
  id: string;
  status: 'filled' | 'failed';
  /** Value read back from the page (sensitive values redacted). */
  finalValue?: string | string[];
  error?: string;
  /** How the value got in: `paste`, `typing`, `click`, `select`, `editor`. */
  method?: string;
}

class FillError extends Error {}

const TEXT_TYPES = new Set(['text', 'email', 'tel', 'url', 'search', 'number', 'textarea']);
const DATE_TYPES = new Set(['date', 'month', 'datetime-local', 'week', 'time']);
const TRUE = /^(?:true|yes|y|checked|on|1|agree|accept)$/i;
const FALSE = /^(?:false|no|n|unchecked|off|0)$/i;

const asText = (v: string | string[]) => (Array.isArray(v) ? v.join(', ') : v);
const asList = (v: string | string[]) =>
  (Array.isArray(v) ? v : v.split(/\s*[,;\n]\s*/)).map((s) => s.trim()).filter(Boolean);
const sameText = (a: string, b: string) =>
  a.replace(/\r\n/g, '\n').trim() === b.replace(/\r\n/g, '\n').trim();

function available(options: FieldOption[] | undefined): string {
  const list = (options ?? []).map((o) => o.text);
  return list.length
    ? ` Available: ${list.slice(0, 12).join(', ')}${list.length > 12 ? ', …' : ''}.`
    : '';
}

function pickOption(options: FieldOption[] | undefined, target: string): number {
  const match = options ? matchOption(options, target) : null;
  if (!match || !options)
    throw new FillError(`Option not found: "${target}".${available(options)}`);
  return options.indexOf(match.option);
}

function toBool(value: string | string[]): boolean {
  const v = asText(value).trim();
  if (TRUE.test(v)) return true;
  if (FALSE.test(v)) return false;
  throw new FillError(`"${v}" is not a yes/no answer for a checkbox.`);
}

// ------------------------------------------------------------------ text-like

async function fillText(
  control: Control,
  value: string,
  mode: 'auto' | 'typing',
  maxLength?: number,
): Promise<string> {
  const el = control.element as HTMLInputElement | HTMLTextAreaElement;
  if (maxLength && value.length > maxLength) {
    throw new FillError(
      `The text is ${value.length} characters but this field allows ${maxLength}. Shorten it before filling.`,
    );
  }
  const matches = () => {
    const now = el.value;
    return control.inputType === 'number' ? Number(now) === Number(value) : sameText(now, value);
  };
  if (mode === 'auto') {
    pasteValue(el, value);
    await sleep(40);
    if (matches()) {
      await pickAutocomplete(el, value);
      return 'paste';
    }
  }
  typeValue(el, value);
  await sleep(40);
  if (matches()) {
    await pickAutocomplete(el, value);
    return 'typing';
  }
  throw new FillError(
    `The site did not accept the value (it now shows "${collapse(el.value).slice(0, 60)}").`,
  );
}

/** Native inputs with role=combobox (autocomplete): pick the suggestion that matches exactly, if one appears. */
async function pickAutocomplete(
  el: HTMLInputElement | HTMLTextAreaElement,
  value: string,
): Promise<void> {
  if (el.getAttribute('role') !== 'combobox' && !el.hasAttribute('aria-autocomplete')) return;
  const listbox = await waitFor(() => popupFor(el), 400);
  if (!listbox) return;
  const option = findOptionElement(listbox, value);
  if (option) humanClick(option);
}

async function fillDate(control: Control, value: string): Promise<string> {
  const el = control.element as HTMLInputElement;
  let formatted = value;
  if (control.inputType === 'date' || control.inputType === 'month') {
    const parsed = parseLooseDate(value);
    if (!parsed) throw new FillError(`"${value}" is not a date Filler understands.`);
    if (control.inputType === 'date' && parsed.day === undefined) {
      throw new FillError(`This field needs a full date (day, month and year); got "${value}".`);
    }
    formatted = formatIsoDate(
      control.inputType === 'month' ? { year: parsed.year, month: parsed.month } : parsed,
    );
  }
  pasteValue(el, formatted);
  await sleep(20);
  if (el.value !== formatted)
    throw new FillError(`The site did not accept the date "${formatted}".`);
  return 'paste';
}

async function fillEditor(control: Control, value: string): Promise<string> {
  const el = control.element as HTMLElement;
  const matches = () => sameText(el.innerText, value);
  focus(el);
  el.innerText = value;
  fire(el, 'input', value);
  blur(el);
  await sleep(40);
  if (matches()) return 'editor';
  // Last resort for rich editors that ignore direct DOM edits (PLAYBOOK §Phase 4 "Avoid").
  focus(el);
  const selection = el.ownerDocument.getSelection();
  selection?.selectAllChildren(el);
  // execCommand is deprecated, but it is the only input path some rich editors honour.
  el.ownerDocument.execCommand('insertText', false, value);
  blur(el);
  await sleep(40);
  if (matches()) return 'editor';
  throw new FillError('The editor did not accept the text.');
}

// -------------------------------------------------------------------- choices

function setSelectValue(select: HTMLSelectElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')?.set;
  focus(select);
  if (setter) setter.call(select, value);
  else select.value = value;
  fire(select, 'input');
  fire(select, 'change');
  blur(select);
}

async function fillSelect(control: Control, value: string | string[]): Promise<string> {
  const select = control.element as HTMLSelectElement;
  const options = extractOptions(control);
  if (control.inputType === 'select-multiple') {
    const wanted = new Set(asList(value).map((t) => options![pickOption(options, t)]!.value));
    focus(select);
    for (const option of Array.from(select.options)) option.selected = wanted.has(option.value);
    fire(select, 'input');
    fire(select, 'change');
    blur(select);
    const selected = new Set(Array.from(select.selectedOptions).map((o) => o.value));
    if ([...wanted].some((v) => !selected.has(v)))
      throw new FillError('The site did not keep the selection.');
    return 'select';
  }
  const target = options![pickOption(options, asText(value))]!.value;
  setSelectValue(select, target);
  await sleep(20);
  if (select.value !== target) throw new FillError('The site did not keep the selection.');
  return 'select';
}

const isOn = (el: Element) =>
  el instanceof HTMLInputElement ? el.checked : el.getAttribute('aria-checked') === 'true';

async function fillSingleChoice(control: Control, value: string): Promise<string> {
  const options = extractOptions(control);
  const member = control.members[pickOption(options, value)];
  if (!member) throw new FillError('That option is no longer on the page.');
  if (!isOn(member)) humanClick(member);
  if (!(await waitFor(() => isOn(member), 800)))
    throw new FillError('The site did not select that option.');
  return 'click';
}

async function fillMultiChoice(control: Control, value: string | string[]): Promise<string> {
  const options = extractOptions(control);
  const wanted = new Set(asList(value).map((t) => pickOption(options, t)));
  for (const [i, member] of control.members.entries()) {
    if (isOn(member) !== wanted.has(i)) humanClick(member);
  }
  const ok = await waitFor(() => control.members.every((m, i) => isOn(m) === wanted.has(i)), 800);
  if (!ok) throw new FillError('The site did not keep every selected option.');
  return 'click';
}

async function fillCheckbox(control: Control, value: string | string[]): Promise<string> {
  const want = toBool(value);
  if (isOn(control.element) !== want) humanClick(control.element);
  if (!(await waitFor(() => isOn(control.element) === want || null, 800))) {
    throw new FillError('The site did not change the checkbox.');
  }
  return 'click';
}

function optionElements(listbox: Element): Element[] {
  return Array.from(listbox.querySelectorAll('[role="option"]')).filter(
    (o) => o.getAttribute('aria-disabled') !== 'true',
  );
}

function findOptionElement(listbox: Element, target: string): Element | null {
  const elements = optionElements(listbox);
  const options = elements.map((o) => ({
    value:
      o.getAttribute('data-value') ??
      (collapse(o.getAttribute('aria-label')) || collapse(o.textContent)),
    text: collapse(o.getAttribute('aria-label')) || collapse(o.textContent),
  }));
  const match = matchOption(options, target);
  return match ? (elements[options.indexOf(match.option)] ?? null) : null;
}

/** The popup listbox a combobox controls, once it is in the DOM and visible. */
function popupFor(el: Element): Element | null {
  for (const attr of ['aria-controls', 'aria-owns']) {
    for (const id of (el.getAttribute(attr) ?? '').split(/\s+/)) {
      const found = id ? byId(el, id) : null;
      if (found?.matches('[role="listbox"]')) return found;
      const inner = found?.querySelector('[role="listbox"]');
      if (inner) return inner;
    }
  }
  const inside = el.querySelector('[role="listbox"]');
  return inside && optionElements(inside).length ? inside : null;
}

async function fillListbox(control: Control, value: string): Promise<string> {
  const listbox = control.element;
  const option = findOptionElement(listbox, value);
  if (!option)
    throw new FillError(`Option not found: "${value}".${available(extractOptions(control))}`);
  if (listbox.getAttribute('aria-expanded') === 'false') {
    humanClick(listbox);
    await waitFor(() => listbox.getAttribute('aria-expanded') !== 'false', 500);
  }
  humanClick(option);
  if (!(await waitFor(() => option.getAttribute('aria-selected') === 'true', 800))) {
    throw new FillError('The site did not select that option.');
  }
  return 'click';
}

async function fillCombobox(control: Control, value: string): Promise<string> {
  const el = control.element;
  humanClick(el);
  const listbox = await waitFor(() => popupFor(el), 1_500);
  if (!listbox) throw new FillError('The dropdown did not open.');
  let option = findOptionElement(listbox, value);
  if (!option) {
    // Typeahead fallback: type into the search box the dropdown opened.
    const search =
      el.querySelector('input') ??
      (el.ownerDocument.activeElement instanceof HTMLInputElement
        ? el.ownerDocument.activeElement
        : null);
    if (search) {
      typeValue(search, value);
      option = await waitFor(() => findOptionElement(popupFor(el) ?? listbox, value), 1_500);
    }
  }
  if (!option) {
    const texts = optionElements(listbox).map((o) => collapse(o.textContent));
    pressKey(el, 'Escape');
    throw new FillError(
      `Option not found: "${value}".${texts.length ? ` Available: ${texts.slice(0, 12).join(', ')}.` : ''}`,
    );
  }
  const optionText = collapse(option.textContent);
  humanClick(option);
  const ok = await waitFor(
    () =>
      normaliseLabel(el.textContent ?? '').includes(normaliseLabel(optionText)) ||
      option!.getAttribute('aria-selected') === 'true',
    1_000,
  );
  if (!ok) throw new FillError('The site did not select that option.');
  return 'click';
}

async function fillTags(control: Control, value: string | string[]): Promise<string> {
  const input = control.element as HTMLInputElement;
  const wanted = asList(value);
  const current = () => {
    const v = rawCurrentValue(control);
    return new Set((Array.isArray(v) ? v : v ? [v] : []).map(normaliseLabel));
  };
  for (const item of wanted) {
    if (current().has(normaliseLabel(item))) continue;
    focus(input);
    setNativeValue(input, item);
    fire(input, 'input', item);
    pressKey(input, 'Enter');
    if (!(await waitFor(() => current().has(normaliseLabel(item)), 400))) {
      pressKey(input, ','); // some tag inputs commit on comma
      await waitFor(() => current().has(normaliseLabel(item)), 300);
    }
  }
  blur(input);
  const missing = wanted.filter((w) => !current().has(normaliseLabel(w)));
  if (missing.length) throw new FillError(`The site did not accept: ${missing.join(', ')}.`);
  if (!tagContainer(input)) throw new FillError('Tag list not found.');
  return 'typing';
}

// ------------------------------------------------------------------- dispatch

async function fillControl(control: Control, item: FillItem, maxLength?: number): Promise<string> {
  const { value } = item;
  const mode = item.mode ?? 'auto';
  switch (control.inputType) {
    case 'password':
      throw new FillError('Passwords are never filled by Filler. Type it yourself.');
    case 'file':
      throw new FillError('Filler never attaches files. Attach it yourself.');
    case 'select-one':
    case 'select-multiple':
      return fillSelect(control, value);
    case 'radio':
    case 'aria-radiogroup':
      return fillSingleChoice(control, asText(value));
    case 'checkbox-group':
    case 'aria-checkbox-group':
      return fillMultiChoice(control, value);
    case 'checkbox':
    case 'aria-checkbox':
      return fillCheckbox(control, value);
    case 'aria-listbox':
      return fillListbox(control, asText(value));
    case 'aria-combobox':
      return fillCombobox(control, asText(value));
    case 'tags':
      return fillTags(control, value);
    case 'contenteditable':
    case 'aria-textbox':
      return fillEditor(control, asText(value));
    default:
      if (DATE_TYPES.has(control.inputType)) return fillDate(control, asText(value));
      if (TEXT_TYPES.has(control.inputType))
        return fillText(control, asText(value), mode, maxLength);
      throw new FillError(`Filler cannot fill "${control.inputType}" fields yet.`);
  }
}

export async function fillOne(item: FillItem): Promise<FillResult> {
  const entry = getEntry(item.id);
  if (!entry)
    return {
      id: item.id,
      status: 'failed',
      error: 'This field was not scanned on this page. Scan again.',
    };
  let control: Control | null;
  try {
    control = await resolveControl(item);
  } catch {
    control = null;
  }
  if (!control)
    return { id: item.id, status: 'failed', error: 'The field is no longer on the page.' };

  // Policy is re-checked on the live field: never trust the caller.
  const risk = classifyRisk({
    ...entry.descriptor,
    inputType: control.inputType,
    currentValue: extractCurrentValue(control),
  });
  if (!risk.allowed) return { id: item.id, status: 'failed', error: risk.reason };
  const el = control.element as HTMLInputElement;
  if (el.disabled || el.getAttribute('aria-disabled') === 'true' || el.readOnly) {
    return { id: item.id, status: 'failed', error: 'The field is disabled or read-only.' };
  }

  try {
    const method = await fillControl(control, item, entry.descriptor.maxLength);
    const finalValue = extractCurrentValue(control);
    return {
      id: item.id,
      status: 'filled',
      method,
      ...(finalValue !== undefined ? { finalValue } : {}),
    };
  } catch (error) {
    const finalValue = extractCurrentValue(control);
    return {
      id: item.id,
      status: 'failed',
      error:
        error instanceof FillError
          ? error.message
          : `Unexpected problem: ${error instanceof Error ? error.message : String(error)}`,
      ...(finalValue !== undefined ? { finalValue } : {}),
    };
  }
}

/** Fills items one after another (order matters for dependent fields). Never throws. */
export async function fill(items: FillItem[]): Promise<FillResult[]> {
  const results: FillResult[] = [];
  for (const item of items) results.push(await fillOne(item));
  return results;
}
