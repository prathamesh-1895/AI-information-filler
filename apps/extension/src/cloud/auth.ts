/**
 * Sign-in with a 6-digit email code (no passwords, no magic-link redirects,
 * which do not work inside an extension). Signing in is optional: everything
 * that does not need the cloud works signed out.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import { z } from 'zod';

export interface AuthStatus {
  configured: boolean;
  signedIn: boolean;
  email?: string;
  userId?: string;
}

export const EmailSchema = z.string().trim().toLowerCase().email().max(254);
export const CodeSchema = z
  .string()
  .trim()
  .regex(/^\d{6}$/, 'Enter the 6-digit code from the email.');

export class CloudAuth {
  constructor(private readonly client: () => SupabaseClient | null) {}

  async status(): Promise<AuthStatus> {
    const c = this.client();
    if (!c) return { configured: false, signedIn: false };
    const { data } = await c.auth.getSession();
    const user = data.session?.user;
    return user
      ? {
          configured: true,
          signedIn: true,
          userId: user.id,
          ...(user.email ? { email: user.email } : {}),
        }
      : { configured: true, signedIn: false };
  }

  async sendCode(email: string): Promise<void> {
    const c = this.require();
    const { error } = await c.auth.signInWithOtp({
      email: EmailSchema.parse(email),
      options: { shouldCreateUser: true },
    });
    if (error) throw new Error(readable(error.message));
  }

  async verify(email: string, code: string): Promise<AuthStatus> {
    const c = this.require();
    const { error } = await c.auth.verifyOtp({
      email: EmailSchema.parse(email),
      token: CodeSchema.parse(code),
      type: 'email',
    });
    if (error) throw new Error(readable(error.message));
    return this.status();
  }

  async signOut(): Promise<void> {
    const c = this.client();
    if (c) await c.auth.signOut({ scope: 'local' });
  }

  /** Current access token for Edge Function calls (refreshed by supabase-js). */
  async accessToken(): Promise<string | null> {
    const c = this.client();
    if (!c) return null;
    const { data } = await c.auth.getSession();
    return data.session?.access_token ?? null;
  }

  private require(): SupabaseClient {
    const c = this.client();
    if (!c) throw new Error('Cloud features are not set up in this build of Filler.');
    return c;
  }
}

function readable(message: string): string {
  if (/expired|invalid/i.test(message))
    return 'That code is wrong or has expired. Ask for a new one.';
  if (/rate|too many/i.test(message)) return 'Too many attempts. Wait a minute and try again.';
  return message;
}
