import { describe, expect, it } from 'vitest';
import type { FieldDescriptor, FieldMemory } from '../schema/records';
import { compileDictionary, defaultDictionary } from './dictionary';
import { mapField, mapFields } from './map';
import rawDictionary from '../../../../config/field-dictionary.json' with { type: 'json' };

const field = (label: string, over: Partial<FieldDescriptor> = {}): FieldDescriptor => ({
  id: `f-${label}`,
  frameId: 0,
  selector: '#x',
  tag: 'input',
  inputType: 'text',
  label,
  labelSource: 'label-for',
  required: false,
  isVisible: true,
  isDisabled: false,
  signature: 'a'.repeat(64),
  ...over,
});

const ctx = { site: 'example.com' };
const key = (f: FieldDescriptor) => mapField(f, ctx).canonicalKey ?? null;

describe('dictionary', () => {
  it('covers every canonical key and validates', () => {
    expect(() => compileDictionary(rawDictionary)).not.toThrow();
    expect(defaultDictionary().entries.length).toBeGreaterThan(60);
  });

  it('rejects unknown keys, duplicates and missing keys', () => {
    const base = rawDictionary as { entries: Array<{ key: string }> };
    expect(() =>
      compileDictionary({
        ...base,
        entries: [...base.entries, { key: 'contact.fax', patterns: ['fax'] }],
      }),
    ).toThrow(/not in registry/);
    expect(() =>
      compileDictionary({ ...base, entries: [...base.entries, base.entries[0]] }),
    ).toThrow(/twice/);
    expect(() => compileDictionary({ ...base, entries: base.entries.slice(1) })).toThrow(/missing/);
  });
});

describe('labels the fixtures never saw (Indian and international phrasing)', () => {
  it.each([
    ['Mobile No.', 'contact.phone.mobile'],
    ['Contact Number *', 'contact.phone.mobile'],
    ['WhatsApp No.', 'contact.whatsapp'],
    ['E-mail ID', 'contact.email'],
    ['Alternate Email Address', 'contact.email_alt'],
    ["Father's Name", 'family.father_name'],
    ["Mother's Full Name", 'family.mother_name'],
    ['Name of the Applicant', 'person.name.full'],
    ['Surname', 'person.name.last'],
    ['Given name', 'person.name.first'],
    ['D.O.B', 'person.dob'],
    ['PIN Code', 'address.postal_code'],
    ['Pincode', 'address.postal_code'],
    ['Zip', 'address.postal_code'],
    ['Taluka', 'address.district'],
    ['State / UT', 'address.state'],
    ['Permanent Address', 'address.line1'],
    ['Landmark', 'address.line2'],
    ['College Name', 'education[0].institution'],
    ['Name of the University', 'education[0].institution'],
    ['Branch', 'education[0].field'],
    ['Year of Passing', 'education[0].end'],
    ['CGPA', 'education[0].grade'],
    ['Highest Qualification', 'education[0].degree'],
    ['Current Employer', 'experience[0].company'],
    ['Designation', 'experience[0].title'],
    ['Current CTC', 'preferences.current_salary'],
    ['Expected Stipend', 'preferences.expected_salary'],
    ['Notice Period (days)', 'preferences.notice_period'],
    ['Total Experience (years)', 'professional.years_experience'],
    ['GitHub Profile', 'links.github'],
    ['Portfolio URL', 'links.portfolio'],
    ['Tell us about yourself', 'bio.summary_long'],
    ['Headline', 'bio.headline'],
    ['Key Skills', 'skills'],
    ['Languages Known', 'languages[0].language'],
    ['Time zone', 'preferences.timezone'],
    ['Nationality', 'person.nationality'],
    ['Project Title', 'projects[0].name'],
    ['Tech stack used', 'projects[0].tech'],
    ['Certification Name', 'certifications[0].name'],
  ])('%j → %s', (label, want) => expect(key(field(label))).toBe(want));

  it.each([
    'Rate yourself: Communication',
    'Which year are you in?',
    'Joining date',
    'Favourite colour',
    'Step 2 of 3',
  ])('%j stays unmapped', (label) => {
    expect(key(field(label))).toBeNull();
  });
});

describe('context: section headings decide list groups and indexes', () => {
  it('uses the section to place generic labels', () => {
    expect(key(field('Start', { sectionHeading: 'Education 1', inputType: 'month' }))).toBe(
      'education[0].start',
    );
    expect(key(field('Start date', { sectionHeading: 'Work experience', inputType: 'date' }))).toBe(
      'experience[0].start',
    );
    expect(key(field('Title', { sectionHeading: 'Add employment' }))).toBe('experience[0].title');
    expect(key(field('Description', { sectionHeading: 'Project 2', inputType: 'textarea' }))).toBe(
      'projects[1].description',
    );
    expect(key(field('Project 2 title'))).toBe('projects[1].name');
    expect(key(field('Title'))).toBeNull();
  });

  it('ignores numbers that are not next to the group word', () => {
    expect(key(field('Institution', { sectionHeading: 'Step 2 of 3: Education' }))).toBe(
      'education[0].institution',
    );
  });

  it('numbers repeated sections in document order when they have no number', () => {
    const fields = [
      field('College name', { id: 'a', sectionHeading: 'Graduation' }),
      field('Degree', { id: 'b', sectionHeading: 'Graduation' }),
      field('College name', { id: 'c', sectionHeading: 'Post graduation' }),
      field('Degree', { id: 'd', sectionHeading: 'Post graduation' }),
    ];
    const r = mapFields(fields, ctx);
    expect(['a', 'b', 'c', 'd'].map((id) => r.get(id)!.canonicalKey)).toEqual([
      'education[0].institution',
      'education[0].degree',
      'education[1].institution',
      'education[1].degree',
    ]);
  });

  it('matches a language named in the label to the vault entry', () => {
    const factValues = new Map([
      ['languages[0].language', 'English'],
      ['languages[1].language', 'Hindi'],
    ]);
    const r = mapFields(
      [field('Hindi proficiency', { id: 'h' }), field('English proficiency', { id: 'e' })],
      { ...ctx, factValues },
    );
    expect(r.get('h')!.canonicalKey).toBe('languages[1].proficiency');
    expect(r.get('e')!.canonicalKey).toBe('languages[0].proficiency');
  });

  it('maps split date fields through their section heading', () => {
    const r = mapField(
      field('Month', { inputType: 'select-one', sectionHeading: 'Date of birth' }),
      ctx,
    );
    expect(r).toMatchObject({ canonicalKey: 'person.dob', part: 'month', kind: 'fact' });
    expect(
      mapField(field('Year', { sectionHeading: 'Personal details' }), ctx).canonicalKey,
    ).toBeUndefined();
  });
});

describe('resolution order', () => {
  it('prefers field memory over everything', () => {
    const memory = new Map<string, FieldMemory>([
      [
        'a'.repeat(64),
        {
          signature: 'a'.repeat(64),
          site: 'example.com',
          canonicalKey: 'custom.team_name',
          timesUsed: 1,
          updatedAt: '2026-10-01T00:00:00.000Z',
        },
      ],
    ]);
    expect(mapField(field('Email', { autocomplete: 'email' }), { ...ctx, memory })).toMatchObject({
      canonicalKey: 'custom.team_name',
      source: 'memory',
      confidence: 0.99,
    });
  });

  it('uses autocomplete before labels', () => {
    expect(
      mapField(field('Something odd', { autocomplete: 'section-x shipping postal-code' }), ctx),
    ).toMatchObject({ canonicalKey: 'address.postal_code', source: 'autocomplete' });
    expect(mapField(field('Day', { autocomplete: 'bday-day' }), ctx)).toMatchObject({
      canonicalKey: 'person.dob',
      part: 'day',
    });
  });

  it('falls back to the name attribute and placeholder', () => {
    expect(key(field('', { name: 'linkedin_url' }))).toBe('links.linkedin');
    expect(key(field('', { placeholder: 'Enter your PIN code' }))).toBe('address.postal_code');
  });

  it('reuses custom facts by label on any site', () => {
    const factKeys = new Set(['custom.team_name']);
    expect(mapField(field('Team name'), { ...ctx, factKeys })).toMatchObject({
      canonicalKey: 'custom.team_name',
      source: 'custom',
    });
  });

  it('recognises option sets', () => {
    const countries = [
      'India',
      'United States',
      'United Kingdom',
      'Canada',
      'Australia',
      'Germany',
    ].map((t) => ({ value: t, text: t }));
    expect(
      mapField(field('Where are you based?', { inputType: 'select-one', options: countries }), ctx),
    ).toMatchObject({ canonicalKey: 'address.country', source: 'options' });
    const genders = ['Male', 'Female', 'Prefer not to say'].map((t) => ({ value: t, text: t }));
    expect(
      mapField(field('I identify as', { inputType: 'radio', options: genders }), ctx),
    ).toMatchObject({ canonicalKey: 'person.gender', kind: 'choice' });
  });
});

describe('kinds and safety', () => {
  it.each([
    [field('Password', { inputType: 'password' }), 'denied'],
    [field('Aadhaar number'), 'denied'],
    [field('Resume', { inputType: 'file' }), 'skip'],
    [field('I agree to the terms', { inputType: 'checkbox' }), 'skip'],
    [field('Other (please specify)'), 'skip'],
    [field('Referral code'), 'skip'],
    [field('Email', { isDisabled: true }), 'skip'],
    [field('Cover letter', { inputType: 'textarea' }), 'open_ended'],
    [field('Profile overview', { inputType: 'textarea' }), 'open_ended'],
    [
      field('Responsibilities', { inputType: 'textarea', sectionHeading: 'Work experience' }),
      'fact',
    ],
    [
      field('Experience level', { inputType: 'radio', options: [{ value: 'a', text: 'Entry' }] }),
      'choice',
    ],
    [field('Favourite colour'), 'fact'],
  ])('%j → %s', (f, kind) => expect(mapField(f, ctx).kind).toBe(kind));

  it('never gives a denied field a key, even with memory pointing at one', () => {
    const memory = new Map<string, FieldMemory>([
      [
        'a'.repeat(64),
        {
          signature: 'a'.repeat(64),
          site: 'x',
          canonicalKey: 'contact.email',
          timesUsed: 9,
          updatedAt: '2026-10-01T00:00:00.000Z',
        },
      ],
    ]);
    const r = mapField(field('Card number'), { ...ctx, memory });
    expect(r.kind).toBe('denied');
    expect(r.canonicalKey).toBeUndefined();
  });

  it('keeps the key on disabled fields but skips them', () => {
    expect(mapField(field('Email', { isDisabled: true }), ctx)).toMatchObject({
      kind: 'skip',
      canonicalKey: 'contact.email',
    });
  });
});
