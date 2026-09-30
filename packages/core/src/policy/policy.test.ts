import { describe, expect, it } from 'vitest';
import {
  classifyRisk,
  createPolicy,
  detectSensitiveValue,
  passesLuhn,
  passesVerhoeff,
  type DeniedCategory,
  type PolicyField,
} from './deny';
import { isSubmitLike } from './submit';

const field = (label: string, extra: Partial<PolicyField> = {}): PolicyField => ({
  inputType: 'text',
  label,
  ...extra,
});

// Verhoeff-valid 12-digit numbers (generated with passesVerhoeff; not real Aadhaar numbers).
const AADHAAR_LIKE = '234567890124';
const PHONE_91_VERHOEFF_VALID = '919876543216';

describe('classifyRisk: denied fields', () => {
  const cases: Array<[string, PolicyField, DeniedCategory]> = [
    ['type=password', field('Choose something', { inputType: 'password' }), 'password'],
    ['Password label', field('Password'), 'password'],
    ['Confirm password', field('Confirm password'), 'password'],
    ['name=pwd', field('', { name: 'user_pwd' }), 'password'],
    ['Hindi password', field('पासवर्ड'), 'password'],
    [
      'autocomplete new-password',
      field('Choose', { autocomplete: 'section-a new-password' }),
      'password',
    ],
    ['OTP', field('Enter OTP'), 'otp'],
    ['One-time password', field('One-time password'), 'otp'],
    ['Verification code', field('Verification code'), 'otp'],
    ['autocomplete one-time-code', field('Code', { autocomplete: 'one-time-code' }), 'otp'],
    ['2FA', field('2FA code'), 'otp'],
    ['Card number', field('Card number'), 'card_number'],
    ['Credit card no.', field('Credit Card No.'), 'card_number'],
    ['Debit card number', field('Debit card number'), 'card_number'],
    ['name=cardNumber', field('', { name: 'cardNumber' }), 'card_number'],
    ['autocomplete cc-number', field('Number', { autocomplete: 'cc-number' }), 'card_number'],
    ['CVV', field('CVV'), 'card_security_code'],
    ['CVC', field('CVC *'), 'card_security_code'],
    ['Security code', field('Security code'), 'card_security_code'],
    ['autocomplete cc-csc', field('Code', { autocomplete: 'cc-csc' }), 'card_security_code'],
    [
      'Expiry in card section',
      field('Expiry date', { sectionHeading: 'Payment details' }),
      'card_expiry',
    ],
    ['Card expiry label', field('Card expiry (MM/YY)'), 'card_expiry'],
    ['autocomplete cc-exp', field('MM/YY', { autocomplete: 'cc-exp' }), 'card_expiry'],
    ['Bank account number', field('Bank account number'), 'bank_account'],
    ['A/C No.', field('A/C No.'), 'bank_account'],
    ['IFSC', field('IFSC Code'), 'bank_account'],
    ['IBAN', field('IBAN'), 'bank_account'],
    ['SWIFT code', field('SWIFT code'), 'bank_account'],
    ['Hindi account number', field('खाता संख्या'), 'bank_account'],
    ['UPI PIN', field('UPI PIN'), 'upi_pin'],
    ['ATM PIN', field('ATM pin'), 'upi_pin'],
    ['MPIN', field('MPIN'), 'upi_pin'],
    ['Passport number', field('Passport number'), 'passport'],
    ['Passport expiry', field('Passport expiry date'), 'passport'],
    ['Aadhaar', field('Aadhaar number'), 'aadhaar'],
    ['Aadhar misspelt', field('Aadhar card no'), 'aadhaar'],
    ['Hindi Aadhaar', field('आधार संख्या'), 'aadhaar'],
    ['PAN', field('PAN'), 'pan'],
    ['PAN card number', field('PAN card number'), 'pan'],
    ['name=pan_no', field('', { name: 'pan_no' }), 'pan'],
    ['SSN', field('SSN'), 'ssn'],
    ['Social security number', field('Social Security Number'), 'ssn'],
    ['Driving licence', field('Driving licence number'), 'government_id'],
    ["Driver's license", field("Driver's license"), 'government_id'],
    ['Voter ID', field('Voter ID'), 'government_id'],
    ['Security question', field('Security question'), 'security_question'],
    ["Mother's maiden name", field("Mother's maiden name"), 'security_question'],
    ['CAPTCHA', field('Enter the captcha'), 'captcha'],
    [
      'Prefilled card value',
      field('Reference', { currentValue: '4111 1111 1111 1111' }),
      'card_number',
    ],
    ['Prefilled PAN value', field('Reference', { currentValue: 'ABCDE1234F' }), 'pan'],
    ['Prefilled Aadhaar value', field('Reference', { currentValue: '2345 6789 0124' }), 'aadhaar'],
  ];

  it.each(cases)('%s', (_name, input, category) => {
    const result = classifyRisk(input);
    expect(result).toMatchObject({ allowed: false, category });
    if (!result.allowed) expect(result.reason.length).toBeGreaterThan(10);
  });
});

describe('classifyRisk: allowed fields (no false positives)', () => {
  const cases: Array<[string, PolicyField]> = [
    ['Card holder name', field('Card holder name')],
    ['autocomplete cc-name', field('Name on card', { autocomplete: 'cc-name' })],
    ['Full name', field('Full name', { autocomplete: 'name' })],
    ['Email', field('Email', { inputType: 'email' })],
    ['Pin code', field('Pin code')],
    ['PIN code (postal)', field('PIN Code *')],
    ['Company', field('Company name')],
    ['Japan in label', field('Have you worked in Japan?')],
    ['Pan India availability', field('Pan India relocation')],
    ['Swift skill', field('Years of Swift experience')],
    ['Experience', field('Years of experience')],
    ['Expiry outside card context', field('Offer expiry date')],
    ['Account name', field('Account name')],
    ['Upwork username', field('Username')],
    ['Mobile number', field('Mobile number', { inputType: 'tel', currentValue: '9876543210' })],
    ['Phone with 91 prefix', field('Phone', { currentValue: PHONE_91_VERHOEFF_VALID })],
    ['Hourly rate', field('Hourly rate', { currentValue: '25' })],
    ['Overview', field('Profile overview')],
    ['Security clearance question', field('Do you hold a security clearance?')],
    [
      'Password hint in help text only',
      field('Email address', { sectionHeading: 'Create your password later' }),
    ],
  ];

  it.each(cases)('%s', (_name, input) => expect(classifyRisk(input)).toEqual({ allowed: true }));
});

describe('createPolicy: user rules', () => {
  it('adds phrase and RegExp rules on top of the hard-core list', () => {
    const policy = createPolicy({ extraPatterns: ['Date of birth', /\bsalary\b/] });
    expect(policy.classifyRisk(field('Date of Birth *'))).toMatchObject({
      allowed: false,
      category: 'user_rule',
    });
    expect(policy.classifyRisk(field('Expected salary'))).toMatchObject({
      allowed: false,
      category: 'user_rule',
    });
    expect(policy.classifyRisk(field('City'))).toEqual({ allowed: true });
  });

  it('cannot remove hard-core rules', () => {
    const policy = createPolicy({ extraPatterns: [] });
    expect(policy.classifyRisk(field('Password'))).toMatchObject({
      allowed: false,
      category: 'password',
    });
  });

  it('escapes regex characters in phrase rules', () => {
    const policy = createPolicy({ extraPatterns: ['C++ level'] });
    expect(policy.classifyRisk(field('C level'))).toMatchObject({ allowed: false });
    expect(policy.classifyRisk(field('Cplus'))).toEqual({ allowed: true });
  });
});

describe('value checks', () => {
  it('validates Luhn', () => {
    expect(passesLuhn('4111111111111111')).toBe(true);
    expect(passesLuhn('4111111111111112')).toBe(false);
  });

  it('validates Verhoeff', () => {
    expect(passesVerhoeff('2363')).toBe(true); // textbook example: 236 → check digit 3
    expect(passesVerhoeff('2364')).toBe(false);
    expect(passesVerhoeff(AADHAAR_LIKE)).toBe(true);
  });

  it.each([
    ['4111 1111 1111 1111', 'card_number'],
    ['4111-1111-1111-1111', 'card_number'],
    [AADHAAR_LIKE, 'aadhaar'],
    ['2345-6789-0124', 'aadhaar'],
    ['abcde1234f', 'pan'],
    ['123-45-6789', 'ssn'],
  ])('%s → %s', (value, category) => expect(detectSensitiveValue(value)).toBe(category));

  it.each([
    '9876543210',
    '+91 98765 43210',
    PHONE_91_VERHOEFF_VALID,
    '411001',
    '234567890123',
    'Priya',
    '2026-10-01',
    '4111111111111112',
  ])('%s is not sensitive', (value) => expect(detectSensitiveValue(value)).toBeNull());
});

describe('isSubmitLike', () => {
  it.each([
    'Submit',
    'Submit profile',
    'Save & Submit',
    'Pay now',
    'Continue to payment',
    'Place order',
    'Publish',
    'Post job',
    'Send',
    'Apply',
    'Confirm',
    'Finish',
    'Complete registration',
    'Sign up',
    'Create account',
    'Done',
    'Save',
    'Delete',
    'Cancel',
    'Upload',
    '',
    'Go',
  ])('%j is submit-like', (text) => expect(isSubmitLike({ text })).toBe(true));

  it.each([
    'Next',
    'Next →',
    'Continue',
    'Save & Continue',
    'Save and Next',
    'Next step',
    'Back',
    'Previous',
    'Skip for now',
    'Add another',
    '+ Add education',
    'Add project',
    'Show more',
  ])('%j is navigation', (text) => expect(isSubmitLike({ text })).toBe(false));

  it('uses value/aria-label when the text is empty', () => {
    expect(isSubmitLike({ text: '', type: 'submit', value: 'Next' })).toBe(false);
    expect(isSubmitLike({ text: '  ', ariaLabel: 'Submit form' })).toBe(true);
  });

  it('decides on text, not type=submit (wizards use submit-typed Next buttons)', () => {
    expect(isSubmitLike({ text: 'Next', type: 'submit' })).toBe(false);
  });
});
