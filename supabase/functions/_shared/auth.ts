/** Authentication for Edge Functions: every call needs a valid Supabase user token. */
import { fail } from './http.ts';

export interface AuthUser {
  id: string;
  email?: string;
}

/** Verifies a user access token (the deployed implementation asks Supabase Auth). */
export type VerifyToken = (jwt: string) => Promise<AuthUser | null>;

export async function requireUser(
  request: Request,
  verify: VerifyToken,
  origin: string | null,
): Promise<AuthUser | Response> {
  const header = request.headers.get('authorization') ?? '';
  const match = /^Bearer\s+(\S+)$/i.exec(header);
  if (!match) return fail('UNAUTHENTICATED', 'Sign in to use this feature.', origin);
  // A verifier that throws (network error, malformed token) counts as not signed in.
  const user = await verify(match[1]!).catch(() => null);
  return user ?? fail('UNAUTHENTICATED', 'Your sign-in has expired. Sign in again.', origin);
}
