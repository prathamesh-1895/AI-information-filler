/**
 * Provider adapters over plain REST (no SDKs, so the Deno bundle stays small):
 * Gemini (generateContent), Groq and OpenRouter (OpenAI-compatible chat
 * completions) and Ollama (/api/chat). Each one only translates the shared
 * CompleteRequest into the provider's body and the reply back.
 */
import {
  ProviderError,
  type CompleteRequest,
  type CompleteResult,
  type FetchLike,
  type ProviderAdapter,
  type ProviderName,
} from './types.ts';

type Reply = Omit<CompleteResult, 'provider' | 'model'>;

function retryAfter(res: Response): number | undefined {
  const raw = res.headers.get('retry-after');
  if (!raw) return undefined;
  const seconds = Number(raw);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const at = Date.parse(raw);
  return Number.isNaN(at) ? undefined : Math.max(0, at - Date.now());
}

/** Reads a provider's error message without ever echoing request content back. */
async function failure(provider: string, res: Response): Promise<ProviderError> {
  let detail = '';
  try {
    const body = (await res.json()) as { error?: { message?: unknown } | string };
    const msg = typeof body.error === 'string' ? body.error : body.error?.message;
    if (typeof msg === 'string') detail = `: ${msg.slice(0, 160)}`;
  } catch {
    // Not JSON; the status is enough.
  }
  const retryable = res.status === 429 || res.status >= 500;
  return new ProviderError(provider, `HTTP ${res.status}${detail}`, {
    status: res.status,
    retryable,
    ...(retryable ? { retryAfterMs: retryAfter(res) } : {}),
  });
}

async function post(
  provider: string,
  fetchFn: FetchLike,
  url: string,
  headers: Record<string, string>,
  body: unknown,
  signal: AbortSignal,
): Promise<unknown> {
  let res: Response;
  try {
    res = await fetchFn(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
      signal,
    });
  } catch (error) {
    const aborted = signal.aborted || (error instanceof Error && error.name === 'AbortError');
    throw new ProviderError(provider, aborted ? 'timed out' : 'network error', { retryable: true });
  }
  if (!res.ok) throw await failure(provider, res);
  try {
    return await res.json();
  } catch {
    throw new ProviderError(provider, 'reply was not JSON', {
      status: res.status,
      retryable: true,
    });
  }
}

const int = (v: unknown) =>
  typeof v === 'number' && Number.isFinite(v) ? Math.max(0, Math.round(v)) : 0;

function empty(provider: string, why: string): ProviderError {
  return new ProviderError(provider, why, { retryable: false });
}

/** Drops JSON-Schema keys some providers reject. */
function plainSchema(schema: Record<string, unknown>): Record<string, unknown> {
  const { $schema: _s, ...rest } = schema;
  return rest;
}

// ------------------------------------------------------------------ Gemini

export function geminiAdapter(
  apiKey: string,
  fetchFn: FetchLike,
  baseUrl?: string,
): ProviderAdapter {
  const base = (baseUrl ?? 'https://generativelanguage.googleapis.com/v1beta').replace(/\/+$/, '');
  return {
    name: 'gemini',
    async complete(req: CompleteRequest, model: string, signal: AbortSignal): Promise<Reply> {
      const contents = req.messages.map((m, i) => ({
        role: m.role === 'assistant' ? 'model' : 'user',
        parts: [
          { text: m.content },
          // Images go with the last user message.
          ...(i === req.messages.length - 1 && m.role === 'user'
            ? (req.images ?? []).map((img) => ({
                inline_data: { mime_type: img.mimeType, data: img.data },
              }))
            : []),
        ],
      }));
      const body = {
        systemInstruction: { parts: [{ text: req.system }] },
        contents,
        generationConfig: {
          temperature: req.temperature,
          maxOutputTokens: req.maxTokens,
          ...(req.jsonSchema
            ? {
                responseMimeType: 'application/json',
                responseJsonSchema: plainSchema(req.jsonSchema),
              }
            : {}),
        },
      };
      const data = (await post(
        'gemini',
        fetchFn,
        `${base}/models/${encodeURIComponent(model)}:generateContent`,
        { 'x-goog-api-key': apiKey },
        body,
        signal,
      )) as {
        candidates?: Array<{
          content?: { parts?: Array<{ text?: string }> };
          finishReason?: string;
        }>;
        promptFeedback?: { blockReason?: string };
        usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number };
      };
      if (data.promptFeedback?.blockReason) throw empty('gemini', 'request was blocked');
      const candidate = data.candidates?.[0];
      const text = (candidate?.content?.parts ?? []).map((p) => p.text ?? '').join('');
      if (!text)
        throw empty('gemini', `empty reply (${candidate?.finishReason ?? 'no candidate'})`);
      return {
        text,
        usage: {
          inputTokens: int(data.usageMetadata?.promptTokenCount),
          outputTokens: int(data.usageMetadata?.candidatesTokenCount),
        },
      };
    },
  };
}

// ------------------------------------------------- OpenAI-compatible (Groq, OpenRouter)

function openAiCompatible(
  name: 'groq' | 'openrouter',
  url: string,
  apiKey: string,
  fetchFn: FetchLike,
  extraHeaders: Record<string, string> = {},
): ProviderAdapter {
  return {
    name,
    async complete(req: CompleteRequest, model: string, signal: AbortSignal): Promise<Reply> {
      const messages = [
        { role: 'system', content: req.system },
        ...req.messages.map((m, i) =>
          i === req.messages.length - 1 && m.role === 'user' && req.images?.length
            ? {
                role: 'user',
                content: [
                  { type: 'text', text: m.content },
                  ...req.images.map((img) => ({
                    type: 'image_url',
                    image_url: { url: `data:${img.mimeType};base64,${img.data}` },
                  })),
                ],
              }
            : m,
        ),
      ];
      const data = (await post(
        name,
        fetchFn,
        url,
        { authorization: `Bearer ${apiKey}`, ...extraHeaders },
        {
          model,
          messages,
          temperature: req.temperature,
          max_tokens: req.maxTokens,
          // JSON mode works on every model that supports structured output; the schema itself is in the prompt.
          ...(req.jsonSchema ? { response_format: { type: 'json_object' } } : {}),
        },
        signal,
      )) as {
        choices?: Array<{ message?: { content?: string | null }; finish_reason?: string }>;
        usage?: { prompt_tokens?: number; completion_tokens?: number };
      };
      const text = data.choices?.[0]?.message?.content ?? '';
      if (!text)
        throw empty(name, `empty reply (${data.choices?.[0]?.finish_reason ?? 'no choice'})`);
      return {
        text,
        usage: {
          inputTokens: int(data.usage?.prompt_tokens),
          outputTokens: int(data.usage?.completion_tokens),
        },
      };
    },
  };
}

export function groqAdapter(apiKey: string, fetchFn: FetchLike): ProviderAdapter {
  return openAiCompatible(
    'groq',
    'https://api.groq.com/openai/v1/chat/completions',
    apiKey,
    fetchFn,
  );
}

export function openRouterAdapter(apiKey: string, fetchFn: FetchLike): ProviderAdapter {
  return openAiCompatible(
    'openrouter',
    'https://openrouter.ai/api/v1/chat/completions',
    apiKey,
    fetchFn,
    {
      'x-title': 'Filler',
    },
  );
}

// ------------------------------------------------------------------ Ollama

export function ollamaAdapter(baseUrl: string, fetchFn: FetchLike): ProviderAdapter {
  const base = baseUrl.replace(/\/+$/, '');
  return {
    name: 'ollama',
    async complete(req: CompleteRequest, model: string, signal: AbortSignal): Promise<Reply> {
      const messages = [
        { role: 'system', content: req.system },
        ...req.messages.map((m, i) =>
          i === req.messages.length - 1 && m.role === 'user' && req.images?.length
            ? { ...m, images: req.images.map((img) => img.data) }
            : m,
        ),
      ];
      const data = (await post(
        'ollama',
        fetchFn,
        `${base}/api/chat`,
        {},
        {
          model,
          messages,
          stream: false,
          ...(req.jsonSchema ? { format: plainSchema(req.jsonSchema) } : {}),
          options: { temperature: req.temperature, num_predict: req.maxTokens },
        },
        signal,
      )) as { message?: { content?: string }; prompt_eval_count?: number; eval_count?: number };
      const text = data.message?.content ?? '';
      if (!text) throw empty('ollama', 'empty reply');
      return {
        text,
        usage: { inputTokens: int(data.prompt_eval_count), outputTokens: int(data.eval_count) },
      };
    },
  };
}

/** Env var holding each provider's key (or URL for Ollama). */
export const PROVIDER_SECRET: Record<ProviderName, string> = {
  gemini: 'GEMINI_API_KEY',
  groq: 'GROQ_API_KEY',
  openrouter: 'OPENROUTER_API_KEY',
  ollama: 'OLLAMA_URL',
};

export function createAdapter(
  name: ProviderName,
  secret: string,
  fetchFn: FetchLike,
): ProviderAdapter {
  switch (name) {
    case 'gemini':
      return geminiAdapter(secret, fetchFn);
    case 'groq':
      return groqAdapter(secret, fetchFn);
    case 'openrouter':
      return openRouterAdapter(secret, fetchFn);
    case 'ollama':
      return ollamaAdapter(secret, fetchFn);
  }
}
