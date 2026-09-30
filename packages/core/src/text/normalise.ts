/** Text helpers shared by the policy module, mapper and signatures. */

const OPTIONAL_MARKERS =
  /\((?:optional|required|mandatory)\)|\b(?:optional|required|mandatory)\s*$/giu;

/**
 * Canonical form of a field label: lowercase, NFKC, required/optional markers
 * and asterisks removed, punctuation folded to spaces. Non-Latin letters
 * (e.g. Devanagari) are kept as-is.
 */
export function normaliseLabel(text: string): string {
  return text
    .normalize('NFKC')
    .toLowerCase()
    .replace(OPTIONAL_MARKERS, ' ')
    .replace(/[*]/g, ' ')
    .replace(/['’`]/g, '')
    .replace(/[^\p{L}\p{M}\p{N}]+/gu, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

/**
 * Splits identifiers into words: `cardNumber` → `card number`,
 * `billing_zip-code` → `billing zip code`, `CVV2Code` → `cvv2 code`.
 */
export function humaniseIdentifier(identifier: string): string {
  return identifier
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .replace(/[_\-.[\]:]+/g, ' ')
    .toLowerCase()
    .trim()
    .replace(/\s+/g, ' ');
}

/** Lowercase host without a leading `www.`; accepts a URL or a bare host. */
export function siteOf(urlOrHost: string): string {
  let host = urlOrHost.trim().toLowerCase();
  try {
    host = new URL(host.includes('://') ? host : `https://${host}`).hostname;
  } catch {
    // Not URL-shaped; use it as given.
  }
  return host.replace(/^www\./, '');
}

const DYNAMIC_IDENTIFIER = [
  // Framework-generated: input_83471, mui-12, react-select-3-input, :r5:, ember123, ng-7
  /^(?:input|field|text|mui|react|ember|ng|el|id|cmp|comp|jsx|v|q)[-_:]?\d+/i,
  /^:r[0-9a-z]+:$/i,
  // UUIDs and long hex/base-36 hashes
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
  /^(?=.*\d)(?=.*[a-z])[a-z0-9]{16,}$/i,
];

/** True when a name/id looks machine-generated and will change between page loads. */
export function isDynamicIdentifier(identifier: string): boolean {
  // Google Forms question names (entry.123456789) are long numbers but stable per form.
  if (/^entry\.\d+$/.test(identifier)) return false;
  return DYNAMIC_IDENTIFIER.some((re) => re.test(identifier)) || /\d{5,}$/.test(identifier);
}
