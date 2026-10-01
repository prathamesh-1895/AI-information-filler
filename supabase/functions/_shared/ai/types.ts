/** The provider contract every AI adapter implements (PLAYBOOK Task 8.1). */

export type Tier = 'fast' | 'smart' | 'vision';

export interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

export interface ImageInput {
  mimeType: 'image/png' | 'image/jpeg' | 'image/webp';
  /** Base64 data, no `data:` prefix. */
  data: string;
}

export interface CompleteRequest {
  system: string;
  messages: ChatMessage[];
  /** JSON Schema for the reply. Providers with a structured-output mode get it; the reply must be JSON either way. */
  jsonSchema?: Record<string, unknown>;
  images?: ImageInput[];
  maxTokens: number;
  temperature: number;
}

export interface CompleteResult {
  text: string;
  usage: { inputTokens: number; outputTokens: number };
  provider: string;
  model: string;
}

/** One provider bound to its key/URL. `model` comes from config, never from code. */
export interface ProviderAdapter {
  readonly name: ProviderName;
  complete(
    request: CompleteRequest,
    model: string,
    signal: AbortSignal,
  ): Promise<Omit<CompleteResult, 'provider' | 'model'>>;
}

export const PROVIDER_NAMES = ['gemini', 'groq', 'openrouter', 'ollama'] as const;
export type ProviderName = (typeof PROVIDER_NAMES)[number];

/** A provider failure. `retryable` covers 429, 5xx, timeouts and network errors. */
export class ProviderError extends Error {
  readonly provider: string;
  readonly status: number | undefined;
  readonly retryable: boolean;
  readonly retryAfterMs: number | undefined;

  constructor(
    provider: string,
    message: string,
    opts: { status?: number; retryable: boolean; retryAfterMs?: number },
  ) {
    super(`${provider}: ${message}`);
    this.name = 'ProviderError';
    this.provider = provider;
    this.status = opts.status;
    this.retryable = opts.retryable;
    this.retryAfterMs = opts.retryAfterMs;
  }
}

export type FetchLike = (input: string, init: RequestInit) => Promise<Response>;
