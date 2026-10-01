/**
 * Résumé / LinkedIn-text import, on the device (PLAYBOOK Task 11.1).
 *
 * `extractContacts` finds contact details by pattern; they are never sent to
 * the AI (`withoutContacts` removes them from the text first).
 * `extractLocally` is the offline extractor: section headings, entries and
 * common phrasings ("Title, Company (Jul 2019 – Present)", "Name – what it
 * did"). It fills what it can; the AI `extract` mode adds the rest.
 * List-item keys use import-local indexes (0, 1, …); `planImport` maps them
 * onto the vault.
 */
import { formatIsoDate, parseLooseDate } from '../text/match';
import { redactText } from '../ai/redact';
import { normaliseLabel } from '../text/normalise';
import type { FactValue } from '../schema/records';

export interface Candidate {
  key: string;
  value: FactValue;
  confidence: number;
  source: 'local' | 'ai';
}

const EMAIL = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i;
const PHONE = /(?:\+\d{1,3}[\s.-]?)?(?:\(?\d{2,5}\)?[\s.-]?)?\d(?:[\s.-]?\d){7,11}/;
const URL_RE =
  /\b(?:https?:\/\/)?(?:www\.)?[a-z0-9-]+(?:\.[a-z0-9-]+)*\.(?:com|net|org|dev|io|in|me|co|app|design|site|page)(?:\/[^\s|,;)]*)?/gi;
const STATES =
  /^(?:maharashtra|karnataka|gujarat|tamil nadu|kerala|delhi|uttar pradesh|west bengal|rajasthan|telangana|andhra pradesh|punjab|haryana|madhya pradesh|bihar|goa|odisha|assam)$/i;

const MONTH = '(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\\.?';
const DATE = `(?:${MONTH}\\s+\\d{4}|\\d{1,2}/\\d{4}|\\d{4})`;
const RANGE = new RegExp(`(${DATE})\\s*(?:-|–|—|to)\\s*(${DATE}|present|current|now|ongoing)`, 'i');

const DEGREE =
  /\b(?:b\.?\s?tech|b\.?\s?e\b|b\.?\s?sc|b\.?\s?com|b\.?\s?a\b|bba|bca|m\.?\s?tech|m\.?\s?sc|m\.?\s?com|m\.?\s?a\b|mba|mca|m\.?\s?des|ph\.?\s?d|bachelor[a-z]*|master[a-z]*|diploma|class\s+(?:x|xii|10|12)|hsc|ssc)\b/i;
const INSTITUTION =
  /\b(?:university|college|institute|school|academy|iit|nit|iim|vidyalaya|polytechnic)\b/i;
const GRADE =
  /\b(?:c?gpa|grade|percentage)\s*[:-]?\s*(\d+(?:\.\d+)?(?:\s*\/\s*\d+)?)|\b(\d{2}(?:\.\d+)?)\s*%/i;

const HEADINGS: Array<[RegExp, Section]> = [
  [
    /^(?:summary|profile|about(?: me)?|objective|professional summary|career objective)$/,
    'summary',
  ],
  [/^(?:education|academics?|academic background|qualifications?)$/, 'education'],
  [
    /^(?:experience|work experience|employment(?: history)?|professional experience|work history|internships?)$/,
    'experience',
  ],
  [/^(?:projects?|personal projects|academic projects|portfolio)$/, 'projects'],
  [/^(?:skills|technical skills|key skills|core skills|skills and tools|tools)$/, 'skills'],
  [/^(?:certifications?|certificates|licenses?(?: and certifications)?)$/, 'certifications'],
  [/^(?:languages?|languages known)$/, 'languages'],
  [/^(?:contact|contact details|links|personal details)$/, 'contact'],
];
type Section =
  | 'top'
  | 'summary'
  | 'education'
  | 'experience'
  | 'projects'
  | 'skills'
  | 'certifications'
  | 'languages'
  | 'contact';

const tidy = (s: string) =>
  s
    .replace(/\s+/g, ' ')
    .replace(/^[\s•*·\-–|,]+|[\s•*·|,;]+$/g, '')
    .trim();
const isBullet = (line: string) => /^\s*[•*·\-–]\s+/.test(line);
const withHttps = (url: string) => (/^https?:\/\//i.test(url) ? url : `https://${url}`);

function headingOf(line: string): Section | null {
  const t = normaliseLabel(line.replace(/:$/, ''));
  if (!t || t.split(' ').length > 4) return null;
  return HEADINGS.find(([re]) => re.test(t))?.[1] ?? null;
}

/** Splits text into sections by heading lines. Lines before the first heading are `top`. */
export function sections(text: string): Map<Section, string[]> {
  const out = new Map<Section, string[]>([['top', []]]);
  let current: Section = 'top';
  for (const raw of text.replace(/\r/g, '').split('\n')) {
    const heading = headingOf(raw.trim());
    if (heading) {
      current = heading;
      if (!out.has(current)) out.set(current, []);
      continue;
    }
    out.get(current)!.push(raw.trimEnd());
  }
  return out;
}

/** True when blank lines separate entries inside a section (not just trail it). */
const blankSeparated = (lines: string[]) => {
  const first = lines.findIndex((l) => l.trim());
  const last = lines.length - 1 - [...lines].reverse().findIndex((l) => l.trim());
  return lines.slice(first, last + 1).some((l) => !l.trim());
};

/**
 * Entries in a section: separated by blank lines; or, when there are none, a
 * new entry starts at a line matching `starter` once the current entry
 * already has one (e.g. a second degree, a second date range).
 */
function entries(lines: string[], starter: RegExp): string[][] {
  const blocks: string[][] = [];
  let block: string[] = [];
  const byBlank = blankSeparated(lines);
  for (const line of lines) {
    if (!line.trim()) {
      if (byBlank && block.length) {
        blocks.push(block);
        block = [];
      }
      continue;
    }
    if (!byBlank && !isBullet(line) && starter.test(line) && block.some((l) => starter.test(l))) {
      blocks.push(block);
      block = [];
    }
    block.push(line);
  }
  if (block.length) blocks.push(block);
  return blocks;
}

function dateValue(text: string): string | undefined {
  if (/^(?:present|current|now|ongoing)$/i.test(text.trim())) return undefined;
  if (/^\d{4}$/.test(text.trim())) return text.trim();
  const d = parseLooseDate(text.replace(/\./g, ''));
  return d ? formatIsoDate(d) : text.trim();
}

/** Contact details by pattern: kept on the device. */
export function extractContacts(text: string): Candidate[] {
  const out: Candidate[] = [];
  const add = (key: string, value: string, confidence = 0.95) => {
    if (value && !out.some((c) => c.key === key))
      out.push({ key, value, confidence, source: 'local' });
  };
  const email = EMAIL.exec(text)?.[0];
  if (email) add('contact.email', email.toLowerCase());
  const lines = text
    .replace(/\r/g, '')
    .split('\n')
    .map((l) => l.trim());
  for (const line of lines) {
    const phoneLine = line.replace(EMAIL, ' ').replace(URL_RE, ' ');
    const phone = PHONE.exec(phoneLine)?.[0];
    if (phone && phone.replace(/\D/g, '').length >= 10 && !RANGE.test(phone)) {
      add('contact.phone.mobile', phone.trim().replace(/\s+/g, ' '));
      break;
    }
  }
  for (const m of text.matchAll(URL_RE)) {
    const url = m[0].replace(/[.)]+$/, '');
    // Degrees like "B.Com" or "M.Sc" are not websites.
    if (!/^(?:https?:\/\/|www\.)/i.test(url) && /^[a-z]{1,2}\./i.test(url)) continue;
    if (
      EMAIL.test(text.slice(Math.max(0, m.index! - 40), m.index! + url.length)) &&
      !url.includes('/')
    )
      continue; // the domain part of an email address
    if (/linkedin\.com\/in\//i.test(url)) add('links.linkedin', withHttps(url));
    else if (/github\.com\/[^/\s]+\/?$/i.test(url)) add('links.github', withHttps(url));
    else if (/behance\.net\//i.test(url)) add('links.behance', withHttps(url));
    else if (/dribbble\.com\//i.test(url)) add('links.dribbble', withHttps(url));
    else if (!/github\.com|linkedin\.com|example\.(?:com|org|net)$/i.test(url))
      add('links.portfolio', withHttps(url), 0.7);
  }
  // Name: the first line, if it looks like 2–4 name words.
  const first = lines.find((l) => l);
  if (
    first &&
    /^[A-Za-z][A-Za-z.'-]+(?:\s+[A-Za-z][A-Za-z.'-]+){1,3}$/.test(first) &&
    !headingOf(first)
  ) {
    const name =
      first === first.toUpperCase()
        ? first.toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase())
        : first;
    add('person.name.full', name, 0.85);
  }
  // Location: "Location: Pune, Maharashtra", or a "City, State[, Country]" line near the top.
  const loc =
    /^(?:location|address|city|based in)\s*[:-]\s*(.+)$/i.exec(
      lines.find((l) => /^(?:location|address|city|based in)\s*[:-]/i.test(l)) ?? '',
    )?.[1] ??
    lines.slice(0, 6).find((l) => {
      const parts = l.split(',').map((p) => p.trim());
      return parts.length >= 2 && parts.length <= 3 && STATES.test(parts[1] ?? '');
    });
  if (loc) {
    const [city, state, country] = loc.split(',').map((p) => p.trim());
    if (city) add('address.city', city, 0.8);
    if (state && STATES.test(state)) add('address.state', state, 0.8);
    if (country) add('address.country', country, 0.7);
  }
  const dob = /\b(?:date of birth|dob|born)\s*[:-]?\s*([^\n|]+)/i.exec(text)?.[1];
  const d = dob ? parseLooseDate(dob.trim()) : null;
  if (d?.day) add('person.dob', formatIsoDate(d), 0.9);
  return out;
}

/** The text with contact details (and anything else PII-shaped) removed, for the AI. */
export function withoutContacts(text: string): string {
  return redactText(
    text
      .replace(EMAIL, '[email]')
      .replace(URL_RE, (u) => (/github\.com\/[^/\s]+\/[^/\s]+/i.test(u) ? u : '[link]'))
      .replace(/\b(?:date of birth|dob|born)\s*[:-]?[^\n|]*/gi, '[date of birth]')
      .replace(/^(?:location|address)\s*[:-].*$/gim, '[location]'),
  );
}

function languagesFrom(lines: string[]): Candidate[] {
  const out: Candidate[] = [];
  const text = lines.join(', ');
  let i = 0;
  for (const part of text.split(/[,;]|\s·\s/)) {
    const m = /^\s*([A-Za-z][A-Za-z ]{1,30}?)\s*(?:[(\-–:]\s*([A-Za-z ]+?)\s*\)?)?\s*$/.exec(part);
    if (!m) continue;
    const level = (m[2] ?? '').toLowerCase();
    const proficiency = /native|mother/.test(level)
      ? 'Native'
      : /fluent|proficient|professional|advanced/.test(level)
        ? 'Fluent'
        : /conversational|intermediate|working/.test(level)
          ? 'Conversational'
          : /basic|beginner|elementary/.test(level)
            ? 'Basic'
            : undefined;
    out.push({
      key: `languages[${i}].language`,
      value: tidy(m[1]!),
      confidence: 0.85,
      source: 'local',
    });
    if (proficiency)
      out.push({
        key: `languages[${i}].proficiency`,
        value: proficiency,
        confidence: 0.8,
        source: 'local',
      });
    i++;
  }
  return out;
}

function skillsFrom(lines: string[]): string[] {
  const items = lines
    .flatMap((l) => l.replace(/^[^:]{1,30}:\s*/, '').split(/[,;|•·]/))
    .map((s) => tidy(s))
    .filter((s) => s && s.length <= 40 && s.split(' ').length <= 4);
  return [...new Map(items.map((s) => [s.toLowerCase(), s])).values()].slice(0, 40);
}

function educationFrom(lines: string[]): Candidate[] {
  const out: Candidate[] = [];
  entries(lines, DEGREE).forEach((block, i) => {
    const all = block.join(' | ');
    const parts = all
      .split(/\s*[|,]\s*/)
      .map((p) =>
        tidy(
          p
            .replace(/\([^)]*\)/g, '')
            .replace(RANGE, '')
            .replace(/\b\d{4}\s*(?:-|–|—|to)\s*\d{4}\b/, ''),
        ),
      )
      .filter(Boolean);
    const add = (field: string, value: string | undefined, confidence = 0.8) => {
      if (value) out.push({ key: `education[${i}].${field}`, value, confidence, source: 'local' });
    };
    const degreePart = parts.find((p) => DEGREE.test(p));
    if (degreePart) {
      const m = /^(.*?)\s+in\s+(.+)$/i.exec(degreePart);
      add('degree', tidy(m ? m[1]! : degreePart));
      // "Master of Design, Interaction Design": the part after the degree is the field.
      const next = parts[parts.indexOf(degreePart) + 1];
      const field = m
        ? m[2]
        : next && !INSTITUTION.test(next) && !GRADE.test(next) && !/\d{4}/.test(next)
          ? next
          : undefined;
      if (field) add('field', tidy(field));
    }
    add(
      'institution',
      parts.find((p) => INSTITUTION.test(p) && p !== degreePart),
    );
    const range = RANGE.exec(all) ?? /(\d{4})\s*(?:-|–|—|to)\s*(\d{4})/.exec(all);
    if (range) {
      add('start', dateValue(range[1]!), 0.75);
      add('end', dateValue(range[2]!), 0.75);
    }
    const g = GRADE.exec(all);
    if (g)
      add('grade', tidy(g[1] ? `${/gpa/i.test(g[0]) ? 'CGPA ' : ''}${g[1]}` : `${g[2]}%`), 0.75);
  });
  return out;
}

function experienceFrom(lines: string[]): Candidate[] {
  const out: Candidate[] = [];
  entries(lines, RANGE).forEach((block, i) => {
    const add = (field: string, value: string | undefined, confidence = 0.75) => {
      if (value) out.push({ key: `experience[${i}].${field}`, value, confidence, source: 'local' });
    };
    const head = block.filter((l) => !isBullet(l));
    if (!head.length) return; // stray bullets with no job line
    const headText = head.join(' | ');
    const range = RANGE.exec(headText);
    if (range) {
      add('start', dateValue(range[1]!));
      add('end', dateValue(range[2]!));
    }
    const first = tidy(head[0]!.replace(/\(.*?\)/g, '').replace(RANGE, ''));
    let title: string | undefined;
    let company: string | undefined;
    const pipe = first.split(/\s*\|\s*/).filter(Boolean);
    if (pipe.length >= 2) [title, company] = pipe;
    else if (/,\s/.test(first)) [title, company] = first.split(/,\s*/, 2);
    else if (/\s+at\s+/i.test(first)) [title, company] = first.split(/\s+at\s+/i, 2);
    else if (/\s[–—-]\s/.test(first)) [company, title] = first.split(/\s[–—-]\s/, 2);
    else if (head[1]) {
      // LinkedIn style: title on one line, "Company · Full-time" on the next.
      title = first;
      company = head[1].split(/\s·\s/)[0];
    } else title = first;
    add('title', title && tidy(title));
    add('company', company && tidy(company));
    const desc = block
      .filter(
        (l, idx) => isBullet(l) || (idx > 0 && !RANGE.test(l) && !/·/.test(l) && l !== head[1]),
      )
      .map((l) => tidy(l))
      .filter(Boolean)
      .join(' ');
    if (desc) add('description', desc, 0.7);
  });
  return out;
}

function projectsFrom(lines: string[]): Candidate[] {
  const out: Candidate[] = [];
  const blocks: string[][] = [];
  if (blankSeparated(lines)) blocks.push(...entries(lines, /$^/));
  else
    for (const line of lines.filter((l) => l.trim())) {
      if (
        (isBullet(line) || /^\s*(?:tech(?:nologies)?|stack|built with)\s*:/i.test(line)) &&
        blocks.length
      )
        blocks[blocks.length - 1]!.push(line);
      else blocks.push([line]);
    }
  blocks.forEach((block, i) => {
    const add = (field: string, value: FactValue | undefined, confidence = 0.75) => {
      if (value !== undefined && value !== '')
        out.push({ key: `projects[${i}].${field}`, value, confidence, source: 'local' });
    };
    const all = block.join(' ');
    const m = /^\s*[•*·-]?\s*([^:–—]{2,60}?)\s*(?::|–|—|\s-\s)\s*(.+)$/.exec(block[0]!);
    const tech =
      /\b(?:tech(?:nologies)?|stack|built with)\s*:\s*([^.\n]+?)(?:\.\s|\s+https?:|$)/i.exec(all);
    const url = /https?:\/\/\S+/.exec(all)?.[0];
    add('name', tidy(m ? m[1]! : block[0]!));
    let description = m ? m[2]! : block.slice(1).join(' ');
    description = description
      .replace(/\b(?:tech(?:nologies)?|stack|built with)\s*:.*/i, '')
      .replace(/https?:\/\/\S+/, '');
    add('description', tidy(description), 0.7);
    if (tech) add('tech', tech[1]!.split(/[,;]/).map(tidy).filter(Boolean), 0.75);
    if (url) add('url', url.replace(/[.)]+$/, ''), 0.8);
  });
  return out;
}

function certificationsFrom(lines: string[]): Candidate[] {
  return lines
    .filter((l) => l.trim())
    .flatMap((line, i) => {
      const m = /^\s*[•*·-]?\s*(.+?)(?:\s+(?:-|–|by)\s+([^,]+?))?(?:,\s*(\d{4}))?\s*$/.exec(line)!;
      return [
        {
          key: `certifications[${i}].name`,
          value: tidy(m[1]!),
          confidence: 0.75,
          source: 'local' as const,
        },
        ...(m[2]
          ? [
              {
                key: `certifications[${i}].issuer`,
                value: tidy(m[2]),
                confidence: 0.7,
                source: 'local' as const,
              },
            ]
          : []),
        ...(m[3]
          ? [
              {
                key: `certifications[${i}].year`,
                value: m[3],
                confidence: 0.75,
                source: 'local' as const,
              },
            ]
          : []),
      ];
    });
}

/** Offline extraction: everything the patterns can find. */
export function extractLocally(text: string): Candidate[] {
  const secs = sections(text);
  const out: Candidate[] = [...extractContacts(text)];
  const top = (secs.get('top') ?? []).map((l) => l.trim()).filter(Boolean);
  // Headline: the second line at the top when it reads like a title (no contact details, no date).
  const headline = top[1];
  const isPlace = (l: string) => STATES.test(l.split(',')[1]?.trim() ?? '');
  if (
    headline &&
    headline.length <= 120 &&
    !EMAIL.test(headline) &&
    !PHONE.test(headline) &&
    !/:|https?:|\.com|\.in\b/i.test(headline) &&
    !isPlace(headline)
  )
    out.push({ key: 'bio.headline', value: tidy(headline), confidence: 0.7, source: 'local' });
  const summary = (secs.get('summary') ?? [])
    .map((l) => l.trim())
    .filter(Boolean)
    .join(' ');
  if (summary) {
    out.push({ key: 'bio.summary_long', value: summary, confidence: 0.75, source: 'local' });
    const firstSentence = /^(.{20,220}?[.!?])(?:\s|$)/.exec(summary)?.[1];
    if (firstSentence)
      out.push({
        key: 'bio.summary_short',
        value: firstSentence,
        confidence: 0.6,
        source: 'local',
      });
  }
  const years = /\b(\d{1,2})\+?\s+years?\s+of\s+(?:\w+\s+)?experience/i.exec(text)?.[1];
  if (years)
    out.push({
      key: 'professional.years_experience',
      value: years,
      confidence: 0.75,
      source: 'local',
    });
  const skills = skillsFrom(secs.get('skills') ?? []);
  if (skills.length) out.push({ key: 'skills', value: skills, confidence: 0.85, source: 'local' });
  out.push(...educationFrom(secs.get('education') ?? []));
  out.push(...experienceFrom(secs.get('experience') ?? []));
  out.push(...projectsFrom(secs.get('projects') ?? []));
  out.push(...certificationsFrom(secs.get('certifications') ?? []));
  out.push(...languagesFrom((secs.get('languages') ?? []).filter((l) => l.trim())));
  out.push(
    ...extractContacts((secs.get('contact') ?? []).join('\n')).filter(
      (c) => !out.some((o) => o.key === c.key),
    ),
  );
  return out;
}
