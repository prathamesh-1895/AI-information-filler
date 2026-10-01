# Filler backend (Supabase)

- `migrations/`: database schema with Row Level Security on every table.
- `functions/`: Edge Functions (Deno). Logic lives in `handler.ts` files and is tested in Node; `index.ts` is the deployed entry point. `_shared/core/` is a **generated** copy of `packages/core` (`pnpm sync:shared`; never edit it by hand).
- `functions/_shared/ai/`: the AI gateway (Phase 8): provider adapters (Gemini, Groq, OpenRouter, Ollama over plain REST), retries/fallback/timeouts (`gateway.ts`) and the safety envelope (`envelope.ts`).
- `tests/`: `rls.test.ts` runs the migrations on a real Postgres (PGlite, in process) with Supabase's roles stubbed and proves that one user can never read or change another user's rows. `functions.test.ts` and `ai.test.ts` cover the function handlers, adapters, gateway and the adversarial prompt-injection suite; `classify.fixtures.test.ts` measures rules + classify accuracy on the fixtures. `fake-llm.ts` is the scripted model: tests never call a live provider.

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
5. Deploy the functions: `supabase functions deploy health` and `supabase functions deploy ai-classify` (more arrive in Phases 9–10).
6. Optional: set `ALLOWED_ORIGINS=chrome-extension://<your extension id>` as a function secret to accept only your installed extension. Without it, any `chrome-extension://` origin is accepted and web pages are always refused.

Rebuild the extension (`pnpm --filter @filler/extension build`) so it picks up the `.env` values. Settings → Account and sync then lets you sign in with a 6-digit code.

## AI provider (PLAYBOOK checkpoint B)

Needs checkpoint A first. You create the key on the provider's site yourself and set it as a Supabase secret from your own terminal. Never paste a key into chat, code, `.env` or `PROGRESS.md`.

| Provider | Free key from | Secrets |
|---|---|---|
| Google Gemini (recommended; text + images) | <https://aistudio.google.com/apikey> | `GEMINI_API_KEY` |
| Groq (fast text) | <https://console.groq.com/keys> | `GROQ_API_KEY` |
| OpenRouter (`:free` models) | <https://openrouter.ai/keys> | `OPENROUTER_API_KEY` |
| Ollama (local, dev only) | no key | `OLLAMA_URL` |

```
supabase secrets set AI_PROVIDER=gemini GEMINI_API_KEY=<your key> AI_MODEL_FAST=<model> AI_MODEL_SMART=<model> AI_MODEL_VISION=<model>
```

- Model names come only from secrets (free-tier names change). `AI_MODEL_*` apply to the first provider in `AI_PROVIDER`.
- Fallback: `AI_PROVIDER=gemini,groq` plus per-provider models such as `GROQ_MODEL_FAST=<model>`. A provider without a key or model for a tier is skipped.
- Limits (optional): `LIMIT_AI_CLASSIFY_CALLS` / `_TOKENS` per user per day (defaults 200 calls / 400,000 tokens), `LIMIT_GLOBAL_CALLS` / `LIMIT_GLOBAL_TOKENS` for everyone together (defaults 2,000 / 4,000,000), `AI_TIMEOUT_MS` (20,000), `AI_MAX_OUTPUT_TOKENS` (4,096), `AI_MAX_INPUT_CHARS` (60,000), `AI_RETRIES` (2).

Then in the extension: Settings → AI help → **Test AI connection**.

## Local testing without a project

`pnpm e2e` builds the extension against `scripts/mock-supabase.mjs`, a small local stand-in for Supabase Auth (email codes), the `vault_blobs` and `ai_usage` REST endpoints, and the `health` / `ai-classify` functions (the real handlers, with the scripted model in place of the provider). It enforces the same per-user and version rules as the real policies. Tests never contact a real Supabase project.
