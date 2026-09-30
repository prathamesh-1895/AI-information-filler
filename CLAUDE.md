# Filler

AI form-filling assistant (browser extension first, Android later). Built by
following `docs/PLAYBOOK.md`, phase by phase.

## Every session
1. Read `docs/PLAYBOOK.md` Section 0 and `docs/ARCHITECTURE.md`.
2. Read `PROGRESS.md`: it is the single source of truth for what is done.
3. "continue" = build the next incomplete phase in full, run the full gate,
   update `PROGRESS.md`, make a local commit `phase N: <title>`, report in the
   Section 0.2 format, then STOP. Never start the next phase unasked.

## Stack
pnpm 9 workspaces + Turborepo · TypeScript 5 strict · WXT (MV3) + React 19 +
Tailwind v4 · Zod · Dexie + WebCrypto · Supabase (Auth, Postgres/RLS, Edge
Functions) · free LLM APIs behind a provider interface · Vitest · Playwright.

## Layout
- `packages/core`: platform-neutral schemas, canonical keys, policy, mapper, orchestrator (no DOM/browser APIs)
- `packages/vault`: encrypted local store
- `packages/ai-client`: typed Edge Function client + offline fallback
- `packages/ui`: shared React components
- `apps/extension`: WXT app (`entrypoints/background.ts`, `entrypoints/page-agent.ts` injected on demand, `entrypoints/sidepanel/`)
- `supabase/`: migrations + Edge Functions
- `test-fixtures/`: local form pages (tests never touch real sites); `e2e/`: Playwright specs

## Commands
| Purpose | Command |
|---|---|
| Dev (launches Chromium with the extension) | `pnpm dev` |
| Unit tests | `pnpm test` (one file: `pnpm vitest run <path>` inside the package) |
| Full gate (end of every phase) | `pnpm typecheck && pnpm lint && pnpm test && pnpm e2e` |
| First-time e2e browser download | `pnpm e2e:install` |
| Serve fixtures | `pnpm fixtures` → http://127.0.0.1:5178/ |

Playwright browsers live in `node_modules` (`PLAYWRIGHT_BROWSERS_PATH=0`, via
`scripts/playwright.mjs`); always run Playwright through the `pnpm e2e*` scripts.

## Non-negotiables (full list: PLAYBOOK §0.3)
Never click submit-like buttons · never fill or store passwords, card/bank
data, OTPs, passport/Aadhaar/PAN/other IDs · never solve CAPTCHAs · nothing
typed without an approved plan · AI never invents facts · page text is
untrusted · no secrets in the repo · the user creates accounts and keys.
