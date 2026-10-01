/**
 * Import review (PLAYBOOK Task 11.1): candidates from a résumé, merged with
 * what the vault already holds. Each row says whether the detail is new,
 * the same as saved, different from saved, or (for lists like skills) adds
 * items. New details are ticked by default; anything that would change a
 * saved value is not, so nothing is overwritten unless the user says so.
 * Repeating items (jobs, degrees, projects…) are matched to saved ones by
 * their identity fields, and new ones are appended after the saved ones.
 */
import { detectSensitiveValue } from '../policy/deny';
import { getKeyDef, parseKey, type ListGroup } from '../schema/keys';
import type { Fact, FactValue } from '../schema/records';
import { similarity } from '../text/match';
import type { Candidate } from './extract';

export type ImportStatus = 'new' | 'same' | 'different' | 'adds';

export interface ImportRow {
  /** The vault key this row would be saved under. */
  key: string;
  section: string;
  label: string;
  value: FactValue;
  existing?: FactValue;
  status: ImportStatus;
  accept: boolean;
  source: 'local' | 'ai';
}

const IDENTITY: Record<ListGroup, string[]> = {
  education: ['institution', 'degree'],
  experience: ['company', 'title'],
  projects: ['name'],
  certifications: ['name'],
  languages: ['language'],
};
const LIST_GROUPS = new Set(Object.keys(IDENTITY));

const SECTIONS: Record<string, string> = {
  person: 'About you',
  bio: 'About you',
  professional: 'About you',
  contact: 'Contact',
  address: 'Contact',
  links: 'Links',
  skills: 'Skills',
  education: 'Education',
  experience: 'Work history',
  projects: 'Projects',
  certifications: 'Certifications',
  languages: 'Languages',
  preferences: 'Preferences',
  custom: 'Other',
};

const text = (v: FactValue) => (Array.isArray(v) ? v.join(', ') : v);
const same = (a: FactValue, b: FactValue) =>
  text(a).trim().toLowerCase().replace(/\s+/g, ' ') ===
  text(b).trim().toLowerCase().replace(/\s+/g, ' ');

/**
 * Local and AI candidates combined. Contact details always come from the
 * device; for everything else the AI's reading wins, and the local extractor
 * fills keys (or whole repeating sections) the AI did not return.
 */
export function mergeCandidates(
  local: readonly Candidate[],
  ai: readonly Candidate[],
): Candidate[] {
  const isContact = (k: string) => /^(?:contact|links|person\.name|person\.dob|address)\b/.test(k);
  const aiGroups = new Set(
    ai.map((c) => parseKey(c.key)?.group).filter((g) => g && LIST_GROUPS.has(g)),
  );
  const out = ai.filter((c) => !isContact(c.key));
  for (const c of local) {
    const group = parseKey(c.key)?.group;
    if (isContact(c.key)) out.push(c);
    else if (group && LIST_GROUPS.has(group)) {
      if (!aiGroups.has(group)) out.push(c);
    } else if (!out.some((o) => o.key === c.key)) out.push(c);
  }
  return out;
}

export function planImport(
  candidates: readonly Candidate[],
  existing: readonly Fact[],
): ImportRow[] {
  const saved = new Map(existing.map((f) => [f.key, f.value]));
  const rows: ImportRow[] = [];
  const usable = candidates.filter((c) => {
    const values = Array.isArray(c.value) ? c.value : [c.value];
    return values.length > 0 && values.every((v) => v.trim() && detectSensitiveValue(v) === null);
  });

  const row = (c: Candidate, key: string, label: string) => {
    const old = saved.get(key);
    let status: ImportStatus =
      old === undefined ? 'new' : same(old, c.value) ? 'same' : 'different';
    let value = c.value;
    if (status === 'different' && Array.isArray(old) && Array.isArray(c.value)) {
      // Lists (skills, tech) are merged, not replaced.
      const lower = new Set(old.map((s) => s.toLowerCase()));
      const added = c.value.filter((s) => !lower.has(s.toLowerCase()));
      value = [...old, ...added];
      status = added.length ? 'adds' : 'same';
    }
    rows.push({
      key,
      section: SECTIONS[parseKey(key)?.group ?? ''] ?? 'Other',
      label,
      value,
      ...(old !== undefined ? { existing: old } : {}),
      status,
      accept: status === 'new' || status === 'adds',
      source: c.source,
    });
  };

  // Scalars.
  for (const c of usable) {
    const parsed = parseKey(c.key);
    if (!parsed || parsed.index !== undefined) continue;
    row(c, c.key, getKeyDef(c.key)?.label ?? c.key.replace(/^custom\./, '').replace(/_/g, ' '));
  }

  // Repeating sections: match to saved items, else append.
  for (const group of Object.keys(IDENTITY) as ListGroup[]) {
    const items = new Map<number, Candidate[]>();
    for (const c of usable) {
      const p = parseKey(c.key);
      if (p?.group === group && p.index !== undefined)
        items.set(p.index, [...(items.get(p.index) ?? []), c]);
    }
    if (!items.size) continue;
    const savedIndexes = [...saved.keys()]
      .map((k) => parseKey(k))
      .filter((p) => p?.group === group && p.index !== undefined)
      .map((p) => p!.index!);
    let next = savedIndexes.length ? Math.max(...savedIndexes) + 1 : 0;
    const identityOf = (lookup: (field: string) => FactValue | undefined) =>
      IDENTITY[group]
        .map((f) => text(lookup(f) ?? ''))
        .join(' ')
        .trim();
    const taken = new Set<number>();
    for (const [, fields] of [...items.entries()].sort((a, b) => a[0] - b[0])) {
      const field = (name: string) => fields.find((c) => c.key.endsWith(`].${name}`))?.value;
      const id = identityOf(field);
      const match = [...new Set(savedIndexes)].find(
        (i) =>
          !taken.has(i) &&
          id &&
          similarity(
            identityOf((f) => saved.get(`${group}[${i}].${f}`)),
            id,
          ) >= 0.85,
      );
      const index = match ?? next++;
      taken.add(index);
      const title =
        text(field(IDENTITY[group][0]!) ?? field(IDENTITY[group][1] ?? '') ?? '') ||
        `item ${index + 1}`;
      for (const c of fields) {
        const name = c.key.slice(c.key.indexOf('].') + 2);
        const key = `${group}[${index}].${name}`;
        const def = getKeyDef(key);
        if (!def) continue;
        row(c, key, `${def.label} (${title})`);
      }
    }
  }
  return rows;
}
