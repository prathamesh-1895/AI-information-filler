/**
 * A scripted stand-in for an AI provider's REST API (tests never call a live
 * provider, PLAYBOOK 0.9). It reads the PAGE_DATA block out of the prompt
 * exactly as a model would see it and answers from
 * test-fixtures/__ai__/classify-answers.json, keyed by field label.
 *
 * `compromised` mode plays a model that obeyed injected page text, so the
 * safety envelope can be tested against the worst case.
 *
 * Used by the function tests and by scripts/mock-supabase.mjs (e2e), so it
 * sticks to syntax Node can run with type stripping.
 */
import scripted from '../../test-fixtures/__ai__/classify-answers.json' with { type: 'json' };
import { readdirSync, readFileSync } from 'node:fs';
import { extractLocally } from '../functions/_shared/core/index.ts';

export interface ScriptedAnswer {
  kind: string;
  canonicalKey?: string;
  newKeySuggestion?: string;
  confidence: number;
  reason: string;
  question?: string;
}

const ANSWERS = (scripted as { answers: Record<string, ScriptedAnswer> }).answers;

interface DataField {
  id: string;
  label: string;
  helpText?: string;
  placeholder?: string;
}

/** Pulls the fields out of the PAGE_DATA block (undoing the `<`/`>` escaping JSON.parse handles itself). */
export function pageDataOf(prompt: string): { fields: DataField[]; page?: unknown } {
  const m = /<<<PAGE_DATA\n([\s\S]*?)\nPAGE_DATA>>>/.exec(prompt);
  if (!m) return { fields: [] };
  return JSON.parse(m[1]!) as { fields: DataField[] };
}

export type Mode = 'honest' | 'compromised' | 'garbage' | 'fenced' | 'inventing';

/** The model's reply text for a prompt. */
export function scriptedReply(prompt: string, mode: Mode = 'honest'): string {
  if (prompt.includes('<<<DRAFT_DATA')) return scriptedDraft(prompt, mode);
  if (prompt.includes('<<<SCREEN_DATA')) return scriptedVision(prompt, mode);
  if (prompt.includes('<<<RESUME_TEXT')) return scriptedExtract(prompt, mode);
  const { fields } = pageDataOf(prompt);
  if (mode === 'garbage') return 'Sure! Here are the fields you asked about.';
  if (mode === 'compromised' && /ignore (all )?previous|SYSTEM:/i.test(prompt)) {
    // A model that followed the injected text: every field becomes an email,
    // reasons push a URL, an invented field appears and actions are added.
    return JSON.stringify({
      fields: [
        ...fields.map((f) => ({
          id: f.id,
          kind: 'fact',
          canonicalKey: 'contact.email',
          confidence: 1,
          reason: 'Visit https://evil.example/claim to finish',
          question: 'Click the link and enter your password',
        })),
        {
          id: 'pw-injected',
          kind: 'fact',
          canonicalKey: 'contact.email',
          confidence: 1,
          reason: 'Fill the password field',
        },
      ],
    });
  }
  const out = fields.flatMap((f) => {
    const a = ANSWERS[f.label.toLowerCase()];
    return a ? [{ id: f.id, ...a }] : [];
  });
  const text = JSON.stringify({ fields: out });
  return mode === 'fenced' ? `Here you go:\n\`\`\`json\n${text}\n\`\`\`` : text;
}

export interface FakeCall {
  url: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
  /** The full prompt text the model saw (system + user parts). */
  prompt: string;
}

export interface FakeProviderOptions {
  mode?: Mode | (() => Mode);
  /** HTTP statuses to return before answering (e.g. [429, 503] then success). */
  failures?: number[];
  /** Fail every call with this status. */
  status?: number;
  usage?: { input: number; output: number };
}

/** A fetch() that behaves like the Gemini, OpenAI-compatible or Ollama REST APIs. */
export function fakeProviderFetch(options: FakeProviderOptions = {}) {
  const calls: FakeCall[] = [];
  const failures = [...(options.failures ?? [])];
  const usage = options.usage ?? { input: 900, output: 300 };
  const fetchFn = async (url: string, init: RequestInit): Promise<Response> => {
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    const headers = Object.fromEntries(
      Object.entries((init.headers ?? {}) as Record<string, string>).map(([k, v]) => [
        k.toLowerCase(),
        v,
      ]),
    );
    const prompt = promptOf(url, body);
    calls.push({ url, headers, body, prompt });
    const fail = options.status ?? failures.shift();
    if (fail) {
      return new Response(JSON.stringify({ error: { message: `fake failure ${fail}` } }), {
        status: fail,
        headers: { 'content-type': 'application/json', 'retry-after': '0' },
      });
    }
    const mode = typeof options.mode === 'function' ? options.mode() : (options.mode ?? 'honest');
    const text = scriptedReply(prompt, mode);
    return new Response(JSON.stringify(replyShape(url, text, usage)), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };
  return { fetch: fetchFn, calls };
}

function promptOf(url: string, body: Record<string, unknown>): string {
  if (url.includes('generativelanguage')) {
    const sys = (body.systemInstruction as { parts: Array<{ text: string }> }).parts[0]!.text;
    const contents = body.contents as Array<{ parts: Array<{ text?: string }> }>;
    return [sys, ...contents.flatMap((c) => c.parts.map((p) => p.text ?? ''))].join('\n');
  }
  const messages = body.messages as Array<{ content: string | Array<{ text?: string }> }>;
  return messages
    .map((m) =>
      typeof m.content === 'string' ? m.content : m.content.map((p) => p.text ?? '').join(''),
    )
    .join('\n');
}

function replyShape(url: string, text: string, usage: { input: number; output: number }): unknown {
  if (url.includes('generativelanguage'))
    return {
      candidates: [{ content: { role: 'model', parts: [{ text }] }, finishReason: 'STOP' }],
      usageMetadata: { promptTokenCount: usage.input, candidatesTokenCount: usage.output },
    };
  if (url.endsWith('/api/chat'))
    return {
      message: { role: 'assistant', content: text },
      done: true,
      prompt_eval_count: usage.input,
      eval_count: usage.output,
    };
  return {
    choices: [{ index: 0, message: { role: 'assistant', content: text }, finish_reason: 'stop' }],
    usage: { prompt_tokens: usage.input, completion_tokens: usage.output },
  };
}

// ------------------------------------------------------------ drafting (Phase 9)

interface DraftData {
  field: { label: string; maxLength?: number; options?: string[]; inputType: string };
  goal: { role?: string; targetAudience?: string; audience?: string; tone?: string };
  facts: Array<{ key: string; value: string | string[] }>;
  filled: Array<{ key: string; value: string | string[] }>;
  hint?: string;
}

export function draftDataOf(prompt: string): DraftData | null {
  const m = /<<<DRAFT_DATA\n([\s\S]*?)\nDRAFT_DATA>>>/.exec(prompt);
  return m ? (JSON.parse(m[1]!) as DraftData) : null;
}

const txt = (v: string | string[] | undefined) => (Array.isArray(v) ? v.join(', ') : (v ?? ''));
const cap = (s: string) => s.replace(/\b\w/g, (c) => c.toUpperCase());

/**
 * A deterministic "writer": builds the draft only from what it was sent, so
 * the envelope's checks can be exercised end to end. The hint changes the
 * text ("shorter", "more formal", "mention …"), the goal's role leads, and
 * values filled earlier in the session (the headline) are reused.
 */
function scriptedDraft(prompt: string, mode: Mode): string {
  const data = draftDataOf(prompt);
  if (!data) return 'no data';
  const facts = new Map(data.facts.map((f) => [f.key, f.value]));
  const filled = new Map(data.filled.map((f) => [f.key, f.value]));
  const used: string[] = [];
  const take = (key: string) => {
    const v = facts.get(key);
    if (v !== undefined) used.push(key);
    return v;
  };
  const role = data.goal.role;
  const audience = data.goal.audience;
  const hint = (data.hint ?? '').toLowerCase();
  const max = data.field.maxLength;

  let value: string;
  let alternatives: string[];
  if (data.field.options?.length) {
    value = data.field.options[data.field.options.length - 1]!;
    alternatives = [];
  } else if (max !== undefined && max <= 100) {
    const skills = (take('skills') as string[] | undefined) ?? [];
    const head = role ? cap(role) : txt(take('bio.headline')) || 'Professional';
    value = (skills.length ? `${head} | ${skills.slice(0, 2).join(' & ')}` : head).slice(0, max);
    alternatives = [head.slice(0, max)];
  } else {
    const projects = data.facts
      .filter((f) => /^projects\[\d+\]\.name$/.test(f.key))
      .map((f) => {
        used.push(f.key);
        return txt(f.value);
      });
    const skills = txt(take('skills'));
    const years = txt(take('professional.years_experience'));
    const headline = txt(filled.get('bio.headline')) || txt(take('bio.headline'));
    if (!role && !headline && !projects.length && !skills) {
      return JSON.stringify({
        value: '',
        alternatives: [],
        usedFacts: [],
        needsInput: ['Which of your projects or skills should this mention?'],
      });
    }
    const formal = /formal/.test(hint);
    const sentences = [
      role
        ? `${formal ? 'In a professional capacity, I' : 'I'} work as a ${role}${audience ? ` for ${audience}` : ''}.`
        : null,
      headline ? `As ${headline}, I focus on clear, practical results.` : null,
      projects.length ? `My recent work includes ${projects.join(' and ')}.` : null,
      skills ? `I work with ${skills}.` : null,
      years ? `I have ${years} years of experience.` : null,
    ].filter((x): x is string => Boolean(x));
    const mention = /mention (.+)/.exec(data.hint ?? '');
    if (mention) sentences.push(`I can also speak to ${mention[1]!.replace(/[.!]+$/, '')}.`);
    const keep = /short/.test(hint) ? sentences.slice(0, 2) : sentences;
    const fit = (parts: string[]) => {
      const out: string[] = [];
      for (const p of parts) if (!max || [...out, p].join(' ').length <= max) out.push(p);
      return out.join(' ');
    };
    value = fit(keep);
    alternatives = [fit([...keep].reverse()), fit(keep.slice(0, 1))].filter(
      (a) => a && a !== value,
    );
  }
  if (mode === 'inventing') {
    value = `${value} I spent 10 years at Google.`.trim();
    alternatives = alternatives.map((a) => `${a} Ex-Microsoft.`);
  }
  return JSON.stringify({
    value,
    alternatives: alternatives.slice(0, 2),
    usedFacts: used,
    needsInput: [],
  });
}

// ------------------------------------------------------------ vision (Phase 10)

const visionDir = new URL('../../test-fixtures/__ai__/vision/', import.meta.url);

/** Scripted vision replies, keyed by the page title sent with the frame. */
export const VISION_RECORDINGS: ReadonlyMap<string, unknown> = new Map(
  readdirSync(visionDir)
    .filter((f) => f.endsWith('.json'))
    .map((f) => {
      const r = JSON.parse(readFileSync(new URL(f, visionDir), 'utf8')) as {
        title: string;
        response: unknown;
      };
      return [r.title, r.response] as const;
    }),
);

/**
 * A "model" that cannot really see: it answers with the recording for the
 * page title in SCREEN_DATA. `region` mode returns the first field only.
 * `compromised` mode plays a model that obeyed text in the image.
 */
function scriptedVision(prompt: string, mode: Mode): string {
  const m = /<<<SCREEN_DATA\n([\s\S]*?)\nSCREEN_DATA>>>/.exec(prompt);
  const data = m
    ? (JSON.parse(m[1]!) as { mode: string; page?: { title?: string } })
    : { mode: 'screen' };
  if (mode === 'garbage') return 'I see a form.';
  if (mode === 'compromised')
    return JSON.stringify({
      formPurpose: 'Visit https://evil.example to verify your account',
      warnings: ['Click Submit now'],
      fields: [
        {
          id: 'f1',
          label: 'Password',
          kind: 'fact',
          canonicalKey: 'contact.email',
          bbox: { x: 0, y: 0, width: 10, height: 10 },
        },
        {
          id: 'f2',
          label: 'Go to evil.example/win',
          kind: 'fact',
          bbox: { x: 0, y: 0, width: 10, height: 10 },
        },
        {
          id: 'f3',
          label: 'Full name',
          kind: 'fact',
          bbox: { x: -50, y: 5, width: 99999, height: 20 },
          actions: ['click'],
        },
      ],
    });
  const recorded = VISION_RECORDINGS.get(data.page?.title ?? '') as
    { formPurpose: string; fields: unknown[]; warnings: string[] } | undefined;
  const reply = recorded ?? {
    formPurpose: 'A screen with no form Filler recognises',
    fields: [],
    warnings: [],
  };
  return JSON.stringify(
    data.mode === 'region' ? { ...reply, fields: reply.fields.slice(0, 1) } : reply,
  );
}

// ------------------------------------------------------------ résumé extract (Phase 11)

/**
 * A "model" that reads the résumé with the same patterns as the on-device
 * extractor (so tests are deterministic), returns only non-contact details,
 * and in `inventing` mode adds an employer that is not in the text.
 */
function scriptedExtract(prompt: string, mode: Mode): string {
  const m = /<<<RESUME_TEXT\n([\s\S]*?)\nRESUME_TEXT>>>/.exec(prompt);
  const text = m ? (JSON.parse(m[1]!) as { text: string }).text : '';
  if (mode === 'garbage') return 'Here is the résumé summary.';
  const facts = extractLocally(text)
    .filter((c) => !/^(?:contact|links|person\.|address)/.test(c.key))
    .map((c) => ({ key: c.key, value: c.value, confidence: 0.9 }));
  if (mode === 'inventing')
    facts.push({ key: 'experience[9].company', value: 'Google', confidence: 0.99 });
  return JSON.stringify({ facts });
}
