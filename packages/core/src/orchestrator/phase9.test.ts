import { describe, expect, it } from 'vitest';
import {
  checkDraft,
  checkDraftOutput,
  claimsIn,
  inventedClaims,
  type GenerateRequest,
} from '../ai/draft';
import type { Fact, FieldDescriptor } from '../schema/records';
import { parseGoal, parseGoalText, platformOf } from './goal';
import {
  isDraftable,
  isDraftContextKey,
  restrictSelection,
  selectFacts,
  topicGroups,
} from './select';
import { initialState, reduce, type SessionState } from './session';
import { strengthenSuggestions } from './suggest';

const at = '2026-10-01T00:00:00.000Z';
const fact = (
  key: string,
  value: Fact['value'],
  sensitivity: Fact['sensitivity'] = 'public',
): Fact => ({
  key,
  value,
  sensitivity,
  source: 'user',
  updatedAt: at,
});
const q = (label: string, helpText?: string) => ({ label, ...(helpText ? { helpText } : {}) });

const VAULT: Fact[] = [
  fact('person.name.full', 'Priya Sharma'),
  fact('contact.email', 'priya@example.com', 'personal'),
  fact('contact.phone.mobile', '+91 98765 43210', 'personal'),
  fact('address.city', 'Pune'),
  fact('address.line1', '12 MG Road', 'personal'),
  fact('person.dob', '2001-04-02', 'personal'),
  fact('bio.headline', 'Business Consultant for Growing SMBs'),
  fact('professional.years_experience', '6'),
  fact('skills', ['Excel', 'SQL', 'Power BI']),
  fact('projects[0].name', 'GST Automation'),
  fact('projects[0].description', 'Automated GST filing for 40 shops'),
  fact('projects[1].name', 'Inventory Dashboard'),
  fact('experience[0].company', 'Acme Retail'),
  fact('experience[0].title', 'Analyst'),
  fact('education[0].institution', 'Pune University'),
  fact('preferences.hourly_rate', '25'),
  fact('custom.favourite_tools', 'Notion, Figma'),
  fact('custom.secret_notes', 'private', 'restricted'),
  fact('custom.bank_details', '4111 1111 1111 1111'),
];

describe('selectFacts (Task 9.1)', () => {
  it('picks projects and skills for a projects question', () => {
    const s = selectFacts(q('Describe your previous projects'), VAULT);
    expect(s.groups.map((g) => `${g.label} (${g.count})`)).toEqual(['Projects (2)', 'Skills (1)']);
    expect(s.keys).toEqual([
      'projects[0].description',
      'projects[0].name',
      'projects[1].name',
      'skills',
    ]);
  });

  it('picks the profile groups for an overview, and rates for a rate question', () => {
    expect(topicGroups(q('Profile overview'))).toEqual([
      'bio',
      'professional',
      'experience',
      'skills',
      'projects',
      'education',
    ]);
    expect(selectFacts(q('What is your hourly rate?'), VAULT).keys).toEqual([
      'preferences.hourly_rate',
      'professional.years_experience',
    ]);
  });

  it('never selects restricted or personal facts, or never-store values', () => {
    for (const label of [
      'Tell us about yourself',
      'Why should we hire you? Include your contact email and address',
      'Your secret notes and bank details',
      'Anything else?',
    ]) {
      const keys = selectFacts(q(label), VAULT).keys;
      for (const banned of [
        'custom.secret_notes',
        'custom.bank_details',
        'contact.email',
        'contact.phone.mobile',
        'address.line1',
        'person.dob',
      ])
        expect(keys, label).not.toContain(banned);
    }
    expect(isDraftable(fact('custom.secret_notes', 'x', 'restricted'))).toBe(false);
    // A key whose registry tier is personal stays out even if mislabelled public.
    expect(isDraftable(fact('contact.email', 'a@b.co', 'public'))).toBe(false);
  });

  it('adds the user’s custom facts only when the question names them', () => {
    expect(selectFacts(q('Your favourite tools'), VAULT).keys).toContain('custom.favourite_tools');
    expect(selectFacts(q('Profile overview'), VAULT).keys).not.toContain('custom.favourite_tools');
  });

  it('lets the user untick groups but never add keys', () => {
    const s = selectFacts(q('Describe your previous projects'), VAULT);
    expect(restrictSelection(s, ['skills', 'contact.email', 'custom.secret_notes'])).toEqual([
      'skills',
    ]);
  });
});

const req = (over: Partial<GenerateRequest> = {}): GenerateRequest => ({
  field: {
    id: 'f',
    inputType: 'textarea',
    label: 'Profile overview',
    required: false,
    maxLength: 300,
  },
  page: { host: 'upwork.com' },
  goal: { text: 'Upwork profile', role: 'business consultant', platform: 'Upwork' },
  facts: [
    { key: 'skills', value: ['Excel', 'SQL'] },
    { key: 'projects[0].name', value: 'GST Automation' },
    { key: 'professional.years_experience', value: '6' },
  ],
  filled: [{ key: 'bio.headline', value: 'Business Consultant for Growing SMBs' }],
  examples: [],
  ...over,
});

describe('isDraftContextKey (Task 12.1 audit)', () => {
  it('lets profile details through as consistency context, never names, contact or address', () => {
    for (const key of ['bio.headline', 'preferences.hourly_rate', 'skills', 'projects[0].name'])
      expect(isDraftContextKey(key)).toBe(true);
    for (const key of [
      'address.city',
      'address.country',
      'person.name.full',
      'contact.email',
      'preferences.expected_salary',
      'custom.anything',
    ])
      expect(isDraftContextKey(key)).toBe(false);
  });
});

describe('draft checks (Task 9.2)', () => {
  it('finds proper nouns and numbers, not sentence starts or common words', () => {
    expect(
      claimsIn('I build dashboards in Excel. My GST Automation project saved 40% time at Google.'),
    ).toEqual(['Excel', 'GST', 'Automation', '40', 'Google']);
  });

  it('accepts a truthful draft and rejects invented employers, numbers and links', () => {
    const good =
      'As a Business Consultant for Growing SMBs with 6 years of experience, I automate reporting in Excel and SQL. Recently I built GST Automation.';
    expect(checkDraft(good, req())).toEqual({ ok: true, value: good });
    const bad = checkDraft(
      'I spent 10 years at Google and Deloitte. See https://me.example',
      req(),
    );
    expect(bad.ok).toBe(false);
    expect(!bad.ok && bad.problems.join(' ')).toMatch(/Google.*Deloitte|10/);
    expect(!bad.ok && bad.problems.join(' ')).toContain('link');
    expect(inventedClaims('I studied at IIT Bombay.', 'Pune University')).toEqual([
      'IIT',
      'Bombay',
    ]);
    expect(
      inventedClaims('Google hired me. Ex-Microsoft too. Helping clients is my focus.', ''),
    ).toEqual(['Google', 'Microsoft']);
  });

  it('enforces maxLength and exactly one allowed option', () => {
    expect(checkDraft('x '.repeat(200), req()).ok).toBe(false);
    const choice = req({
      field: {
        id: 'c',
        inputType: 'radio',
        label: 'Level',
        required: true,
        options: ['Entry level', 'Expert'],
      },
    });
    expect(checkDraft('expert', choice)).toEqual({ ok: true, value: 'Expert' });
    expect(checkDraft('Intermediate', choice).ok).toBe(false);
  });

  it('drops bad alternatives, promotes a good one, and keeps only facts that were sent', () => {
    const out = checkDraftOutput(
      {
        value: 'I worked at Infosys.',
        alternatives: ['I use Excel and SQL every day.', 'Ex-Microsoft analyst.'],
        usedFacts: ['skills', 'contact.email'],
        needsInput: [],
      },
      req(),
    );
    expect(out).toMatchObject({
      value: 'I use Excel and SQL every day.',
      alternatives: [],
      usedFacts: ['skills'],
    });
    expect(out.problems.join(' ')).toContain('Infosys');
  });
});

describe('goal intelligence (Task 9.4)', () => {
  it('reads platform, role, audience and tone; the user’s fields win', () => {
    expect(platformOf('https://www.upwork.com/nx/create-profile/')).toBe('Upwork');
    expect(platformOf('https://docs.google.com/forms/d/x')).toBe('Google Forms');
    expect(platformOf('http://127.0.0.1:5178/x.html')).toBeUndefined();
    expect(
      parseGoalText(
        'Create my Upwork profile as a business consultant for US small businesses, friendly',
      ),
    ).toEqual({
      role: 'business consultant',
      targetAudience: 'US small businesses',
      tone: 'friendly',
    });
    expect(
      parseGoal({ text: 'Profile as a data analyst', role: 'Analyst' }, 'https://upwork.com/x'),
    ).toEqual({
      text: 'Profile as a data analyst',
      role: 'Analyst',
      platform: 'Upwork',
    });
  });
});

const descriptor = (
  id: string,
  label: string,
  over: Partial<FieldDescriptor> = {},
): FieldDescriptor => ({
  id,
  frameId: 0,
  selector: `#${id}`,
  tag: 'textarea',
  inputType: 'textarea',
  label,
  labelSource: 'label-for',
  required: false,
  isVisible: true,
  isDisabled: false,
  signature: id.padEnd(64, '0').replace(/[^0-9a-f]/g, 'a'),
  ...over,
});

function planned(): SessionState {
  let s = reduce(initialState(), {
    type: 'START',
    id: 's',
    tabId: 1,
    goal: { text: 'Upwork profile as a business consultant' },
    at,
  }).state;
  s = reduce(s, {
    type: 'SCANNED',
    url: 'https://www.upwork.com/nx/profile',
    title: 'Profile',
    fields: [descriptor('ov', 'Profile overview', { maxLength: 5000 })],
    at,
  }).state;
  s = reduce(s, {
    type: 'MAPPED',
    mappings: { ov: { kind: 'open_ended', confidence: 0.5, reason: '', source: 'none' } },
  }).state;
  return reduce(s, {
    type: 'PLANNED',
    items: [
      {
        fieldId: 'ov',
        kind: 'open_ended',
        confidence: 0,
        status: 'pending',
        reason: 'Filler can draft this',
        question: 'What should I put?',
        draft: { groups: [{ id: 'skills', label: 'Skills', count: 1, keys: ['skills'] }] },
      },
    ],
  }).state;
}

describe('draft flow in the session (Tasks 9.3, 9.4)', () => {
  it('parses the goal at start and takes the platform from the page', () => {
    expect(planned().goal).toEqual({
      text: 'Upwork profile as a business consultant',
      role: 'business consultant',
      platform: 'Upwork',
    });
  });

  it('DRAFT asks the host to generate; DRAFTED shows a pending AI draft, never approved', () => {
    const s = planned();
    const asked = reduce(s, { type: 'DRAFT', fieldId: 'ov', keys: ['skills'], hint: 'shorter' });
    expect(asked.effects).toEqual([
      { type: 'GENERATE', fieldId: 'ov', keys: ['skills'], hint: 'shorter' },
    ]);
    expect(asked.state.plan[0]!.draft).toMatchObject({ busy: true, hint: 'shorter' });
    // A second click while busy does nothing.
    expect(reduce(asked.state, { type: 'DRAFT', fieldId: 'ov', keys: [] }).effects).toEqual([]);

    const drafted = reduce(asked.state, {
      type: 'DRAFTED',
      fieldId: 'ov',
      answer: {
        value: 'I use Excel.',
        reason: 'AI draft from Skills',
        alternatives: ['Excel is my tool.'],
        usedFacts: ['skills'],
      },
    }).state;
    expect(drafted.plan[0]).toMatchObject({
      value: 'I use Excel.',
      source: 'ai',
      status: 'pending',
      draft: { alternatives: ['Excel is my tool.'], usedFacts: ['skills'], hint: 'shorter' },
    });
    expect(drafted.plan[0]).not.toHaveProperty('question');
    expect(drafted.plan[0]!.draft).not.toHaveProperty('busy');
    // Approve-all-from-vault never approves AI text.
    expect(reduce(drafted, { type: 'APPROVE_ALL_VAULT' }).state.plan[0]!.status).toBe('pending');

    // Approving records the answer for reuse.
    const approved = reduce(drafted, { type: 'APPROVE', fieldIds: ['ov'] });
    expect(approved.effects).toEqual([
      {
        type: 'RECORD_ANSWER',
        fieldId: 'ov',
        question: 'Profile overview',
        value: 'I use Excel.',
        platform: 'Upwork',
        goal: 'Upwork profile as a business consultant',
      },
    ]);
  });

  it('a failed draft keeps the question and says why', () => {
    const asked = reduce(planned(), { type: 'DRAFT', fieldId: 'ov', keys: [] }).state;
    const failed = reduce(asked, {
      type: 'DRAFTED',
      fieldId: 'ov',
      answer: { needsInput: 'x', reason: 'Daily AI limit reached', questions: ['Which projects?'] },
    }).state;
    expect(failed.plan[0]).toMatchObject({
      question: 'What should I put?',
      draft: { error: 'Daily AI limit reached', needsInput: ['Which projects?'] },
    });
    expect(failed.plan[0]).not.toHaveProperty('value');
  });

  it('filled key-less answers are remembered for later pages; short overviews get a suggestion', () => {
    let s = reduce(planned(), {
      type: 'ANSWER',
      fieldId: 'ov',
      value: 'Short.',
      save: false,
    }).state;
    expect(strengthenSuggestions(s)).toEqual([
      expect.objectContaining({ fieldId: 'ov', message: expect.stringContaining('6 of 5,000') }),
    ]);
    s = reduce(s, { type: 'FILL' }).state;
    s = reduce(s, { type: 'FILL_RESULTS', results: [{ fieldId: 'ov', status: 'filled' }] }).state;
    expect(s.used).toEqual({ 'custom.profile_overview': 'Short.' });
  });
});
