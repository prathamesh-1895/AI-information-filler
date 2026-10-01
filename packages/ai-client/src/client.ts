/**
 * Typed client for Filler's AI Edge Functions (PLAYBOOK Task 8.4). Every
 * failure becomes a plain-language offline reason instead of an exception,
 * so callers fall back to asking the user. Replies are validated with the
 * shared Zod schemas before anything uses them.
 */
import {
  AiErrorBodySchema,
  ClassifyResponseSchema,
  GenerateResponseSchema,
  HealthResponseSchema,
  VisionResponseSchema,
  type VisionRequest,
  type VisionResponse,
  type ClassifyRequest,
  type ClassifyResponse,
  type GenerateRequest,
  type GenerateResponse,
  type HealthResponse,
} from '@filler/core';
import type { z } from 'zod';

export const AI_ENDPOINTS = {
  health: 'health',
  classify: 'ai-classify',
  generate: 'ai-generate',
  vision: 'ai-vision',
} as const;
export type AiEndpoint = (typeof AI_ENDPOINTS)[keyof typeof AI_ENDPOINTS];

export type OfflineReason =
  | 'disabled'
  | 'not_set_up'
  | 'signed_out'
  | 'no_provider'
  | 'limit_reached'
  | 'unavailable'
  | 'bad_reply';

/** Short reasons for the mode chip ("Offline mode · not signed in"). */
export const OFFLINE_TEXT: Record<OfflineReason, string> = {
  disabled: 'AI help is turned off',
  not_set_up: 'cloud is not set up in this build',
  signed_out: 'not signed in',
  no_provider: 'AI is not set up on the server yet',
  limit_reached: 'daily AI limit reached',
  unavailable: 'AI provider unavailable',
  bad_reply: 'AI reply could not be used',
};

export type AiCall<T> =
  { ok: true; data: T } | { ok: false; reason: OfflineReason; message: string };

export interface AiClientOptions {
  /** `<project>/functions/v1`, or null when the build has no Supabase project. */
  functionsUrl: string | null;
  /** Public anon/publishable key, sent as `apikey` like supabase-js does. */
  anonKey?: string;
  /** The signed-in user's access token, or null when signed out. */
  getAccessToken(): Promise<string | null>;
  fetch?: (input: string, init: RequestInit) => Promise<Response>;
  timeoutMs?: number;
}

const offline = (reason: OfflineReason, message = OFFLINE_TEXT[reason]): AiCall<never> => ({
  ok: false,
  reason,
  message,
});

export class AiClient {
  private readonly fetchFn: (input: string, init: RequestInit) => Promise<Response>;
  private readonly timeoutMs: number;

  constructor(private readonly options: AiClientOptions) {
    this.fetchFn = options.fetch ?? ((input, init) => globalThis.fetch(input, init));
    this.timeoutMs = options.timeoutMs ?? 25_000;
  }

  get configured(): boolean {
    return Boolean(this.options.functionsUrl);
  }

  health(): Promise<AiCall<HealthResponse>> {
    return this.call(AI_ENDPOINTS.health, 'GET', undefined, HealthResponseSchema);
  }

  classify(request: ClassifyRequest): Promise<AiCall<ClassifyResponse>> {
    return this.call(AI_ENDPOINTS.classify, 'POST', request, ClassifyResponseSchema);
  }

  generate(request: GenerateRequest): Promise<AiCall<GenerateResponse>> {
    return this.call(AI_ENDPOINTS.generate, 'POST', request, GenerateResponseSchema);
  }

  vision(request: VisionRequest): Promise<AiCall<VisionResponse>> {
    return this.call(AI_ENDPOINTS.vision, 'POST', request, VisionResponseSchema);
  }

  private async call<S extends z.ZodType>(
    endpoint: AiEndpoint,
    method: 'GET' | 'POST',
    body: unknown,
    schema: S,
  ): Promise<AiCall<z.infer<S>>> {
    const base = this.options.functionsUrl;
    if (!base) return offline('not_set_up');
    const token = await this.options.getAccessToken().catch(() => null);
    if (!token) return offline('signed_out');

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    let res: Response;
    try {
      res = await this.fetchFn(`${base.replace(/\/+$/, '')}/${endpoint}`, {
        method,
        headers: {
          authorization: `Bearer ${token}`,
          ...(this.options.anonKey ? { apikey: this.options.anonKey } : {}),
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: controller.signal,
      });
    } catch {
      return offline(
        'unavailable',
        controller.signal.aborted
          ? 'The AI took too long to answer.'
          : 'Could not reach Filler’s server.',
      );
    } finally {
      clearTimeout(timer);
    }

    const payload: unknown = await res.json().catch(() => null);
    if (!res.ok) return this.failure(res.status, payload);
    const parsed = schema.safeParse(payload);
    return parsed.success ? { ok: true, data: parsed.data } : offline('bad_reply');
  }

  private failure(status: number, payload: unknown): AiCall<never> {
    const error = AiErrorBodySchema.safeParse(payload);
    const code = error.success ? error.data.error.code : '';
    const message = error.success ? error.data.error.message : undefined;
    if (status === 401 || code === 'UNAUTHENTICATED')
      return offline('signed_out', 'Your sign-in has expired. Sign in again to use AI.');
    if (status === 429 || code === 'RATE_LIMITED') return offline('limit_reached', message);
    if (code === 'AI_NOT_CONFIGURED') return offline('no_provider', message);
    if (status >= 500) return offline('unavailable', message);
    return offline('bad_reply', message);
  }
}
