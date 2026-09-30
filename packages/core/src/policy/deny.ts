/**
 * Deny-list: field types Filler never fills and values it never stores.
 * The hard-core categories below are enforced in code and cannot be removed
 * by user configuration; users may only add extra patterns.
 */
import { humaniseIdentifier, normaliseLabel } from '../text/normalise';

export const DENIED_CATEGORIES = [
  'password',
  'otp',
  'card_number',
  'card_security_code',
  'card_expiry',
  'bank_account',
  'upi_pin',
  'passport',
  'aadhaar',
  'pan',
  'ssn',
  'government_id',
  'security_question',
  'captcha',
  'user_rule',
] as const;
export type DeniedCategory = (typeof DENIED_CATEGORIES)[number];

export type RiskResult =
  { allowed: true } | { allowed: false; category: DeniedCategory; reason: string };

/** The subset of a FieldDescriptor the policy looks at. */
export interface PolicyField {
  inputType: string;
  label: string;
  name?: string | undefined;
  domId?: string | undefined;
  autocomplete?: string | undefined;
  placeholder?: string | undefined;
  sectionHeading?: string | undefined;
  currentValue?: string | string[] | undefined;
}

const REASONS: Record<DeniedCategory, string> = {
  password: 'Passwords are never filled by Filler. Type it yourself.',
  otp: 'One-time and verification codes are never filled by Filler.',
  card_number: 'Card numbers are never stored or filled by Filler.',
  card_security_code: 'Card security codes (CVV/CVC) are never stored or filled.',
  card_expiry: 'Card expiry dates are never stored or filled.',
  bank_account: 'Bank account details are never stored or filled.',
  upi_pin: 'UPI/ATM PINs are never stored or filled.',
  passport: 'Passport details are never stored or filled.',
  aadhaar: 'Aadhaar numbers are never stored or filled.',
  pan: 'PAN numbers are never stored or filled.',
  ssn: 'Social Security numbers are never stored or filled.',
  government_id: 'Government ID numbers are never stored or filled.',
  security_question: 'Security questions and answers are never stored or filled.',
  captcha: 'CAPTCHAs must be completed by you.',
  user_rule: 'You asked Filler never to fill this kind of field.',
};

const DENIED_AUTOCOMPLETE: Array<[RegExp, DeniedCategory]> = [
  [/\b(?:new|current)-password\b/, 'password'],
  [/\bone-time-code\b/, 'otp'],
  [/\bcc-number\b/, 'card_number'],
  [/\bcc-csc\b/, 'card_security_code'],
  [/\bcc-exp(?:-month|-year)?\b/, 'card_expiry'],
];

/** Label/name patterns, matched against normalised text. Order matters: first match wins. */
const DENIED_TEXT: Array<[RegExp, DeniedCategory]> = [
  [/\bcaptcha\b|\bi m not a robot\b|\bim not a robot\b/, 'captcha'],
  [/\b(?:security|secret) (?:question|answer)\b|\bmothers maiden name\b/, 'security_question'],
  [
    /\b(?:upi|atm|card|debit card|mpin|m pin|t pin|tpin|transaction) pin\b|\bmpin\b|\btpin\b/,
    'upi_pin',
  ],
  [
    /\b(?:otp|one time (?:password|passcode|code|pin)|verification code|auth(?:entication)? code|2fa|two factor|sms code|confirmation code)\b/,
    'otp',
  ],
  [/\b(?:password|passwd|pwd|passcode|pass phrase|passphrase)\b|पासवर्ड/, 'password'],
  // Identity documents come before card/bank rules: "Aadhar card no" and
  // "Permanent account number" must report as IDs, not as card/bank numbers.
  [/\bpassport\b|पासपोर्ट/, 'passport'],
  [/\b(?:aadhaar|aadhar|adhaar|adhar|uidai)\b|\buid (?:no|number)\b|आधार/, 'aadhaar'],
  [/\bpan\b(?! india\b)|\bpermanent account number\b|पैन/, 'pan'],
  [/\b(?:ssn|social security)\b/, 'ssn'],
  [
    /\b(?:national id|national identity|voter id|epic (?:no|number)|driving licen[cs]e|drivers? licen[cs]e|dl (?:no|number)|tax id|tax identification|itin|ein)\b/,
    'government_id',
  ],
  [
    /\b(?:cvv2?|cvc2?|csc|card verification|card security code|security code)\b/,
    'card_security_code',
  ],
  [
    /\b(?:credit|debit|atm|card)(?: card)? (?:no|num|number)\b|\bcc (?:no|num|number)\b|\bccnum\b|\bcard num\b|\bcardnumber\b/,
    'card_number',
  ],
  [
    /\b(?:bank )?(?:account|acct|a c|ac) (?:no|num|number)\b|\baccount number\b|\biban\b|\bifsc\b|\bifsc code\b|\b(?:routing|sort|swift|bic) (?:code|number|no)\b|खाता संख्या|\bkhata (?:sankhya|number)\b/,
    'bank_account',
  ],
];

const EXPIRY = /\b(?:expiry|expiration|exp|valid thru|valid through|expires)\b/;
const CARD_CONTEXT = /\b(?:card|cc|credit|debit|payment|billing)\b/;

/** Luhn checksum, used to recognise card-number-shaped values. */
export function passesLuhn(digits: string): boolean {
  let sum = 0;
  let double = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = digits.charCodeAt(i) - 48;
    if (d < 0 || d > 9) return false;
    if (double) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    double = !double;
  }
  return sum % 10 === 0;
}

// Verhoeff tables (Aadhaar's check-digit algorithm).
const VERHOEFF_D = [
  [0, 1, 2, 3, 4, 5, 6, 7, 8, 9],
  [1, 2, 3, 4, 0, 6, 7, 8, 9, 5],
  [2, 3, 4, 0, 1, 7, 8, 9, 5, 6],
  [3, 4, 0, 1, 2, 8, 9, 5, 6, 7],
  [4, 0, 1, 2, 3, 9, 5, 6, 7, 8],
  [5, 9, 8, 7, 6, 0, 4, 3, 2, 1],
  [6, 5, 9, 8, 7, 1, 0, 4, 3, 2],
  [7, 6, 5, 9, 8, 2, 1, 0, 4, 3],
  [8, 7, 6, 5, 9, 3, 2, 1, 0, 4],
  [9, 8, 7, 6, 5, 4, 3, 2, 1, 0],
];
const VERHOEFF_P = [
  [0, 1, 2, 3, 4, 5, 6, 7, 8, 9],
  [1, 5, 7, 6, 2, 8, 3, 0, 9, 4],
  [5, 8, 0, 3, 7, 9, 6, 1, 4, 2],
  [8, 9, 1, 6, 0, 4, 3, 5, 2, 7],
  [9, 4, 5, 3, 1, 2, 6, 8, 7, 0],
  [4, 2, 8, 6, 5, 7, 3, 9, 0, 1],
  [2, 7, 9, 3, 8, 0, 6, 4, 1, 5],
  [7, 0, 4, 6, 9, 1, 3, 2, 5, 8],
];

/** Verhoeff checksum over a digit string whose last digit is the check digit. */
export function passesVerhoeff(digits: string): boolean {
  if (!/^\d+$/.test(digits)) return false;
  let c = 0;
  const reversed = [...digits].reverse();
  reversed.forEach((ch, i) => {
    const p = VERHOEFF_P[i % 8]?.[Number(ch)] ?? 0;
    c = VERHOEFF_D[c]?.[p] ?? 0;
  });
  return c === 0;
}

const REDACTED_PATTERN = /^\[filler:redacted:([a-z_]+)\]$/;

/**
 * Placeholder the page agent puts in place of a sensitive page value, so the
 * value itself never leaves the page while the policy still sees what it was.
 */
export function redactedValue(category: DeniedCategory): string {
  return `[filler:redacted:${category}]`;
}

/**
 * Recognises values that are themselves sensitive (used on page values and
 * vault writes). Checksums keep ordinary numbers, such as phone numbers, from
 * being mistaken for IDs.
 */
export function detectSensitiveValue(value: string): DeniedCategory | null {
  const redacted = REDACTED_PATTERN.exec(value);
  if (redacted && (DENIED_CATEGORIES as readonly string[]).includes(redacted[1] ?? '')) {
    return redacted[1] as DeniedCategory;
  }
  const trimmed = value.trim();
  const compact = trimmed.replace(/[\s-]/g, '');
  if (/^\d{13,19}$/.test(compact) && passesLuhn(compact)) return 'card_number';
  if (/^[2-9]\d{11}$/.test(compact) && passesVerhoeff(compact)) {
    // An unformatted 12-digit number starting with 91 is far more likely an
    // Indian mobile number with its country code than an Aadhaar number.
    const formatted = /^\d{4}[\s-]\d{4}[\s-]\d{4}$/.test(trimmed);
    if (formatted || !compact.startsWith('91')) return 'aadhaar';
  }
  if (/^[A-Za-z]{5}\d{4}[A-Za-z]$/.test(trimmed)) return 'pan';
  if (/^\d{3}-\d{2}-\d{4}$/.test(trimmed)) return 'ssn';
  return null;
}

export interface PolicyConfig {
  /** Extra user rules: plain phrases (matched as whole words on normalised text) or RegExps. */
  extraPatterns?: ReadonlyArray<string | RegExp>;
}

export interface Policy {
  classifyRisk(field: PolicyField): RiskResult;
}

function denied(category: DeniedCategory): RiskResult {
  return { allowed: false, category, reason: REASONS[category] };
}

function toRegExp(pattern: string | RegExp): RegExp {
  if (pattern instanceof RegExp) return pattern;
  const phrase = normaliseLabel(pattern).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`\\b${phrase}\\b`, 'u');
}

export function createPolicy(config: PolicyConfig = {}): Policy {
  const extra = (config.extraPatterns ?? []).filter((p) => p !== '').map(toRegExp);

  return {
    classifyRisk(field) {
      if (field.inputType.toLowerCase() === 'password') return denied('password');

      const autocomplete = (field.autocomplete ?? '').toLowerCase();
      for (const [re, category] of DENIED_AUTOCOMPLETE)
        if (re.test(autocomplete)) return denied(category);

      const text = [
        normaliseLabel(field.label),
        field.placeholder ? normaliseLabel(field.placeholder) : '',
        field.name ? humaniseIdentifier(field.name) : '',
        field.domId ? humaniseIdentifier(field.domId) : '',
      ]
        .filter(Boolean)
        .join(' | ');

      for (const [re, category] of DENIED_TEXT) if (re.test(text)) return denied(category);

      const context = `${text} | ${field.sectionHeading ? normaliseLabel(field.sectionHeading) : ''}`;
      if (EXPIRY.test(text) && CARD_CONTEXT.test(context)) return denied('card_expiry');

      const values = Array.isArray(field.currentValue)
        ? field.currentValue
        : [field.currentValue ?? ''];
      for (const value of values) {
        const category = value ? detectSensitiveValue(value) : null;
        if (category) return denied(category);
      }

      for (const re of extra) if (re.test(text)) return denied('user_rule');

      return { allowed: true };
    },
  };
}

/** Policy with only the hard-core rules. */
export const defaultPolicy: Policy = createPolicy();

export function classifyRisk(field: PolicyField): RiskResult {
  return defaultPolicy.classifyRisk(field);
}
