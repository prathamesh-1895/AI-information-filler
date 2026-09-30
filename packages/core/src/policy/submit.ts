/**
 * Decides whether a button would commit something (submit, pay, publish).
 * Filler may only ever click buttons this returns `false` for, and only after
 * the user approved the page. Anything ambiguous is treated as submit-like.
 */
import { normaliseLabel } from '../text/normalise';

export interface ButtonLike {
  /** Visible text of the button. */
  text: string;
  /** `type` attribute, if any (`submit`, `button`, `reset`). */
  type?: string | undefined;
  ariaLabel?: string | undefined;
  /** `value` attribute of `<input type="submit">`. */
  value?: string | undefined;
  title?: string | undefined;
}

/** Any of these words anywhere in the button text means "commits something". */
const COMMIT_WORDS =
  /\b(?:submit|submission|pay|payment|checkout|check out|buy|purchase|order|publish|post|send|apply|confirm|finish|finalize|finalise|complete|register|sign up|signup|sign in|log in|login|create account|create profile|go live|launch|accept|agree|delete|remove|done|book|subscribe|donate|transfer|withdraw|upload|request|claim|verify|redeem|enroll|enrol|join)\b/;

/**
 * Pure navigation inside a multi-step flow, matched against the whole
 * normalised text. Cancel/close/edit are deliberately absent: they can
 * discard the user's work, so Filler never clicks them either.
 */
const NAVIGATION_ONLY =
  /^(?:(?:save and )?(?:next|continue|proceed)(?: step| page| section)?|save and next|(?:go )?back|previous|prev|skip(?: for now| this step)?|add(?: another| more| new)?(?: [\p{L}\p{N}]+)?|show more|see more|load more)$/u;

function textOf(button: ButtonLike): string {
  const raw =
    [button.text, button.value, button.ariaLabel, button.title].find((t) => t?.trim()) ?? '';
  // normaliseLabel strips punctuation; spell out '&' first so "Save & Continue" survives.
  return normaliseLabel(raw.replace(/&/g, ' and '));
}

export function isSubmitLike(button: ButtonLike): boolean {
  const text = textOf(button);
  if (!text) return true; // An unlabelled button is unknowable: never click it.
  if (COMMIT_WORDS.test(text)) return true;
  return !NAVIGATION_ONLY.test(text);
}
