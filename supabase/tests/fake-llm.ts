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

export type Mode = 'honest' | 'compromised' | 'garbage' | 'fenced';

/** The model's reply text for a prompt. */
export function scriptedReply(prompt: string, mode: Mode = 'honest'): string {
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
