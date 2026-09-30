# Filler — Build Progress

**Last completed phase:** Phase 1 — Core domain model & policy (2026-10-01)

Playbook: `docs/PLAYBOOK.md` · Architecture: `docs/ARCHITECTURE.md`

## Phase status

| # | Phase | Status | Summary |
|---|---|---|---|
| 0 | Foundation & repo scaffold | ✅ COMPLETE (2026-10-01) | pnpm/Turbo monorepo, 4 packages, WXT extension shell with side panel, Vitest + Playwright harness, fixture server, governance files |
| 1 | Core domain model & policy | ✅ COMPLETE (2026-10-01) | 64-key canonical registry (5 list groups), Zod schemas for all records, deny-list + submit-button policy with checksum value detection, label normalisation and SHA-256 field signatures |
| 2 | Encrypted vault | ⬜ NOT STARTED | |
| 3 | Page Agent: scanner | ⬜ NOT STARTED | |
| 4 | Page Agent: filler, observer, highlighter | ⬜ NOT STARTED | |
| 5 | Rule mapper & orchestrator | ⬜ NOT STARTED | |
| 6 | Side panel UI | ⬜ NOT STARTED | |
| 7 | Supabase: auth, database, encrypted sync | ⬜ NOT STARTED | |
| 8 | AI gateway & field understanding | ⬜ NOT STARTED | |
| 9 | AI answer generation & goal context | ⬜ NOT STARTED | |
| 10 | Screen Share & vision mode | ⬜ NOT STARTED | |
| 11 | Résumé import & platform profiles | ⬜ NOT STARTED | |
| 12 | Hardening, docs & release | ⬜ NOT STARTED | |

## Checkpoints

| Checkpoint | Phase | Status |
|---|---|---|
| 🔑 A — Supabase project (URL + anon key, CLI linked) | 7 | ⬜ pending |
| 🔑 B — Free AI API key in Supabase secrets | 8 | ⬜ pending |

## Notes for next session

- Next: **Phase 2, Task 2.1** (crypto primitives). Model: **Opus 5.5**.
- **Model log:** Phase 0 — Opus 5.5 · Phase 1 — Opus 5.5.
- Toolchain on the dev machine: Node 24.13, pnpm 9.15.9 (installed globally via npm; `corepack enable` failed with EPERM on `C:\Program Files\nodejs`), git 2.52.

---

## Phase 0 — files

Created:
- Root: `package.json`, `pnpm-workspace.yaml`, `turbo.json`, `tsconfig.base.json`, `eslint.config.js`, `.prettierrc.json`, `.prettierignore`, `.gitignore`, `.nvmrc`, `.env.example`, `playwright.config.ts`, `CLAUDE.md`, `PROGRESS.md`
- `packages/{core,vault,ai-client,ui}/`: `package.json`, `tsconfig.json`, `src/index.ts` + one test each (`assertNever`, `VAULT_DB_NAME`, `AI_ENDPOINTS`, `cn`)
- `apps/extension/`: `package.json`, `wxt.config.ts`, `tsconfig.json`, `vitest.config.ts`, `entrypoints/background.ts`, `entrypoints/page-agent.ts`, `entrypoints/sidepanel/{index.html,main.tsx,App.tsx,style.css}`, `src/app-info.ts` (+ test)
- `scripts/serve-fixtures.mjs`, `scripts/playwright.mjs`
- `test-fixtures/{index.html,fixture-harness.js,simple-contact.html,simple-contact.expected.json,README.md}`
- `e2e/{fixtures.ts,smoke.spec.ts}`

Modified: `docs/PLAYBOOK.md` (React 19 / Tailwind v4 in §0.5, `page-agent.ts` naming in §0.6, `pnpm e2e:install` in §0.9).

## Phase 0 — design notes

- **Page agent is a WXT *unlisted script* (`entrypoints/page-agent.ts`), not `content.ts`.** WXT treats `content.ts` as a manifest-declared content script with `matches`, which would add host permissions. An unlisted script is injected with `chrome.scripting.executeScript({ files: ['/page-agent.js'] })` under `activeTab`, so the manifest has no host permissions at all.
- Packages are **source-first** (`main: ./src/index.ts`), with no per-package build step; WXT/Vite and Vitest compile TS directly. Supabase Edge Functions will get copies through `pnpm sync:shared` (Phase 7).
- Toolbar icon opens the side panel via `sidePanel.setPanelBehavior({ openPanelOnActionClick: true })`.
- **TypeScript pinned to ~5.9.** `pnpm add typescript` resolved 7.x, which typescript-eslint does not support yet.
- **Playwright browsers live in `node_modules`** (`PLAYWRIGHT_BROWSERS_PATH=0`, wrapped by `scripts/playwright.mjs`). Chromium in `%LOCALAPPDATA%\ms-playwright` fails to start on this machine ("side-by-side configuration is incorrect", SideBySide event: dependent assembly 153.0.8010.12 not found), while the identical binaries start fine from a `D:\` path. Run `pnpm e2e:install` once per fresh clone.
- E2E opens the side panel as a normal tab (`chrome-extension://<id>/sidepanel.html`), since Playwright cannot click the browser toolbar. Extension id comes from the service worker URL.
- Fixture pages all load `fixture-harness.js`, which records submit events into `window.__submits` and prevents navigation.

### Open items surfaced in Phase 0
- A broken Playwright Chromium copy remains in `%LOCALAPPDATA%\ms-playwright` (~400 MB, unused). Safe for the user to delete.
- Toolbar icons are WXT defaults (none set); real icons come in Phase 12.5.

---

## Phase 1 — files

Created (all in `packages/core/src/` unless noted):
- `schema/keys.ts` (+ `keys.test.ts`): canonical key registry, list groups, `parseKey`, `getKeyDef`, `isValidFactKey`, `listItemKey`, `customKeyFor`
- `schema/records.ts` (+ `records.test.ts`): Zod schemas `Fact`, `DocumentRecord`, `FieldMemory`, `Answer`, `FieldDescriptor`, `PlanItem`, `Goal`, `PageSnapshot`, `Session` and enums
- `policy/deny.ts`: `createPolicy`, `classifyRisk`, `detectSensitiveValue`, `passesLuhn`, `passesVerhoeff`
- `policy/submit.ts`: `isSubmitLike`
- `policy/config.ts` (+ `config.test.ts`): `DenyListConfigSchema`, `policyFromConfig`
- `policy/policy.test.ts`, `policy/index.ts`
- `text/normalise.ts`: `normaliseLabel`, `humaniseIdentifier`, `siteOf`, `isDynamicIdentifier`
- `text/signature.ts`: `fieldSignature` (async, WebCrypto), `signatureMaterial`
- `text/text.test.ts`
- `config/deny-list.json` (repo root): user-extendable deny phrases (empty)

Modified: `packages/core/src/index.ts` (exports), `packages/core/tsconfig.json` (`types: ["node"]` for tests), `packages/core/package.json` (`@types/node`).

Tests: core 222 (≈129 policy/config table cases, 60+ required), whole repo 226 unit + 2 e2e.

## Phase 1 — design notes

- **Key grammar:** scalar `group.sub.field`; list items `group[n].field` (templates `group[].field` in the registry); user facts `custom.<slug>`. `family.father_name` / `family.mother_name` added now (Task 5.1 needs them) with `personal` sensitivity. 64 keys across 14 groups; list groups: education, experience, projects, languages, certifications. `skills` is one `list`-typed key (string array value).
- **Fact values** are `string | string[]` only. Structured items are separate indexed keys, so every fact stays independently encryptable, mappable and deletable.
- `FieldDescriptor.labelSource` gained `label-wrap`, `container` and `name` beyond the playbook's list (the scanner needs them in Phase 3). Added `multiple` for checkbox groups and multi-selects.
- **Policy order matters.** Identity documents (passport, Aadhaar, PAN, SSN, government IDs) are checked before card and bank rules, so "Aadhar card no" and "Permanent account number" report the right reason. Label rules look at the label, placeholder, name and id, never help text (help text often says things like "we never ask for your password"). The only text that uses section headings is card expiry (context).
- **Value detection uses checksums:** Luhn for 13–19 digit card numbers, Verhoeff for 12-digit Aadhaar-shaped numbers. An unformatted 12-digit number starting with `91` is treated as a phone number with country code unless it is written 4-4-4, which is a deliberate trade-off. PAN is the `AAAAA9999A` shape and SSN is `999-99-9999`. Phase 2.4 reuses `detectSensitiveValue` to reject vault writes.
- **Submit safety:** a button is navigation only if its *whole* normalised text matches the navigation list (next/continue/save and continue/back/skip/add …) and contains no commit word (submit, pay, payment, publish, apply, done, save, delete, upload, sign up, …). Unlabelled or unknown buttons count as submit-like. Cancel, Close and Edit are also never clicked.
- `isDynamicIdentifier` ignores framework ids (`input_83471`, `:r5:`, `mui-12`, UUIDs, long hashes, names ending in 5+ digits) when building signatures, but keeps Google Forms `entry.<n>` names, which are stable per form.
- `fieldSignature` is async (WebCrypto `subtle.digest`), so it runs unchanged in the extension, Node tests and Deno Edge Functions.
- Custom user deny rules can only *add* `user_rule` denials; `createPolicy` always applies the hard-core list first. `policyFromConfig` throws on malformed config instead of silently loosening rules.

### Open items surfaced in Phase 1
- Hindi/Marathi coverage in the deny-list is a starter set (पासवर्ड, आधार, पैन, पासपोर्ट, खाता संख्या). Extend it when real-site checks in Phase 11 find gaps.
- Registry aliases are a first pass; the Phase 5 dictionary tunes them against the fixtures.
