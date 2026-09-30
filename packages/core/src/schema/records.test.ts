import { describe, expect, it } from 'vitest';
import type { ZodType } from 'zod';
import {
  AnswerSchema,
  DocumentRecordSchema,
  FactSchema,
  FieldDescriptorSchema,
  FieldMemorySchema,
  GoalSchema,
  PageSnapshotSchema,
  PlanItemSchema,
  SessionSchema,
} from './records';

const now = '2026-10-01T10:00:00.000Z';
const sig = 'a'.repeat(64);

const descriptor = {
  id: 'f1',
  frameId: 0,
  selector: '#email',
  tag: 'input',
  inputType: 'email',
  name: 'email',
  domId: 'email',
  autocomplete: 'email',
  label: 'Email address',
  labelSource: 'label-for',
  required: true,
  maxLength: 120,
  isVisible: true,
  isDisabled: false,
  bbox: { x: 10, y: 20, width: 200, height: 32 },
  signature: sig,
} as const;

const plan = {
  fieldId: 'f1',
  kind: 'fact',
  canonicalKey: 'contact.email',
  value: 'priya@example.com',
  source: 'vault',
  confidence: 0.98,
  status: 'pending',
  reason: 'From your vault: Email',
} as const;

const valid: Array<[string, ZodType, unknown]> = [
  [
    'Fact (text)',
    FactSchema,
    {
      key: 'contact.email',
      value: 'priya@example.com',
      sensitivity: 'personal',
      source: 'user',
      updatedAt: now,
    },
  ],
  [
    'Fact (list)',
    FactSchema,
    {
      key: 'skills',
      value: ['SQL', 'Excel'],
      sensitivity: 'public',
      source: 'resume_import',
      learnedOn: 'upwork.com',
      updatedAt: now,
    },
  ],
  [
    'Fact (custom)',
    FactSchema,
    {
      key: 'custom.favorite_tools',
      value: 'Notion',
      sensitivity: 'public',
      source: 'user',
      updatedAt: now,
    },
  ],
  [
    'DocumentRecord',
    DocumentRecordSchema,
    {
      id: 'd1',
      type: 'resume',
      name: 'cv.pdf',
      text: 'Priya Sharma...',
      parsedFactKeys: ['projects[0].name'],
      createdAt: now,
    },
  ],
  [
    'FieldMemory',
    FieldMemorySchema,
    {
      signature: sig,
      site: 'upwork.com',
      canonicalKey: 'bio.headline',
      timesUsed: 3,
      updatedAt: now,
    },
  ],
  [
    'Answer',
    AnswerSchema,
    {
      id: 'a1',
      questionText: 'Profile overview',
      platform: 'upwork.com',
      goal: 'Business consultant',
      value: 'I help...',
      approvedAt: now,
    },
  ],
  ['FieldDescriptor', FieldDescriptorSchema, descriptor],
  [
    'FieldDescriptor (choice)',
    FieldDescriptorSchema,
    {
      ...descriptor,
      id: 'f2',
      tag: 'select',
      inputType: 'select-one',
      options: [{ value: 'in', text: 'India' }],
      currentValue: 'in',
    },
  ],
  ['PlanItem', PlanItemSchema, plan],
  [
    'PlanItem (question)',
    PlanItemSchema,
    {
      fieldId: 'f3',
      kind: 'fact',
      confidence: 0,
      status: 'pending',
      reason: 'Not in your vault yet',
      question: 'What should I put for Date of birth?',
    },
  ],
  [
    'Goal',
    GoalSchema,
    {
      text: 'Create my Upwork profile as a business consultant',
      platform: 'upwork.com',
      role: 'Business consultant',
      tone: 'professional',
    },
  ],
  [
    'PageSnapshot',
    PageSnapshotSchema,
    {
      url: 'https://www.upwork.com/nx/create-profile/title',
      title: 'Title',
      capturedAt: now,
      fieldIds: ['f1'],
    },
  ],
  [
    'Session',
    SessionSchema,
    {
      id: 's1',
      tabId: 7,
      site: 'upwork.com',
      pages: [],
      fields: [descriptor],
      plan: [plan],
      startedAt: now,
    },
  ],
];

describe('record schemas round-trip', () => {
  it.each(valid)('%s', (_name, schema, input) => {
    const parsed = schema.parse(input);
    const again = schema.parse(JSON.parse(JSON.stringify(parsed)));
    expect(again).toEqual(parsed);
    expect(parsed).toEqual(input);
  });
});

const invalid: Array<[string, ZodType, unknown]> = [
  [
    'Fact with unknown key',
    FactSchema,
    { key: 'contact.fax', value: 'x', sensitivity: 'public', source: 'user', updatedAt: now },
  ],
  [
    'Fact with template key',
    FactSchema,
    { key: 'projects[].name', value: 'x', sensitivity: 'public', source: 'user', updatedAt: now },
  ],
  [
    'Fact with bad sensitivity',
    FactSchema,
    { key: 'contact.email', value: 'x', sensitivity: 'secret', source: 'user', updatedAt: now },
  ],
  [
    'Fact with object value',
    FactSchema,
    {
      key: 'contact.email',
      value: { a: 1 },
      sensitivity: 'personal',
      source: 'user',
      updatedAt: now,
    },
  ],
  [
    'Fact with non-ISO date',
    FactSchema,
    {
      key: 'contact.email',
      value: 'x',
      sensitivity: 'personal',
      source: 'user',
      updatedAt: 'yesterday',
    },
  ],
  [
    'FieldMemory with short signature',
    FieldMemorySchema,
    { signature: 'abc', site: 'x.com', timesUsed: 0, updatedAt: now },
  ],
  [
    'FieldMemory with negative uses',
    FieldMemorySchema,
    { signature: sig, site: 'x.com', timesUsed: -1, updatedAt: now },
  ],
  ['FieldDescriptor missing label', FieldDescriptorSchema, { ...descriptor, label: undefined }],
  [
    'FieldDescriptor bad labelSource',
    FieldDescriptorSchema,
    { ...descriptor, labelSource: 'guess' },
  ],
  ['FieldDescriptor zero maxLength', FieldDescriptorSchema, { ...descriptor, maxLength: 0 }],
  ['PlanItem confidence > 1', PlanItemSchema, { ...plan, confidence: 1.2 }],
  ['PlanItem unknown status', PlanItemSchema, { ...plan, status: 'submitted' }],
  ['Goal empty text', GoalSchema, { text: '' }],
  [
    'PageSnapshot bad url',
    PageSnapshotSchema,
    { url: 'not a url', title: '', capturedAt: now, fieldIds: [] },
  ],
];

describe('record schemas reject malformed input', () => {
  it.each(invalid)('%s', (_name, schema, input) => {
    expect(schema.safeParse(input).success).toBe(false);
  });
});
