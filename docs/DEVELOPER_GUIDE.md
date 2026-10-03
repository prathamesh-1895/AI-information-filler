# Filler developer guide

## Setup

```bash
pnpm install          # Node 22+, pnpm 9
pnpm e2e:install      # once per clone: Playwright's Chromium into node_modules
pnpm dev              # Chromium with the extension, hot reload
pnpm fixtures         # practice forms on http://127.0.0.1:5178/
```

Full gate (run before every commit; CI runs the same):

```bash
pnpm typecheck && pnpm lint && pnpm test && pnpm e2e
```

Extra checks CI (`.github/workflows/ci.yml`) also runs:
- `pnpm sync:shared:check`: the Edge Functions' copy of core is current;
- `pnpm audit:secrets`: no keys in files or history;
- `pnpm package` then `pnpm audit:build`: production manifest and bundle;
- `pnpm verify:package`: the store zip loads in a fresh Chromium profile;
- `pnpm audit`.

## Architecture tour

```
Side panel (React)  ──runtime messages──▶  Background service worker  ──scripting──▶  Page agent (per tab/frame)
  screens, store                            router → SessionHost (reducer)            scanner, filler, observer,
                                            vault, AI client, capture                 highlighter, navigation
                                                    │
                                                    ▼ HTTPS (user token)
                                            Supabase Edge Functions ──▶ AI provider (Gemini/Groq/OpenRouter/Ollama)
```

- **Page agent** (`apps/extension/src/page-agent`): injected on demand into the tab the user invoked Filler on (`activeTab`/optional site access); never declared as a content script.
  - Scans fields into `FieldDescriptor`s (labels, options, constraints, robust selectors, shadow DOM, iframes) and fills them framework-safely with read-back checks.
  - Watches for new fields and highlights fields by state.
  - Refuses submit-like buttons in code.
- **Background** (`entrypoints/background.ts`, `src/session`):
  - `router.ts` validates every panel request (Zod) and routes it.
  - `SessionHost` runs the core reducer per tab and executes its effects (scan, map, plan, fill, generate, record…).
  - Only extension pages can send requests; page agents may only report field changes and focus.
- **Core** (`packages/core`): platform-neutral and pure, so the future Android client can reuse it.
  - Schemas and canonical keys, deny policy and submit rules.
  - The rule mapper and value formatter.
  - The session reducer (`orchestrator/session.ts`), drafting rules, fact selection, goal parsing, platform profiles, résumé extraction, vision matching and explanations.
- **Vault** (`packages/vault`): Dexie + WebCrypto. Repositories for facts, documents, field memory, answers and history. Lock/unlock, backups, end-to-end encrypted sync.
- **AI client** (`packages/ai-client`): typed calls to the functions, plus the AI seam the reducer uses. Every failure becomes an offline reason.
- **Supabase** (`supabase/`):
  - migrations with Row Level Security;
  - Edge Functions (`health`, `ai-classify`, `ai-generate`, `ai-vision`, `ai-extract`) whose logic lives in Node-testable `handler.ts` files;
  - `_shared/ai` for the provider gateway and safety envelopes;
  - `_shared/core`, a **generated** copy of `packages/core` (`pnpm sync:shared`).

## The session state machine

`reduce(state, event) → { state, effects }` in `packages/core/src/orchestrator/session.ts`. The host feeds effect results back as events, strictly in order per tab.

`IDLE → SCANNING → MAPPING → PLANNING → AWAITING_REVIEW → FILLING → VERIFYING → READY_TO_SUBMIT`, plus `ERROR` and `ENDED`.

- User events (validated): `ANSWER`, `EDIT`, `APPROVE`, `APPROVE_ALL_VAULT`, `SKIP`, `FILL`, `DRAFT`, `REUSE`, `RELABEL`, `SET_GOAL`, `RESCAN`, `END`.
- Effects: `SCAN`, `MAP`, `PLAN`, `SAVE_ANSWER`, `FILL`, `HIGHLIGHT`, `GENERATE`, `RECORD_ANSWER`, `END_PAGE`.
- Safety lives in the reducer and the page agent, not the UI:
  - denied items can't be answered, edited, filled or relabelled;
  - only approved items are filled;
  - AI text is never approved by "approve all" or trusted sites.

## Message contract

All panel ↔ background messages are Zod schemas in `apps/extension/src/messaging/protocol.ts` (`PanelRequestSchema`). Replies are `{ ok: true, data } | { ok: false, error: { code, message } }`. Groups:

| Group | Requests |
|---|---|
| Tabs | `GET_TARGET_TAB`, `SCAN_REQUEST`, `FILL_REQUEST`, `HIGHLIGHT_REQUEST`, `OBSERVE_REQUEST`, `END_SESSION_REQUEST`, `NAV_LIST_REQUEST`, `NAV_CLICK_REQUEST` |
| Vault | `VAULT_STATUS/CREATE/UNLOCK/LOCK/EXPORT/IMPORT/WIPE`, `FACT_SET/DELETE/LIST/BATCH`, `MEMORY_CLEAR_SITE` |
| Session | `SESSION_START`, `SESSION_GET`, `SESSION_EVENT` (+ the `SESSION_STATE` broadcast) |
| Account and sync | `AUTH_STATUS/SEND_CODE/VERIFY/SIGN_OUT`, `SYNC_STATUS/NOW/USE_CLOUD/REPLACE_CLOUD` |
| AI | `AI_STATUS`, `AI_TEST`, `AI_USAGE` |
| Screen | `VISION_CAPTURE`, `VISION_READ`, `VISION_RELABEL`, `EXPLAIN` |
| Import and history | `IMPORT_ANALYZE`, `IMPORT_SAVE`, `HISTORY_LIST`, `HISTORY_REUSE` |
| Settings | `SETTINGS_GET`, `SETTINGS_SET` |

## Extending Filler

### Add a canonical key
1. Add it to the registry in `packages/core/src/schema/keys.ts`, with label, value type, sensitivity, examples and aliases.
2. Add patterns in `config/field-dictionary.json` (whole-word regexes; `contextPatterns` for list groups).
3. Add mapper tests (`map.test.ts`) with phrasings the fixtures don't contain, and update fixture `.expected.json` files if a fixture uses it.
4. `pnpm sync:shared`, then run the gate. The fixture accuracy tests must stay ≥ 85% rules-only and ≥ 95%/90% with classify.

### Add a platform profile
1. Create `config/platforms/<id>.json` with:
   - `id`, `name` and `family` (freelance, jobs, forms, events, personal_details);
   - `match.hosts` and/or content `signals` with `minSignals`;
   - field rules (label regex → key/kind, confidence, `lengthWindow`, `tip`);
   - `navigation.neverClick`, `goal` defaults, and `tips`.
2. Import it in `apps/extension/src/platforms/profiles.ts`.
3. `profile.test.ts` validates every shipped profile, and checks detection and that accuracy with profiles ≥ without.

Rules: a profile can only add. It overrides a mapping only with higher confidence, never touches denied fields, and can only add never-click texts.

### Add an AI provider
1. Write an adapter in `supabase/functions/_shared/ai/providers.ts` implementing `ProviderAdapter.complete(request, model, signal)`, translating `CompleteRequest` (system, messages, jsonSchema, images, maxTokens, temperature) to the provider's REST body and back.
2. Add it to `PROVIDER_NAMES`, `PROVIDER_SECRET` and `createAdapter`.
3. Add it to the adapter contract suite in `supabase/tests/ai.test.ts`, then teach `fakeProviderFetch` its reply shape.
4. No caller changes: the gateway handles retries, timeouts, fallback and token caps. Configure it with `AI_PROVIDER=<name>`, `<NAME>_API_KEY` and `<NAME>_MODEL_FAST/SMART/VISION`.

## Testing

| Suite | Where | What |
|---|---|---|
| Core | `packages/core` (Vitest) | keys, policy, mapper (+ fixture accuracy on real scans), formatting, reducer, drafts, selection, goal, profiles, import, vision, history |
| Vault | `packages/vault` | crypto, repositories, lock lifecycle, backups, sync merge, row-id hashing |
| Extension | `apps/extension` | session host with a real vault on fake IndexedDB, settings, messaging, capture geometry, PDF text |
| AI client | `packages/ai-client` | HTTP error mapping, seam behaviour |
| Supabase | `supabase/tests` | RLS on real Postgres (PGlite), every function handler, adapter contract suite, gateway, safety envelopes, adversarial suites, accuracy |
| E2E | `e2e/` (Playwright, real Chromium + built extension) | the panel driven like a user on local fixtures; the mock backend (`scripts/mock-supabase.mjs`) runs the real function handlers with a scripted model |

- Tests never call real websites or real AI providers. Scripted model replies live in `supabase/tests/fake-llm.ts` and `test-fixtures/__ai__/`.
- Fixture scans (`test-fixtures/__scans__`) are rewritten with `UPDATE_SCANS=1 pnpm e2e scan-snapshots`.
- `pnpm e2e` builds two extensions:
  - the normal test build;
  - a "capture" build with `<all_urls>`, used only by `screen.spec.ts` and the AI payload audit, because Playwright cannot click the toolbar button that grants `activeTab`.
- Every e2e test fails on any console error (`watchConsole` in `e2e/fixtures.ts`).

## Repository layout

```
apps/extension      WXT MV3 extension (background, page agent, side panel)
packages/core       platform-neutral logic
packages/vault      encrypted store
packages/ai-client  function client + AI seam
packages/ui         shared React components
supabase            migrations, Edge Functions, function tests
config              field dictionary, deny list, platform profiles
test-fixtures       local practice forms, scans, résumés, scripted AI replies
e2e                 Playwright specs
scripts             fixtures server, mock Supabase, e2e runner, sync, audits, generators
docs                guides, architecture, playbook, audit, demo, report notes
```
