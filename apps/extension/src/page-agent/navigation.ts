/**
 * Wizard navigation (PLAYBOOK Task 4.3). Filler may click "Next"-style
 * buttons after the user approved a page. Anything that could commit
 * (submit, pay, publish, …) is refused here, in code, whatever the caller asks.
 */
import { isSubmitLike } from '@filler/core';
import { collapse, collectElements, hasSize, isAriaHidden, isRendered } from './dom';
import { humanClick } from './events';

export interface NavButton {
  id: string;
  text: string;
  submitLike: boolean;
}

const BUTTONS =
  'button, input[type="submit"], input[type="button"], [role="button"], a[role="button"]';

const buttons = new Map<string, Element>();
let nextId = 0;

function describeButton(el: Element) {
  const text = collapse(
    el instanceof HTMLInputElement ? el.value : (el as HTMLElement).innerText || el.textContent,
  );
  return {
    text,
    submitLike: isSubmitLike({
      text,
      type: el.getAttribute('type') ?? undefined,
      ariaLabel: el.getAttribute('aria-label') ?? undefined,
      title: el.getAttribute('title') ?? undefined,
    }),
  };
}

/** Visible, enabled buttons in this frame, each classified as navigation or submit-like. */
export function listNavigation(): NavButton[] {
  buttons.clear();
  const found = collectElements(document, (el) => el.matches(BUTTONS)).filter(
    (el) =>
      isRendered(el) &&
      hasSize(el) &&
      !isAriaHidden(el) &&
      !(el as HTMLButtonElement).disabled &&
      el.getAttribute('aria-disabled') !== 'true',
  );
  return found.map((el) => {
    const id = `b${nextId++}`;
    buttons.set(id, el);
    return { id, ...describeButton(el) };
  });
}

export type ClickResult = { ok: true } | { ok: false; error: string };

export function clickNavigation(id: string): ClickResult {
  const el = buttons.get(id);
  if (!el || !el.isConnected) return { ok: false, error: 'That button is no longer on the page.' };
  // Re-classify the live button: its text may have changed since it was listed.
  const { text, submitLike } = describeButton(el);
  if (submitLike) {
    return {
      ok: false,
      error: `Filler never clicks "${text || 'this button'}". Review the page and click it yourself.`,
    };
  }
  humanClick(el);
  return { ok: true };
}
