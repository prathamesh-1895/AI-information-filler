import { describe, expect, it } from 'vitest';
import { humaniseIdentifier, isDynamicIdentifier, normaliseLabel, siteOf } from './normalise';
import { fieldSignature, signatureMaterial } from './signature';

describe('normaliseLabel', () => {
  it.each([
    ['Full Name *', 'full name'],
    ['Email address (optional)', 'email address'],
    ['Mobile No.:', 'mobile no'],
    ["Father's Name", 'fathers name'],
    ['  Date   of\nbirth  ', 'date of birth'],
    ['Phone (Required)', 'phone'],
    ['City / Town', 'city town'],
    ['ＦＵＬＬ　ＮＡＭＥ', 'full name'],
    ['पूरा नाम *', 'पूरा नाम'],
    ['Required skills', 'required skills'],
  ])('%j → %j', (input, expected) => expect(normaliseLabel(input)).toBe(expected));
});

describe('humaniseIdentifier', () => {
  it.each([
    ['cardNumber', 'card number'],
    ['billing_zip-code', 'billing zip code'],
    ['CVVCode', 'cvv code'],
    ['user.email', 'user email'],
    ['first_name', 'first name'],
  ])('%j → %j', (input, expected) => expect(humaniseIdentifier(input)).toBe(expected));
});

describe('siteOf', () => {
  it.each([
    ['https://www.upwork.com/nx/create-profile', 'upwork.com'],
    ['docs.google.com', 'docs.google.com'],
    ['HTTP://WWW.Fiverr.com:443/x', 'fiverr.com'],
    ['127.0.0.1:5178', '127.0.0.1'],
  ])('%j → %j', (input, expected) => expect(siteOf(input)).toBe(expected));
});

describe('isDynamicIdentifier', () => {
  it.each([
    'input_83471',
    'mui-12',
    ':r5:',
    'ember123',
    'a1b2c3d4e5f6g7h8i9',
    '3f2b8c1e-9d4a-4e2b-8f6c-1a2b3c4d5e6f',
    'field-1027364',
  ])('dynamic: %s', (id) => expect(isDynamicIdentifier(id)).toBe(true));
  it.each(['email', 'first_name', 'entry.1234567890', 'address1', 'phone', 'zip'])(
    'stable: %s',
    (id) => expect(isDynamicIdentifier(id)).toBe(false),
  );
});

describe('fieldSignature', () => {
  const site = 'https://www.upwork.com/nx/create-profile/title';

  it('is a 64-char hex SHA-256', async () => {
    expect(
      await fieldSignature(site, { label: 'Title', inputType: 'text', name: 'title' }),
    ).toMatch(/^[0-9a-f]{64}$/);
  });

  it('is stable across reloads that change dynamic ids and label cosmetics', async () => {
    const a = await fieldSignature(site, {
      label: 'Your title *',
      inputType: 'text',
      name: 'input_83471',
    });
    const b = await fieldSignature('upwork.com', {
      label: 'Your Title',
      inputType: 'TEXT',
      name: 'input_19022',
    });
    expect(a).toBe(b);
  });

  it('differs across sites, labels, types and stable names', async () => {
    const base = { label: 'Email', inputType: 'email', name: 'email' };
    const sigs = await Promise.all([
      fieldSignature('a.com', base),
      fieldSignature('b.com', base),
      fieldSignature('a.com', { ...base, label: 'Alternate email' }),
      fieldSignature('a.com', { ...base, inputType: 'text' }),
      fieldSignature('a.com', { ...base, name: 'contact_email' }),
    ]);
    expect(new Set(sigs).size).toBe(sigs.length);
  });

  it('keeps Google Forms entry names so identical labels on one form stay distinct', () => {
    const one = signatureMaterial('docs.google.com', {
      label: 'Name',
      inputType: 'text',
      name: 'entry.111',
    });
    const two = signatureMaterial('docs.google.com', {
      label: 'Name',
      inputType: 'text',
      name: 'entry.222',
    });
    expect(one).not.toBe(two);
  });
});
