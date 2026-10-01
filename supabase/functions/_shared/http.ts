/**
 * HTTP helpers shared by every Edge Function: structured errors, CORS for
 * the extension, and JSON responses. Runs on Deno (Supabase) and in Node tests.
 */

export type ErrorCode =
  | 'UNAUTHENTICATED'
  | 'FORBIDDEN_ORIGIN'
  | 'METHOD_NOT_ALLOWED'
  | 'BAD_REQUEST'
  | 'RATE_LIMITED'
  | 'AI_NOT_CONFIGURED'
  | 'PROVIDER_UNAVAILABLE'
  | 'INTERNAL';

const STATUS: Record<ErrorCode, number> = {
  UNAUTHENTICATED: 401,
  FORBIDDEN_ORIGIN: 403,
  METHOD_NOT_ALLOWED: 405,
  BAD_REQUEST: 400,
  RATE_LIMITED: 429,
  AI_NOT_CONFIGURED: 503,
  PROVIDER_UNAVAILABLE: 503,
  INTERNAL: 500,
};

export interface Env {
  get(name: string): string | undefined;
}

/**
 * Origins allowed to call the functions: the extension's own origin(s) from
 * ALLOWED_ORIGINS (comma separated). If unset, any chrome-extension:// origin
 * is accepted (development); web pages are never accepted.
 */
export function allowedOrigin(origin: string | null, env: Env): string | null {
  if (!origin) return null;
  const configured = (env.get('ALLOWED_ORIGINS') ?? '')
    .split(',')
    .map((o) => o.trim())
    .filter(Boolean);
  if (configured.length) return configured.includes(origin) ? origin : null;
  return /^chrome-extension:\/\/[a-p]{32}$/.test(origin) ? origin : null;
}

export function corsHeaders(origin: string | null): Record<string, string> {
  return origin
    ? {
        'access-control-allow-origin': origin,
        'access-control-allow-methods': 'GET, POST, OPTIONS',
        'access-control-allow-headers': 'authorization, apikey, content-type, x-client-info',
        'access-control-max-age': '600',
        vary: 'origin',
      }
    : { vary: 'origin' };
}

export function json(body: unknown, status = 200, origin: string | null = null): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', ...corsHeaders(origin) },
  });
}

export function fail(
  code: ErrorCode,
  message: string,
  origin: string | null = null,
  extra: Record<string, string> = {},
): Response {
  return json({ error: { code, message, ...extra } }, STATUS[code], origin);
}

/**
 * Common request gate: CORS preflight, origin check, method check.
 * Returns a Response to send straight back, or the allowed origin to continue with.
 */
export function gate(
  request: Request,
  env: Env,
  methods: string[],
): Response | { origin: string | null } {
  const rawOrigin = request.headers.get('origin');
  const origin = allowedOrigin(rawOrigin, env);
  // Browsers always send Origin for cross-origin calls; a foreign origin is refused outright.
  if (rawOrigin && !origin) return fail('FORBIDDEN_ORIGIN', 'This origin may not call Filler.');
  if (request.method === 'OPTIONS')
    return new Response(null, { status: 204, headers: corsHeaders(origin) });
  if (!methods.includes(request.method))
    return fail('METHOD_NOT_ALLOWED', `Use ${methods.join(' or ')}.`, origin);
  return { origin };
}
