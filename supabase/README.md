# Filler backend (Supabase)

- `migrations/`: database schema with Row Level Security on every table.
- `functions/`: Edge Functions (Deno). Logic lives in `handler.ts` files and is tested in Node; `index.ts` is the deployed entry point. `_shared/core/` is a **generated** copy of `packages/core` (`pnpm sync:shared`; never edit it by hand).
- `tests/`: `rls.test.ts` runs the migrations on a real Postgres (PGlite, in process) with Supabase's roles stubbed and proves that one user can never read or change another user's rows. `functions.test.ts` covers the function handlers.

The extension only ever holds the **project URL** and the **anon/publishable key**. Both are public by design: RLS protects the data. The service-role key and AI provider keys exist **only** as Supabase secrets.

## One-time setup (PLAYBOOK checkpoint A)

1. Create a free project at <https://supabase.com> (you create the account; Filler never does).
2. Put the two public values in the repo's `.env` (gitignored):
   ```
   VITE_SUPABASE_URL=https://<project-ref>.supabase.co
   VITE_SUPABASE_ANON_KEY=<anon or publishable key>
   ```
3. Turn on email codes. In **Authentication → Providers → Email**, keep Email enabled. In **Authentication → Email Templates → Magic Link**, make the email show the code by adding `{{ .Token }}` to the body, for example: `Your Filler sign-in code is {{ .Token }}`.
4. Apply the schema, either with the Supabase CLI (`supabase link --project-ref <ref>` then `supabase db push`) or by asking Claude to apply `migrations/*.sql` through the Supabase connector after you confirm the project.
5. Deploy the functions: `supabase functions deploy health` (more arrive in Phases 8–10).
6. Optional: set `ALLOWED_ORIGINS=chrome-extension://<your extension id>` as a function secret to accept only your installed extension. Without it, any `chrome-extension://` origin is accepted and web pages are always refused.

Rebuild the extension (`pnpm --filter @filler/extension build`) so it picks up the `.env` values. Settings → Account and sync then lets you sign in with a 6-digit code.

## Local testing without a project

`pnpm e2e` builds the extension against `scripts/mock-supabase.mjs`, a small local stand-in for Supabase Auth (email codes) and the `vault_blobs` REST endpoint. It enforces the same per-user and version rules as the real policies. Tests never contact a real Supabase project.
