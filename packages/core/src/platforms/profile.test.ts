import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { mapFields, type MapResult } from '../mapper/map';
import { createPolicy } from '../policy/deny';
import type { FieldDescriptor } from '../schema/records';
import {
  applyProfile,
  compileProfiles,
  detectProfile,
  neverClickByProfile,
  type CompiledProfile,
} from './profile';

const root = new URL('../../../../', import.meta.url);
const files = readdirSync(new URL('config/platforms/', root)).filter((f) => f.endsWith('.json'));
const raw = files.map(
  (f) => JSON.parse(readFileSync(new URL(`config/platforms/${f}`, root), 'utf8')) as unknown,
);
const profiles = compileProfiles(raw);
const byId = (id: string) => profiles.find((p) => p.profile.id === id)!;

const scan = (name: string): Array<FieldDescriptor & { ref: string }> =>
  (
    JSON.parse(
      readFileSync(new URL(`test-fixtures/__scans__/${name}.json`, root), 'utf8'),
    ) as Array<FieldDescriptor & { ref: string }>
  ).map((f, i) => ({ ...f, id: `0:f${i}` }));
const titleOf = (fixture: string) =>
  /<title>([^<]*)<\/title>/.exec(
    readFileSync(new URL(`test-fixtures/${fixture}.html`, root), 'utf8'),
  )![1]!;

describe('profile format (Task 11.2)', () => {
  it('every shipped profile is valid', () => {
    expect(profiles.map((p) => p.profile.id).sort()).toEqual(
      ['events', 'forms', 'freelance', 'jobs', 'personal-details', 'upwork'].sort(),
    );
  });

  it('refuses malformed profiles: bad regex, unknown key, extra fields, duplicate id', () => {
    const base = { id: 'x', name: 'X', family: 'forms' as const, match: { hosts: ['x.com'] } };
    expect(() => compileProfiles([{ ...base, fields: [{ label: '(', confidence: 1 }] }])).toThrow(
      /regular expression/,
    );
    expect(() =>
      compileProfiles([
        { ...base, fields: [{ label: 'a', canonicalKey: 'person.secret', confidence: 1 }] },
      ]),
    ).toThrow(/canonical key/);
    expect(() => compileProfiles([{ ...base, clickSubmit: true }])).toThrow(/invalid/);
    expect(() => compileProfiles([base, base])).toThrow(/Duplicate/);
  });
});

describe('detection (Task 11.3)', () => {
  it('by host: site-specific first, subdomains included', () => {
    const page = (url: string) => ({ url, title: '', fields: [] });
    expect(
      detectProfile(profiles, page('https://www.upwork.com/nx/create-profile'))?.profile.profile.id,
    ).toBe('upwork');
    expect(
      detectProfile(profiles, page('https://www.fiverr.com/seller_onboarding'))?.profile.profile.id,
    ).toBe('freelance');
    expect(
      detectProfile(profiles, page('https://acme.wd1.myworkdayjobs.com/careers'))?.profile.profile
        .id,
    ).toBe('jobs');
    expect(
      detectProfile(profiles, page('https://docs.google.com/forms/d/x/viewform'))?.profile.profile
        .id,
    ).toBe('forms');
    expect(
      detectProfile(profiles, page('https://unstop.com/hackathons/x'))?.profile.profile.id,
    ).toBe('events');
    expect(detectProfile(profiles, page('https://scholarships.gov.in/'))?.profile.profile.id).toBe(
      'personal-details',
    );
  });

  it.each([
    ['upwork-profile-like', 'freelance'],
    ['fiverr-seller-like', 'freelance'],
    ['job-application-like', 'jobs'],
    ['google-form-like', 'forms'],
    ['ai-understanding', 'events'],
    ['college-form-like', 'personal-details'],
    ['simple-contact', undefined],
    ['react-controlled', undefined],
    ['tricky', undefined],
    ['fill-lab', undefined],
  ])('by content on a site it does not know: %s → %s', (fixture, family) => {
    const found = detectProfile(profiles, {
      url: 'http://127.0.0.1:5178/x.html',
      title: titleOf(fixture),
      fields: scan(fixture),
    });
    expect(found?.profile.profile.id).toBe(family);
    if (found) expect(found.by).toBe('content');
  });
});

describe('applyProfile', () => {
  const ctx = { site: '127.0.0.1' };
  const run = (fixture: string, profile: CompiledProfile) => {
    const fields = scan(fixture);
    const base = Object.fromEntries(mapFields(fields, ctx));
    return { fields, base, ...applyProfile(profile, fields, base) };
  };

  it('fixes what generic rules get wrong, only where it is more confident', () => {
    const { fields, base, mappings } = run('college-form-like', byId('personal-details'));
    const id = (ref: string) => fields.find((f) => f.ref === ref)!.id;
    expect(base[id('category')]).toMatchObject({ canonicalKey: 'professional.category' });
    expect(mappings[id('category')]).toEqual({
      kind: 'choice',
      confidence: 0.97,
      reason:
        'College, scholarship or government-style form: Category is yours to choose; Filler never guesses it.',
      source: 'profile',
    });
    expect(mappings[id('income')]).toMatchObject({
      canonicalKey: 'custom.annual_family_income',
      source: 'profile',
    });
    // Father's name: the dictionary was already right; the profile is more confident and agrees.
    expect(mappings[id('father')]).toMatchObject({ canonicalKey: 'family.father_name' });
    // A never-fill field is never touched.
    expect(mappings[id('aadhaar')]).toEqual(base[id('aadhaar')]);
  });

  it('adds length windows and tips; leaves less confident rules alone', () => {
    const { fields, base, mappings, constraints } = run('upwork-profile-like', byId('freelance'));
    const id = (ref: string) => fields.find((f) => f.ref === ref)!.id;
    expect(constraints[id('overview')]).toEqual({
      lengthWindow: [1000, 5000],
      tip: "Open with the client's problem, show 2–3 results, end with how to start.",
    });
    expect(mappings[id('overview')]).toMatchObject({
      kind: 'open_ended',
      canonicalKey: 'bio.summary_long',
    });
    // Skills has no rule: untouched.
    expect(mappings[id('skills')]).toEqual(base[id('skills')]);
  });

  it('never maps a field the policy (with user phrases) refuses', () => {
    const fields = scan('college-form-like');
    const policy = createPolicy({ extraPatterns: ['annual family income'] });
    const base = Object.fromEntries(mapFields(fields, { site: 'x', policy }));
    const income = fields.find((f) => f.ref === 'income')!.id;
    expect(applyProfile(byId('personal-details'), fields, base, policy).mappings[income]).toEqual(
      base[income],
    );
  });

  it('profiles only add never-click texts', () => {
    expect(neverClickByProfile(byId('jobs').profile, 'Easy  Apply')).toBe(true);
    expect(neverClickByProfile(byId('jobs').profile, 'Next')).toBe(false);
    expect(neverClickByProfile(undefined, 'Apply')).toBe(false);
  });
});

/** PLAYBOOK 11.3 DONE: profiles never make things worse than the generic fallback. */
describe('accuracy with profiles vs generic fallback', () => {
  const fixtures = [
    'simple-contact',
    'google-form-like',
    'upwork-profile-like',
    'fiverr-seller-like',
    'react-controlled',
    'tricky',
    'job-application-like',
    'fill-lab',
    'college-form-like',
  ];
  const score = (useProfiles: boolean) => {
    let ok = 0;
    let total = 0;
    for (const name of fixtures) {
      const fields = scan(name);
      let mappings: Record<string, MapResult> = Object.fromEntries(
        mapFields(fields, { site: '127.0.0.1' }),
      );
      const found = useProfiles
        ? detectProfile(profiles, { url: 'http://127.0.0.1/', title: titleOf(name), fields })
        : undefined;
      if (found) mappings = applyProfile(found.profile, fields, mappings).mappings;
      const expected = (
        JSON.parse(readFileSync(new URL(`test-fixtures/${name}.expected.json`, root), 'utf8')) as {
          fields: Array<{ ref: string; kind: string; canonicalKey: string | null }>;
        }
      ).fields;
      for (const want of expected) {
        const got = mappings[fields.find((f) => f.ref === want.ref)!.id]!;
        total++;
        // Custom keys are the user's own names: only registry keys are scored (as in Phase 8).
        const key = got.canonicalKey?.startsWith('custom.') ? null : (got.canonicalKey ?? null);
        if (got.kind === want.kind && key === want.canonicalKey) ok++;
      }
    }
    return { ok, total };
  };

  it('profiles help or tie on every metric, and the generic fallback still meets Phase 5', () => {
    const generic = score(false);
    const withProfiles = score(true);
    console.log(
      `Rules only: ${generic.ok}/${generic.total}; with profiles: ${withProfiles.ok}/${withProfiles.total}`,
    );
    expect(generic.ok / generic.total).toBeGreaterThanOrEqual(0.85);
    expect(withProfiles.ok).toBeGreaterThanOrEqual(generic.ok);
  });
});
