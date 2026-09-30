/**
 * Low-level input simulation. Values are written the way a person's typing
 * would reach the page, so React/Vue/Angular state stays in sync.
 */

type TextControl = HTMLInputElement | HTMLTextAreaElement;

/**
 * Sets `.value` through the prototype's native setter. Frameworks like React
 * wrap the instance setter to track values; going through the prototype makes
 * the following `input` event register as a real change.
 */
export function setNativeValue(el: TextControl, value: string): void {
  const proto =
    el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
  if (setter) setter.call(el, value);
  else el.value = value;
}

export function fire(
  el: Element,
  type: 'input' | 'change' | 'blur' | 'focus',
  data?: string,
): void {
  if (type === 'input') {
    el.dispatchEvent(
      new InputEvent('input', {
        bubbles: true,
        composed: true,
        inputType: 'insertText',
        ...(data !== undefined ? { data } : {}),
      }),
    );
  } else if (type === 'change') {
    el.dispatchEvent(new Event('change', { bubbles: true }));
  } else {
    el.dispatchEvent(new FocusEvent(type, { bubbles: false }));
  }
}

export function focus(el: Element): void {
  (el as HTMLElement).focus?.({ preventScroll: true });
}

export function blur(el: Element): void {
  (el as HTMLElement).blur?.();
}

function key(el: Element, type: 'keydown' | 'keypress' | 'keyup', k: string): boolean {
  const code =
    k.length === 1
      ? /[a-z]/i.test(k)
        ? `Key${k.toUpperCase()}`
        : /\d/.test(k)
          ? `Digit${k}`
          : ''
      : k;
  return el.dispatchEvent(
    new KeyboardEvent(type, {
      key: k,
      code,
      bubbles: true,
      cancelable: true,
      composed: true,
      keyCode: k === 'Enter' ? 13 : k.charCodeAt(0),
    }),
  );
}

export function pressKey(el: Element, k: string): void {
  key(el, 'keydown', k);
  key(el, 'keypress', k);
  key(el, 'keyup', k);
}

/** Replaces the value "fast": one native set + input + change. */
export function pasteValue(el: TextControl, value: string): void {
  focus(el);
  setNativeValue(el, value);
  fire(el, 'input', value);
  fire(el, 'change');
  blur(el);
}

/** Types character by character with key events, for sites that only listen to the keyboard. */
export function typeValue(el: TextControl, value: string): void {
  focus(el);
  setNativeValue(el, '');
  fire(el, 'input');
  let current = '';
  for (const ch of value) {
    const proceed = key(el, 'keydown', ch);
    key(el, 'keypress', ch);
    if (proceed) {
      current += ch;
      setNativeValue(el, current);
      fire(el, 'input', ch);
    }
    key(el, 'keyup', ch);
  }
  fire(el, 'change');
  blur(el);
}

/** A full pointer + mouse click sequence; many widgets listen to pointerdown/mousedown, not click. */
export function humanClick(el: Element): void {
  const rect = el.getBoundingClientRect();
  const init = {
    bubbles: true,
    cancelable: true,
    composed: true,
    clientX: rect.left + rect.width / 2,
    clientY: rect.top + rect.height / 2,
    button: 0,
  };
  el.dispatchEvent(
    new PointerEvent('pointerdown', { ...init, pointerType: 'mouse', isPrimary: true }),
  );
  el.dispatchEvent(new MouseEvent('mousedown', init));
  focus(el);
  el.dispatchEvent(
    new PointerEvent('pointerup', { ...init, pointerType: 'mouse', isPrimary: true }),
  );
  el.dispatchEvent(new MouseEvent('mouseup', init));
  if (el instanceof HTMLElement) el.click();
  else el.dispatchEvent(new MouseEvent('click', init));
}

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Polls `check` every animation frame-ish until it returns a value or the timeout passes. */
export async function waitFor<T>(
  check: () => T | null | undefined | false,
  timeoutMs = 1_500,
): Promise<T | null> {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const value = check();
    if (value) return value;
    if (Date.now() > end) return null;
    await sleep(30);
  }
}
