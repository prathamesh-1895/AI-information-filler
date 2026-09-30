# Filler — Build Progress

**Last completed phase:** Phase 2 — Encrypted vault (2026-10-01)

Playbook: `docs/PLAYBOOK.md` · Architecture: `docs/ARCHITECTURE.md`

## Phase status

| # | Phase | Status | Summary |
|---|---|---|---|
| 0 | Foundation & repo scaffold | ✅ COMPLETE (2026-10-01) | pnpm/Turbo monorepo, 4 packages, WXT extension shell with side panel, Vitest + Playwright harness, fixture server, governance files |
| 1 | Core domain model & policy | ✅ COMPLETE (2026-10-01) | 64-key canonical registry (5 list groups), Zod schemas for all records, deny-list + submit-button policy with checksum value detection, label normalisation and SHA-256 field signatures |
| 2 | Encrypted vault | ✅ COMPLETE (2026-10-01) | PBKDF2 (600k) + AES-256-GCM with per-record IV and AAD, Dexie store, Fact/Document/FieldMemory/Answer repos, lock/unlock/auto-lock/session resume, atomic passphrase change, encrypted backup/import, wipe |
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

- Next: **Phase 3, Task 3.1** (fixture library). Model: **Sonnet 5.5**, so switch before saying "continue".
- **Model log:** Phase 0 — Opus 5.5 · Phase 1 — Opus 5.5 · Phase 2 — Opus 5.5.
- **User request (2026-10-01):** tell the user whenever free API keys are needed for different models. At checkpoint B (Phase 8) list every free provider/model option and exactly where each key goes; Supabase (checkpoint A, Phase 7) comes first.
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

---

## Phase 2 — files

Created (all in `packages/vault/`):
- `src/crypto.ts` (+ `crypto.test.ts`): PBKDF2 key derivation, AES-GCM `encryptJson`/`decryptJson` with AAD, verifier, base64, chunked `randomBytes`
- `src/errors.ts`: `VaultLockedError`, `VaultNotInitializedError`, `VaultExistsError`, `WrongPassphraseError`, `WeakPassphraseError`, `VaultValidationError`, `BackupFormatError`
- `src/db.ts`: Dexie schema (`meta`, `facts`, `documents`, `fieldMemory`, `answers`)
- `src/service.ts` (+ `service.test.ts`): `VaultService`, `SessionKeyStore`, `BackupSchema`
- `src/repositories.ts` (+ `repositories.test.ts`): `FactRepo`, `DocumentRepo`, `FieldMemoryRepo`, `AnswerRepo`, `createRepositories`, `assertFactAllowed`, `questionSimilarity`
- `src/test-helpers.ts`, `vitest.config.ts` (loads `fake-indexeddb/auto`)

Modified: `src/index.ts` (exports), `package.json` (dexie, zod, @filler/core, fake-indexeddb, @types/node), `tsconfig.json`. Removed the Phase 0 placeholder `src/index.test.ts`.

Tests: vault 54, core 222, repo total 280 unit + 2 e2e.

## Phase 2 — design notes

- **Key hierarchy:** passphrase → PBKDF2-SHA256 (600,000 iterations, 16-byte random salt per vault) → 256-bit AES-GCM key, imported **non-extractable**. `MIN_KDF_ITERATIONS = 310,000` is enforced in the constructor; lower values need `allowWeakKdfForTests: true` (tests use 1,000 for speed, plus one test at the real 600k default).
- **Each record** is encrypted with a fresh 12-byte IV and **AAD = `table/id`**, so a ciphertext copied to another row (or another table) fails authentication. A verifier record (`meta/verifier` AAD) detects a wrong passphrase without touching data.
- **Rows** are `{id, iv, ciphertext, updatedAt}` only. Fact rows use the canonical key as `id` (a key name like `contact.email` is structure, not a value). Field-memory rows use the SHA-256 signature. **The site is inside the ciphertext, never indexed**, so browsing history can't be read from the database. `deleteBySite` decrypts and filters instead.
- **Write rules (Task 2.4, in `assertFactAllowed`):** values caught by `detectSensitiveValue` (card, Aadhaar, PAN, SSN) are refused, including inside lists. `custom.*` keys whose name hits the deny policy (e.g. `custom.passport_number`) are refused. Sensitivity may be raised but never set below the registry default; custom keys default to `public`.
- **Lock lifecycle:** auto-lock after 15 idle minutes (configurable, 0 = off), enforced two ways: a timer, and a check on every key access (MV3 timers are unreliable). Every read/write counts as activity. `onLock` listeners let the UI react. A fresh `VaultService` over an existing DB is always `locked`, which is the killed-worker behaviour.
- **"Stay unlocked for this browser session"** is opt-in through a `SessionKeyStore` (the extension will back it with `chrome.storage.session`, which is memory-only and cleared when the browser closes). Trade-off: raw key bytes live outside the worker while the browser runs. `resume()` rejects idle-expired or non-verifying entries and clears them. `lock()` clears the store.
- **`changePassphrase` is atomic.** All decryption and re-encryption happens in memory first (awaiting WebCrypto inside an IndexedDB transaction would auto-commit it), then one Dexie `rw` transaction writes every table and the new meta. Tests prove a corrupted record aborts before any write, and a failed `bulkPut` mid-transaction rolls back every table.
- A promise-queue mutex (`exclusive`) serialises all writes, so a record write can never interleave with a passphrase change or import.
- **Backup format** (`filler-backup` v1): KDF params, verifier and the *still-encrypted* rows. It is useless without the passphrase, and it is also the shape Phase 7 sync will upload. Import checks the passphrase, then decrypts every row before replacing anything (all-or-nothing), refuses backups with unsafe KDF settings, and leaves the vault unlocked with the backup's passphrase.
- `now` is looked up at call time (not captured), so fake clocks work in tests.
- Answer search uses token-set Jaccard similarity (≥ 0.5 by default) on normalised questions; same-platform answers win ties. `fastest-levenshtein` isn't needed yet.

### Open items surfaced in Phase 2
- Passphrase strength meter and the "cannot be recovered" warning are UI work (Phase 6.1). The vault only enforces a minimum of 8 characters.
- Auto-lock minutes and the session-unlock toggle need Settings UI (Phase 6.4). The `chrome.storage.session` adapter is written when the vault is wired into the background worker (Phase 5/6).
