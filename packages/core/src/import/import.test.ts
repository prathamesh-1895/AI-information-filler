import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { Fact } from '../schema/records';
import { guardExtract } from './ai';
import { extractContacts, extractLocally, withoutContacts, type Candidate } from './extract';
import { mergeCandidates, planImport } from './merge';

/** PLAYBOOK Task 11.1: three synthetic résumés (no real person's data). */
const resume = (name: string) =>
  readFileSync(new URL(`../../../../test-fixtures/resumes/${name}.txt`, import.meta.url), 'utf8');
const asMap = (cands: Candidate[]) => Object.fromEntries(cands.map((c) => [c.key, c.value]));

describe('extractLocally: three résumé styles', () => {
  it('a classic résumé with blank-line entries (Asha)', () => {
    const got = asMap(extractLocally(resume('asha-verma')));
    expect(got).toMatchObject({
      'person.name.full': 'Asha Verma',
      'contact.email': 'asha.verma@example.com',
      'contact.phone.mobile': '+91 98220 11223',
      'links.linkedin': 'https://linkedin.com/in/asha-verma-demo',
      'links.github': 'https://github.com/ashaverma-demo',
      'address.city': 'Pune',
      'address.state': 'Maharashtra',
      'person.dob': '1996-05-14',
      'bio.headline': 'Business Consultant | Process Improvement for Small Businesses',
      'professional.years_experience': '6',
      skills: ['Excel', 'SQL', 'Power BI', 'Process mapping', 'Financial modelling'],
      'education[0].degree': 'MBA',
      'education[0].field': 'Operations',
      'education[0].institution': 'Symbiosis Institute of Business Management',
      'education[0].grade': 'CGPA 8.4',
      'education[1].institution': 'Fergusson College',
      'experience[0].title': 'Operations Analyst',
      'experience[0].company': 'Sahyadri Retail Pvt Ltd',
      'experience[0].start': '2019-07',
      'experience[1].end': '2019-06',
      'projects[0].name': 'GST Automation',
      'projects[1].tech': ['Power BI', 'SQL'],
      'certifications[0].issuer': 'KPMG',
      'languages[0].language': 'English',
      'languages[0].proficiency': 'Fluent',
      'languages[2].proficiency': 'Native',
    });
    expect(got).not.toHaveProperty('links.portfolio'); // "B.Com" is not a website
    expect(got).not.toHaveProperty('experience[0].end'); // "Present"
  });

  it('an all-caps résumé with no blank lines between entries (Rahul)', () => {
    const got = asMap(extractLocally(resume('rahul-iyer')));
    expect(got).toMatchObject({
      'person.name.full': 'Rahul Iyer',
      'contact.phone.mobile': '9876501234',
      'links.portfolio': 'https://rahul-iyer-demo.dev',
      'education[0].degree': 'B.Tech',
      'education[0].institution': 'National Institute of Technology Trichy',
      'education[1].degree': 'Class XII',
      'education[1].grade': '94%',
      'experience[0].company': 'Zephyr Labs',
      'experience[1].title': 'Teaching Assistant',
      'projects[1].name': 'Exam Seat Planner',
      'projects[1].url': 'https://github.com/rahul-iyer-demo/seat-planner',
      skills: ['Go', 'Python', 'TypeScript', 'Docker', 'PostgreSQL', 'Git'],
      'languages[2].proficiency': 'Conversational',
    });
  });

  it('pasted LinkedIn text (Meera)', () => {
    const got = asMap(extractLocally(resume('meera-thomas')));
    expect(got).toMatchObject({
      'bio.headline': 'Product Designer at Lumen Health',
      'address.city': 'Kochi',
      'address.country': 'India',
      'education[0].degree': 'Master of Design',
      'education[0].field': 'Interaction Design',
      'education[0].end': '2020',
      'experience[0].company': 'Lumen Health',
      'experience[1].title': 'UI Designer',
      'links.behance': 'https://behance.net/meera-thomas-demo',
    });
  });
});

describe('contacts stay on the device', () => {
  it('finds contacts by pattern and removes them from what the AI gets', () => {
    const text = resume('asha-verma');
    expect(extractContacts(text).map((c) => c.key)).toEqual([
      'contact.email',
      'contact.phone.mobile',
      'links.linkedin',
      'links.github',
      'person.name.full',
      'address.city',
      'address.state',
      'person.dob',
    ]);
    const sent = withoutContacts(text);
    for (const leak of [
      'asha.verma@example.com',
      '98220',
      'linkedin.com/in',
      '14 May 1996',
      'Location: Pune',
    ])
      expect(sent).not.toContain(leak);
    expect(sent).toContain('Sahyadri Retail');
  });
});

describe('guardExtract', () => {
  const text = withoutContacts(resume('asha-verma'));
  it('keeps real keys with values found in the text; drops invented, contact and sensitive ones', () => {
    const out = guardExtract(
      [
        { key: 'experience[0].company', value: 'Sahyadri Retail Pvt Ltd', confidence: 0.95 },
        { key: 'experience[0].start', value: '2019-07', confidence: 0.9 },
        { key: 'languages[1].proficiency', value: 'Native', confidence: 0.9 },
        { key: 'experience[2].company', value: 'Infosys', confidence: 0.9 },
        { key: 'experience[0].end', value: '2023-01', confidence: 0.9 },
        { key: 'contact.email', value: 'x@y.com', confidence: 1 },
        { key: 'custom.pan', value: 'ABCDE1234F', confidence: 1 },
        { key: 'made.up', value: 'x', confidence: 1 },
        { key: 'languages[1].proficiency', value: 'Native', confidence: 0.9 },
      ],
      text,
    );
    expect(out.facts.map((f) => f.key)).toEqual([
      'experience[0].company',
      'experience[0].start',
      'languages[1].proficiency',
    ]);
    expect(out.rejected).toBe(6);
    expect(out.facts[0]!.confidence).toBe(0.9);
  });
});

describe('planImport: review rows against the vault', () => {
  const at = '2026-10-01T00:00:00.000Z';
  const fact = (key: string, value: Fact['value']): Fact => ({
    key,
    value,
    sensitivity: 'public',
    source: 'user',
    updatedAt: at,
  });

  it('marks new, same, different and added details; never ticks a change to a saved value', () => {
    const rows = planImport(extractLocally(resume('asha-verma')), [
      fact('person.name.full', 'Asha Verma'),
      fact('address.city', 'Mumbai'),
      fact('skills', ['Excel', 'Tableau']),
      fact('experience[0].company', 'Konkan Logistics'),
      fact('experience[0].title', 'Junior Analyst'),
      fact('experience[1].company', 'Old Job'),
    ]);
    const by = (key: string) => rows.find((r) => r.key === key);
    expect(by('person.name.full')).toMatchObject({ status: 'same', accept: false });
    expect(by('address.city')).toMatchObject({
      status: 'different',
      accept: false,
      existing: 'Mumbai',
      value: 'Pune',
    });
    expect(by('skills')).toMatchObject({
      status: 'adds',
      accept: true,
      value: ['Excel', 'Tableau', 'SQL', 'Power BI', 'Process mapping', 'Financial modelling'],
    });
    // Konkan Logistics is already saved as job 0: matched, not duplicated. Sahyadri is new: appended as job 2.
    expect(by('experience[0].company')).toMatchObject({
      status: 'same',
      value: 'Konkan Logistics',
    });
    expect(by('experience[0].start')).toMatchObject({ status: 'new', value: '2017-06' });
    expect(by('experience[2].company')).toMatchObject({
      status: 'new',
      value: 'Sahyadri Retail Pvt Ltd',
      accept: true,
    });
    expect(by('experience[2].title')?.label).toBe('Job title (Sahyadri Retail Pvt Ltd)');
    expect(rows.find((r) => r.key === 'experience[1].company')).toBeUndefined();
    expect(by('education[0].institution')?.section).toBe('Education');
  });

  it('merges AI and local readings: contacts always local, AI wins elsewhere', () => {
    const local: Candidate[] = [
      { key: 'contact.email', value: 'a@b.co', confidence: 0.9, source: 'local' },
      { key: 'bio.headline', value: 'Local headline', confidence: 0.7, source: 'local' },
      { key: 'projects[0].name', value: 'Local project', confidence: 0.7, source: 'local' },
      { key: 'skills', value: ['Excel'], confidence: 0.8, source: 'local' },
    ];
    const ai: Candidate[] = [
      { key: 'contact.email', value: 'ai@b.co', confidence: 0.9, source: 'ai' },
      { key: 'bio.headline', value: 'AI headline', confidence: 0.8, source: 'ai' },
    ];
    expect(asMap(mergeCandidates(local, ai))).toEqual({
      'bio.headline': 'AI headline',
      'contact.email': 'a@b.co',
      'projects[0].name': 'Local project',
      skills: ['Excel'],
    });
  });
});
