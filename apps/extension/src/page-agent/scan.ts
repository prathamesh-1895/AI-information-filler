/**
 * Page scan: every visible control → a validated FieldDescriptor, plus the
 * frame-local registry that fill, observe and highlight look fields up in.
 * Runs inside each frame; the background worker merges frames.
 */
import { FieldDescriptorSchema, fieldSignature, type FieldDescriptor } from '@filler/core';
import {
  extractCurrentValue,
  extractMaxLength,
  extractOptions,
  isDisabled,
  isRequired,
} from './constraints';
import { discoverControls, isVisibleControl, type Control } from './discover';
import { collapse, documentBox, hasRequiredMarker } from './dom';
import {
  ControlIndex,
  resetHeadingCache,
  resolveHelpText,
  resolveLabel,
  resolveSectionHeading,
} from './label';
import { buildControlSelector, resolveSelector } from './selector';

export interface ScanResult {
  url: string;
  title: string;
  scannedAt: string;
  fields: FieldDescriptor[];
  /** Fields that could not be described (kept out of `fields`, reported for debugging). */
  errors: string[];
}

const HONEYPOT =
  /honey ?pot|\bhp\b|leave (?:this )?(?:field )?(?:blank|empty)|do not (?:fill|enter|change)|bot ?trap|anti ?spam/i;

export interface Entry {
  control: Control;
  descriptor: FieldDescriptor;
  /** Position among fields with the same signature, for re-finding duplicates. */
  ordinal: number;
}

const registry = new Map<string, Entry>();
let nextId = 0;

export const isNativeGroup = (c: Control) =>
  c.inputType === 'radio' || c.inputType === 'checkbox-group';

/** The element other code acts on: the first radio/checkbox of a native group, else the control. */
export const primary = (c: Control) => (isNativeGroup(c) ? (c.members[0] ?? c.element) : c.element);

const clip = (value: string | undefined, max: number) =>
  value === undefined ? undefined : value.slice(0, max);

function attr(el: Element, name: string): string | undefined {
  const value = el.getAttribute(name);
  return value === null || value === '' ? undefined : value;
}

async function describe(control: Control, index: ControlIndex, id: string) {
  const el = control.element;
  const first = control.members[0] ?? el;
  const resolved = resolveLabel(control, index);
  const name = attr(first, 'name');
  const domId = attr(first, 'id');
  if (HONEYPOT.test(`${resolved.label} ${name ?? ''} ${domId ?? ''}`)) return null;

  const label = resolved.label.slice(0, 2_000);
  const signature = await fieldSignature(location.href, {
    label,
    inputType: control.inputType,
    name,
  });
  const descriptor = {
    id,
    frameId: 0,
    selector: buildControlSelector(control).slice(0, 2_000),
    tag: el.localName,
    inputType: control.inputType,
    name: clip(name, 512),
    domId: clip(domId, 512),
    autocomplete: clip(attr(first, 'autocomplete'), 256),
    label,
    labelSource: resolved.source,
    placeholder: clip(attr(el, 'placeholder'), 2_000),
    helpText: clip(resolveHelpText(control, index, resolved.element), 4_000),
    sectionHeading: clip(resolveSectionHeading(control, label), 2_000),
    options: extractOptions(control)?.slice(0, 1_000),
    multiple:
      ['checkbox-group', 'aria-checkbox-group', 'select-multiple', 'tags'].includes(
        control.inputType,
      ) || undefined,
    required: isRequired(control, resolved.raw, hasRequiredMarker),
    maxLength: extractMaxLength(control, index),
    pattern: clip(attr(el, 'pattern'), 1_000),
    min: clip(attr(el, 'min'), 64),
    max: clip(attr(el, 'max'), 64),
    currentValue: extractCurrentValue(control),
    isVisible: true,
    isDisabled: isDisabled(control),
    bbox: documentBox(isNativeGroup(control) ? (first.closest('fieldset') ?? first) : el),
    signature,
  };
  // Drop undefined keys so the descriptor stays compact on the wire.
  for (const key of Object.keys(descriptor) as Array<keyof typeof descriptor>) {
    if (descriptor[key] === undefined) delete descriptor[key];
  }
  return FieldDescriptorSchema.safeParse(descriptor);
}

/**
 * Describes `targets` (a subset of `all`, which gives label resolution its
 * context), registers them and returns their descriptors.
 */
export async function describeControls(
  targets: Control[],
  all: Control[],
): Promise<{ fields: FieldDescriptor[]; errors: string[] }> {
  resetHeadingCache();
  const index = new ControlIndex(all);
  const fields: FieldDescriptor[] = [];
  const errors: string[] = [];
  const seenSignatures = new Map<string, number>();
  for (const control of targets) {
    const id = `f${nextId++}`;
    const result = await describe(control, index, id);
    if (result === null) continue;
    if (!result.success) {
      errors.push(
        `${control.inputType} "${collapse(control.element.getAttribute('aria-label'))}": ${result.error.issues[0]?.message ?? 'invalid'}`,
      );
      continue;
    }
    const ordinal = seenSignatures.get(result.data.signature) ?? 0;
    seenSignatures.set(result.data.signature, ordinal + 1);
    registry.set(id, { control, descriptor: result.data, ordinal });
    fields.push(result.data);
  }
  return { fields, errors };
}

/** Scans this frame's document. */
export async function scan(): Promise<ScanResult> {
  const controls = discoverControls(document).filter(isVisibleControl);
  const { fields, errors } = await describeControls(controls, controls);
  return {
    url: location.href,
    title: document.title,
    scannedAt: new Date().toISOString(),
    fields,
    errors,
  };
}

export function getEntry(id: string): Entry | undefined {
  return registry.get(id);
}

export function entries(): Array<[string, Entry]> {
  return Array.from(registry.entries());
}

export function forget(id: string): void {
  registry.delete(id);
}

const isLive = (c: Control) => primary(c).isConnected && c.members.every((m) => m.isConnected);

/**
 * Finds a scanned field's control again, even after the page re-rendered it:
 * live control → selector → same signature (and position) in a fresh discovery.
 */
export async function resolveControl(
  descriptor: Pick<FieldDescriptor, 'id' | 'selector' | 'signature'>,
): Promise<Control | null> {
  const entry = registry.get(descriptor.id);
  if (entry && isLive(entry.control)) return entry.control;

  const controls = discoverControls(document).filter(isVisibleControl);
  const bySelector = resolveSelector(descriptor.selector);
  if (bySelector) {
    const found = controls.find((c) => c.element === bySelector || c.members.includes(bySelector));
    if (found) {
      if (entry) entry.control = found;
      return found;
    }
  }

  const wanted = entry?.ordinal ?? 0;
  const index = new ControlIndex(controls);
  let seen = 0;
  for (const control of controls) {
    const label = resolveLabel(control, index).label;
    const name = attr(control.members[0] ?? control.element, 'name');
    const signature = await fieldSignature(location.href, {
      label,
      inputType: control.inputType,
      name,
    });
    if (signature !== descriptor.signature) continue;
    if (seen++ === wanted) {
      if (entry) entry.control = control;
      return control;
    }
  }
  return null;
}

export async function resolve(
  descriptor: Pick<FieldDescriptor, 'id' | 'selector' | 'signature'>,
): Promise<Element | null> {
  const control = await resolveControl(descriptor);
  return control ? primary(control) : null;
}
