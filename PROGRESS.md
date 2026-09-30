# Filler — Build Progress

**Last completed phase:** Phase 4 — Page Agent: filler, observer, highlighter (2026-10-01)

Playbook: `docs/PLAYBOOK.md` · Architecture: `docs/ARCHITECTURE.md`

## Phase status

| # | Phase | Status | Summary |
|---|---|---|---|
| 0 | Foundation & repo scaffold | ✅ COMPLETE (2026-10-01) | pnpm/Turbo monorepo, 4 packages, WXT extension shell with side panel, Vitest + Playwright harness, fixture server, governance files |
| 1 | Core domain model & policy | ✅ COMPLETE (2026-10-01) | 64-key canonical registry (5 list groups), Zod schemas for all records, deny-list + submit-button policy with checksum value detection, label normalisation and SHA-256 field signatures |
| 2 | Encrypted vault | ✅ COMPLETE (2026-10-01) | PBKDF2 (600k) + AES-256-GCM with per-record IV and AAD, Dexie store, Fact/Document/FieldMemory/Answer repos, lock/unlock/auto-lock/session resume, atomic passphrase change, encrypted backup/import, wipe |
| 3 | Page Agent: scanner | ✅ COMPLETE (2026-10-01) | 7 fixtures (74 fields), scanner with shadow DOM/iframes/ARIA widgets, 8-step label resolution (74/74 labels), constraints/options/counters, robust selectors + re-find, typed panel↔background↔page messaging, scanner preview in the side panel |
| 4 | Page Agent: filler, observer, highlighter | ✅ COMPLETE (2026-10-01) | Framework-safe fill for every control type with read-back verification and typing retry, option/date matching in core, code-enforced refusal of denied fields and submit-like buttons, debounced field-diff observer, shadow-DOM highlighter, frame-routed fill/highlight/navigation messaging |
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

- Next: **Phase 5, Task 5.1** (keyword dictionary). Model: **Opus 5.5**.
- **Model log:** Phase 0 — Opus 5.5 · Phase 1 — Opus 5.5 · Phase 2 — Opus 5.5 · Phase 3 — Opus 5.5 (the session stayed on Opus; the playbook suggested Sonnet) · Phase 4 — Opus 5.5.
- **User requirement (2026-10-01):** Filler must work on any site where the user signs in and fills in profile or personal details, not just Upwork and Fiverr. PLAYBOOK Phase 11 was rewritten to be generic-first with site-family profiles. Keep every phase site-agnostic.
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

---

## Phase 3 — files

Created:
- `apps/extension/src/page-agent/`: `dom.ts` (tree walk across shadow roots, visibility/honeypot helpers, label text cleaning), `discover.ts` (control discovery and grouping), `label.ts` (label, help text and section-heading resolution; `ControlIndex`), `constraints.ts` (options, max length from attributes or on-page counters, required/disabled, current value with redaction), `selector.ts` (robust selectors with `>>>` shadow hops, `resolveSelector`), `scan.ts` (`scan()`, `resolve()` with signature fallback)
- `apps/extension/src/messaging/`: `protocol.ts` (Zod message and result schemas, `SITE_ACCESS`), `scan-merge.ts` (frame merge, restricted-URL and injection-error classification), `background-handler.ts`, `client.ts`, `messaging.test.ts`
- `apps/extension/entrypoints/sidepanel/ScannerPreview.tsx` (temporary dev preview, replaced in Phase 6)
- `test-fixtures/`: `google-form-like`, `upwork-profile-like`, `fiverr-seller-like`, `react-controlled`, `tricky` (+ `tricky-frame.html`), `job-application-like` (each `.html` + `.expected.json`), rewritten `README.md`
- `e2e/scanner.spec.ts` (7 fixtures + reload stability, re-render re-find, wizard rescan), `e2e/panel.spec.ts` (3 tests), `e2e/globals.d.ts`
- `scripts/e2e.mjs` (builds in E2E mode, then runs Playwright)

Modified:
- `apps/extension/entrypoints/page-agent.ts` (installs `globalThis.__fillerPageAgent`), `entrypoints/background.ts` (message routing, Filler's own pages only), `entrypoints/sidepanel/App.tsx`
- `apps/extension/wxt.config.ts`: `optional_host_permissions` (http/https); E2E builds (`FILLER_E2E=1`) add `host_permissions: http://127.0.0.1/*` and write to `.output-e2e`
- `packages/core`: `FieldDescriptor.min/max`; `redactedValue()` and redaction-aware `detectSensitiveValue`
- `test-fixtures/simple-contact.*` (data-fx refs), `e2e/smoke.spec.ts`, `e2e/fixtures.ts` (loads `.output-e2e`), `package.json` (`e2e` scripts, `@filler/core` dev dependency), `eslint.config.js`, `.prettierignore`, `.gitignore`
- `docs/PLAYBOOK.md`: Phase 11 generic-first rewrite (site families) and the phase-map row

Tests: 300 unit (core 223, vault 54, extension 21, other 2) + 15 e2e. **Scanner label accuracy 74/74 (100%).** The discovered set matches the expected set exactly on all 7 fixtures, and all 6 must-skip elements are skipped.

## Phase 3 — design notes

- **Injection model.** The panel sends `SCAN_REQUEST`. The background runs `chrome.scripting.executeScript` twice with `allFrames: true`: once to install `/page-agent.js` (idempotent), then a function calling `__fillerPageAgent.scan()`. Chrome returns each frame's result with its `frameId`, so no `webNavigation` permission is needed. `mergeFrameScans` prefixes ids (`0:f3`, `12:f0`) and sets `frameId` for later fill routing.
- **Permissions.** No host permissions at install. It works through `activeTab` when the user invokes Filler on a tab. Otherwise the panel offers "Allow Filler to read forms on websites", which requests the manifest's `optional_host_permissions` from a click handler (user gesture). Without the `tabs` permission a tab's URL is often unknown, and Chrome returns the same generic "Cannot access contents of the page" error for `about:blank` and for a site without access. So once all-sites access has been granted, that error is reported as a restricted page instead of asking again.
- **The background accepts messages only from Filler's own extension pages** (`sender.url` must start with the extension origin), never from content or page scripts.
- **Discovery.** A tree walk in document order that descends into open shadow roots in place. Native radios and checkboxes group by `name` within their form (or tree). A lone checkbox is a single yes/no control. ARIA radios group by `role=radiogroup`; ARIA checkboxes group by the nearest `group/list/radiogroup/fieldset`. A listbox that is a combobox popup is skipped. Tag inputs are detected from `tag/chip/token` container classes, and their chips become the current value.
- **Visibility.** `checkVisibility` (display/visibility/content-visibility, but *not* opacity, because custom-styled checkboxes hide the native input with `opacity: 0`), plus not `aria-hidden`, not zero-size, and not positioned off the page. A radio or checkbox also counts as visible when its label is. Honeypots are also caught by label or name text ("leave this empty", `hp`, "bot trap").
- **Label order (Task 3.3):** `<label for>` / wrapping label → `aria-labelledby` / `aria-label` → **container** (a heading-like element inside the nearest ancestor that holds *only this control*) → **proximity** (preceding text in the same row, climbing only while the parent holds just this control) → placeholder → combobox text → non-dynamic `name`/`id`.
  - Groups use the group's ARIA label, then a fieldset legend that belongs to that group alone.
  - A text shared by several controls (Fiverr's "Full Name" row with First/Last inputs) is never used as the label, so those inputs fall back to their own placeholders.
  - **Grid rows** labelled only by their row name get the question prefixed ("Rate yourself: Communication").
  - `<small>` badges ("Private") are stripped.
- **Section heading** is the nearest fieldset legend or labelled group other than the label itself, else the nearest preceding h1–h4. That gives generic labels context: Day/Month/Year → "Date of birth", Institution → "Education 2".
- **Max length** comes from the `maxlength` attribute, else from on-page counters ("0 / 70", "At least 100 characters · 0/5000", "Maximum 70 characters") inside the control's own container, and only for text-like controls. Counters are left out of help text.
- **Sensitive values never leave the page.** Password and file values are never read. Any value matching `detectSensitiveValue` is replaced by `[filler:redacted:<category>]`, which the core policy still recognises as denied.
- **Selectors** use a stable id, then a stable name, then `aria-label`, then an `nth-of-type` path from the nearest stable-id ancestor, with ` >>> ` hops into shadow roots. Native radio groups use `input[type=radio][name=…]`.
- **Re-find** tries the live element, then the selector, then rescans and matches the SHA-256 signature plus its position among fields with the same signature. The React-style fixture proves all 5 fields are re-found after a re-render that regenerates every id.
- **E2E builds are separate** (`.output-e2e`, access to the fixture host only), so `pnpm e2e` never overwrites the production build the user loads from `.output`.
- The scanner-preview panel is labelled "dev" and is a temporary Task 3.5 view. Phase 6 replaces it with the real session UI.

### Open items surfaced in Phase 3
- Cross-origin iframes are only scanned when site access covers that origin (Chrome skips the frame otherwise). Acceptable for now; revisit in Phase 11 with real sites, such as embedded job or payment widgets.
- ARIA comboboxes whose options render only after opening report no options. Phase 4's filler opens them to read the options.
- Closed shadow roots are invisible to any extension. Vision mode (Phase 10) is the fallback.
- Tag-input detection is based on class names. Phase 11 platform profiles can add explicit selectors for sites it misses.
- The live-verification walk used Playwright screenshots of the panel at 320px (zero console errors, no horizontal overflow). The user can load the unpacked build by hand in Chrome as described in the phase summary.

---

## Phase 4 — files

Created:
- `apps/extension/src/page-agent/events.ts`: native value setter, input/change/focus events, key-by-key typing, full pointer/mouse click sequence, `waitFor`
- `apps/extension/src/page-agent/fill.ts`: `fill()`/`fillOne()` with per-kind primitives and read-back verification
- `apps/extension/src/page-agent/observer.ts`: `observe()`/`stopObserving()` (MutationObserver + URL polling, debounced diffs)
- `apps/extension/src/page-agent/navigation.ts`: `listNavigation()`/`clickNavigation()` with code-enforced submit refusal
- `apps/extension/src/page-agent/highlight.ts`: `highlight()`/`clearHighlights()` shadow-DOM overlay
- `packages/core/src/text/match.ts` (+ `match.test.ts`): `editDistance`, `similarity`, `matchOption`, `parseLooseDate`, `formatIsoDate`
- `test-fixtures/fill-lab.html` (+ `.expected.json`): keyboard-only input, digits-only input, multi-select, date and month inputs, maxlength, rich-text editor, autocomplete, radio, checkbox
- `e2e/agent.ts` (helpers), `e2e/fill.spec.ts` (9 tests), `e2e/observe-nav-highlight.spec.ts` (6 tests)

Modified:
- `apps/extension/src/page-agent/scan.ts`: registry keeps each field's descriptor; `describeControls`, `resolveControl`, `getEntry`, `entries`, `forget`
- `apps/extension/src/page-agent/constraints.ts`: exports `rawCurrentValue` (page-internal only)
- `apps/extension/entrypoints/page-agent.ts`: agent API adds fill/observe/navigation/highlight/stop
- `apps/extension/src/messaging/protocol.ts`: new request types `FILL`, `HIGHLIGHT`, `OBSERVE`, `END_SESSION`, `NAV_LIST`, `NAV_CLICK`; page events `FIELDS_CHANGED`/`FIELD_FOCUSED`; `FieldIdSchema`, `splitId`/`joinId`; `REFUSED` error code
- `apps/extension/src/messaging/background-handler.ts`, `client.ts`, `scan-merge.ts` (`groupByFrame`), `messaging.test.ts`
- `apps/extension/entrypoints/sidepanel/ScannerPreview.tsx`: observes after a scan, live field list, change banner, highlight toggle, focused-row sync
- `test-fixtures/upwork-profile-like.html` (tag input commits on Enter), `fiverr-seller-like.html` (occupation dropdown renders its options only when open)
- `e2e/panel.spec.ts` (+4 tests), `e2e/scanner.spec.ts` (fill-lab added)

Tests: 335 unit (core 255, vault 54, extension 24, other 2) + 35 e2e. Scanner labels 84/84.

## Phase 4 — design notes

- **Safety lives in the page agent, not only in the caller.** `fillOne` re-runs `classifyRisk` on the live field (with its current, redacted value) and refuses password, file, disabled and read-only fields, whatever the panel asked for. `clickNavigation` re-reads and re-classifies the button's *current* text at click time, so a "Next" that turned into "Submit" is refused. The e2e suite asks Filler to fill Password, Card number, Passport and a prefilled-card field: all four stay empty with readable reasons, and every fixture's submit log stays empty.
- **Text:** paste first (prototype `value` setter + `input` + `change` + `blur`). If the read-back differs, retry once with key-by-key typing (`keydown`/`keypress`/set/`input`/`keyup`). Otherwise fail with what the site shows now. **No silent truncation:** text longer than `maxLength` fails before touching the field ("The text is 5001 characters but this field allows 5000").
- **Choices** use `matchOption` (value → text → unique whole-word prefix either way → fuzzy ≥ 0.85 with a clear margin), otherwise "Option not found: "X". Available: …". Radios and checkboxes are clicked (full pointer/mouse sequence), never just `.checked =`. Checkbox groups untick options that are not wanted. A single checkbox only accepts yes/no-style values.
- **Custom widgets:** an ARIA listbox opens, then the option is clicked. An ARIA combobox opens, waits up to 1.5 s for its popup (`aria-controls`/`aria-owns` or a nested listbox), falls back to typing into its search box, and closes with Escape on failure. A native input with `role=combobox` (autocomplete) is filled, then the exact matching suggestion is clicked if one appears.
- **Dates:** `parseLooseDate` reads ISO, d/m/y (day-first, falling back to m/d/y only when the first number can't be a day), "14 May 2003", "May 14, 2003" and "Aug 2022". `date` inputs need a full date; `month` inputs get `yyyy-mm`. Split day/month/year selects are just three selects.
- **Tags:** each missing item is typed then committed with Enter (comma as a fallback); existing chips are kept.
- **Rich editors:** `innerText` + input event; `execCommand('insertText')` only as the last fallback (deprecated, but the only path some editors honour).
- **Observer:** a MutationObserver (childList, subtree, and visibility-related attributes) plus a 500 ms URL poll (SPA history changes in the page's own world aren't visible to an isolated-world patch). Debounced 250 ms, it reports **only the diff**: newly visible controls get fresh ids, hidden or removed ones are listed in `removed` and dropped from the registry. The overlay's own DOM changes are ignored. *Bug found by the tests and fixed:* attribute mutations have no added/removed nodes, and `[].every()` is `true`, so every attribute change had been classed as "own".
- **Highlighter:** one host element marked `data-filler-overlay` (the scanner skips it) with an open shadow root and `pointer-events: none` throughout, positioned in document coordinates. It repositions on scroll (capture), resize and every 500 ms for layout shifts. Each state has a colour *and* a text badge ("Vault", "AI draft", "Needs you", "✓ Filled", "! Failed", "Never filled"). Badges sit top-right because the first screenshot showed top-left badges covering field labels. Tooltips show the caller-supplied title and an already-masked preview. `focusin`/`click` on a highlighted field emits `FIELD_FOCUSED`, and the panel rings and scrolls to that row.
- **Messaging:** field ids are page-wide `frameId:localId`. The background groups fill items by frame and calls each frame's agent with `executeScript({frameIds:[id]})`, so iframe fields are routed correctly (e2e: the referral code inside the iframe gets filled). Page agents report to the panel with `runtime.sendMessage`; the panel keeps only events from its own tab, validates them and adds the frame prefix. **The background answers only Filler's own extension pages:** the e2e suite proves a script in the page's isolated world gets no reply.

### Open items surfaced in Phase 4
- The wizard's "Next: add your rate"-style buttons (text beyond the navigation words) count as submit-like and are refused. That is safe but conservative; Phase 11 platform profiles can whitelist known navigation texts per site family.
- The observer diff is per frame. A brand-new iframe added mid-session needs the agent injected into it (the panel can rescan). Automatic injection into new frames is left for Phase 6/11.
- Highlights for fields that appear later are not added automatically in the dev preview; the Phase 6 session UI will re-highlight after every plan update.
- Checkbox groups are cleared to exactly the wanted set. That is right for a plan the user approved, but Phase 5/6 must show unticks in the review list.
