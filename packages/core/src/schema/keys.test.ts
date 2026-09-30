import { describe, expect, it } from 'vitest';
import {
  KEY_GROUPS,
  KEY_REGISTRY,
  LIST_GROUPS,
  customKeyFor,
  getKeyDef,
  isValidFactKey,
  listItemKey,
  parseKey,
} from './keys';

describe('key registry', () => {
  it('has unique keys', () => {
    const keys = KEY_REGISTRY.map((d) => d.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('gives every key at least two aliases and one example', () => {
    const weak = KEY_REGISTRY.filter((d) => d.aliases.length < 2 || d.examples.length < 1);
    expect(weak.map((d) => d.key)).toEqual([]);
  });

  it('writes aliases lowercase and trimmed', () => {
    for (const def of KEY_REGISTRY) {
      for (const alias of def.aliases) expect(alias).toBe(alias.trim().toLowerCase());
    }
  });

  it('declares options for every enum key', () => {
    const missing = KEY_REGISTRY.filter((d) => d.valueType === 'enum' && !d.options?.length);
    expect(missing).toEqual([]);
  });

  it('uses only known groups, matching the key prefix', () => {
    for (const def of KEY_REGISTRY) {
      expect(KEY_GROUPS).toContain(def.group);
      expect(def.key.startsWith(def.group)).toBe(true);
    }
  });

  it('gives every list group an item schema backed by registry keys', () => {
    for (const [group, fields] of Object.entries(LIST_GROUPS)) {
      expect(fields.length).toBeGreaterThan(0);
      for (const field of fields) expect(getKeyDef(`${group}[].${field}`)).toBeDefined();
    }
    const listTemplates = KEY_REGISTRY.filter((d) => d.key.includes('[]'));
    for (const def of listTemplates) expect(Object.keys(LIST_GROUPS)).toContain(def.group);
  });

  it('covers the fields the Phase 0 fixture expects', () => {
    for (const key of [
      'person.name.full',
      'contact.email',
      'contact.phone.mobile',
      'address.city',
    ]) {
      expect(isValidFactKey(key)).toBe(true);
    }
  });
});

describe('parseKey', () => {
  it('parses scalar and list keys', () => {
    expect(parseKey('contact.email')).toEqual({ template: 'contact.email', group: 'contact' });
    expect(parseKey('projects[2].name')).toEqual({
      template: 'projects[].name',
      group: 'projects',
      index: 2,
    });
  });

  it.each([
    '',
    'Contact.email',
    'contact..email',
    'projects[x].name',
    'projects[-1].name',
    '1abc',
    'a.b-c',
  ])('rejects malformed key %j', (key) => expect(parseKey(key)).toBeNull());
});

describe('isValidFactKey', () => {
  it.each([
    ['contact.email', true],
    ['projects[0].name', true],
    ['education[3].degree', true],
    ['skills', true],
    ['custom.favorite_tools', true],
    ['projects[].name', false],
    ['projects.name', false],
    ['contact[0].email', false],
    ['contact.fax', false],
    ['custom.', false],
    ['custom.a.b', false],
  ])('%s → %s', (key, expected) => expect(isValidFactKey(key)).toBe(expected));
});

describe('helpers', () => {
  it('builds list item keys and rejects unknown fields', () => {
    expect(listItemKey('projects', 1, 'name')).toBe('projects[1].name');
    expect(() => listItemKey('projects', 0, 'budget')).toThrow();
    expect(() => listItemKey('projects', -1, 'name')).toThrow();
  });

  it('turns labels into valid custom keys', () => {
    expect(customKeyFor('Favourite Tools?')).toBe('custom.favourite_tools');
    expect(customKeyFor('  2nd language  ')).toBe('custom.n_2nd_language');
    expect(customKeyFor('???')).toBe('custom.field');
    for (const label of ['What is your go-to stack?', 'Café préféré', 'x'.repeat(100)]) {
      expect(isValidFactKey(customKeyFor(label))).toBe(true);
    }
  });

  it('looks up template and concrete keys alike', () => {
    expect(getKeyDef('projects[4].tech')?.label).toBe('Technologies used');
    expect(getKeyDef('projects[].tech')?.label).toBe('Technologies used');
    expect(getKeyDef('custom.x')).toBeUndefined();
  });
});
