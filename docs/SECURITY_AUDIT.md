# Filler — security and privacy audit

PLAYBOOK Task 12.1, 2026-10-03. Each item lists how it was checked; the evidence is a test that runs in the gate (`pnpm typecheck && pnpm lint && pnpm test && pnpm e2e`) or a script CI runs. ✅ = verified, ⚠️ = known limitation (accepted and documented), 🔧 = found in this audit and fixed.

## Summary

| # | Area | Result |
|---|---|---|
| 1 | Secrets in the repo and its history | ✅ |
| 2 | Extension permissions, CSP, remote code | ✅ |
| 3 | Vault at rest (IndexedDB, chrome.storage, logs, errors) | 🔧 fixed: fact row ids named personal topics |
| 4 | What the AI receives (classify, generate, extract, vision) | 🔧 fixed: city and country sent to drafts as filled context |
| 5 | Prompt injection, including text in images | ✅ (⚠️ live models untested until checkpoint B) |
| 6 | Never clicking submit | 🔧 fixed: form-submitting "Next" buttons, disguised names |
| 7 | Row Level Security, rate limits | ✅ |
| 8 | Dependencies | ✅ |
| 9 | Memory over long use | 🔧 fixed: per-session history buffer never released |

## 1. Secrets ✅
- `scripts/secret-scan.mjs` scans every tracked file **and every line ever added in git history**. It looks for Google/OpenAI/OpenRouter/Groq/Anthropic/GitHub/Slack/AWS keys, private keys, JWTs (Supabase anon/service keys) and service-role assignments, plus any committed `.env`/`.pem`. Result: clean (320 files, full history).
- The patterns were checked against fake keys of each kind (all detected).
- `.env` is git-ignored and has never been committed. `.env.example` holds placeholders only.
- Provider keys exist only as Supabase secrets. The extension holds only the public project URL and anon key. Health and function tests assert a configured key never appears in a response.

## 2. Permissions, CSP, remote code ✅
- `scripts/audit-build.mjs` checks the production manifest:
  - permissions are exactly `sidePanel, storage, activeTab, scripting`;
  - **no** `host_permissions` at install (optional `http/https` only, requested from the panel);
  - no `content_scripts`, `externally_connectable` or `web_accessible_resources`;
  - **no CSP override**, so Chrome's strict MV3 default applies: `script-src 'self'`, no eval, no remote scripts.
- The bundle is scanned for `eval(`, `new Function(`, remote `importScripts`/`<script src=http…>`: none. The pdf.js worker ships inside the extension.
- The page agent is injected only on demand, into the tab the user invoked Filler on. Page scripts cannot drive the background; `panel.spec.ts` proves an isolated-world script gets no reply.
- E2E builds add host access for the local fixture server, and the tab-snapshot test build adds `<all_urls>` because Playwright cannot click the toolbar. Production builds have neither, which the build audit checks.

## 3. Vault at rest 🔧
- Values in all six data tables are AES-256-GCM encrypted with a per-record IV and an AAD that binds each record to its table and id. The key comes from PBKDF2-SHA256 with 600,000 iterations and is held only in memory (Phases 2 and 7 tests).
- **Finding (fixed):** fact rows were stored under their key names (`contact.email`, `custom.medical_note`). Values were encrypted, but custom key names, made from form labels, can reveal personal topics to anyone who can read the browser profile.
  - Fact row ids are now `k` + 40 hex characters of HMAC-SHA256 under a key derived from the vault key (HKDF). They are the same on every device that shares the vault, so sync still merges.
  - Older rows are renamed on unlock, after a backup import and after a cloud copy is applied. Passphrase change recomputes them.
  - Tests: `service.test.ts` → "fact row ids", and `security.spec.ts` → "at rest".
- `security.spec.ts` dumps every IndexedDB store plus `chrome.storage.local` and `chrome.storage.session` after real use: onboarding, facts including a restricted one, a filled session, history. It finds none of the names, phone, email, date of birth, address, mother's name, the restricted note, the one-off answer or the passphrase.
  - `chrome.storage.local` holds settings and the Supabase sign-in session (needed to call the user's own functions).
  - `chrome.storage.session` holds the vault key only when "Stay unlocked until I close the browser" is on (off by default, memory-only).
- **Logs:** the extension and packages contain no `console.*` calls. Edge Functions log metadata only (endpoint, counts, tokens, latency, provider), and tests assert no field text, facts, drafts, images or user ids appear.
- **Errors:** vault errors never include values (e.g. "This looks like a card number. Filler never stores that kind of value.").
  - ⚠️ Page-fill errors such as "Option not found: "Pune"" echo the value into the user's own review list. They stay in panel memory and the encrypted history and are never logged or sent.
- There are no crash reports or telemetry of any kind.

## 4. What the AI receives 🔧
`security.spec.ts` → "AI payload audit" runs one signed-in session that hits all four AI endpoints through the real handlers: classify, a draft (generate), a résumé import (extract) and a tab snapshot (vision). Every prompt the "model" received is captured.
- No phone, email, date of birth, address, mother's name, restricted note or city appears in any prompt.
- **classify** carries no vault values at all, only field labels, options and help text, redacted on the device and again on the server.
- **generate** carries only public facts the user left ticked. Personal and restricted facts are never selectable (`selectFacts`), and the background re-checks the panel's list (it can only remove keys).
- **Finding (fixed):** values already filled in the session go to drafts as consistency context, filtered only by registry sensitivity. The registry marks city, district, state and country `public` (they are routinely shown on profiles), so after the demo's address step the user's city reached the draft prompt. The full-gate run caught it (`drafts.spec.ts` asserts no city in any draft prompt). Filled context is now limited to profile groups (bio, profession, work, education, projects, skills, languages, rates, links) by `isDraftContextKey`. Names, contact and address details never go. This is covered by a core unit test and the request-builder test.
- **extract** gets résumé text with contact details removed on the device (`withoutContacts`), and is redacted again on the server.
- **vision** gets one frame the user previewed, with never-fill fields and user-drawn areas painted solid on the device. `screen.spec.ts` decodes the exact uploaded JPEG and checks those pixels are solid.
  - If the picture does not line up with the page's layout, sending is blocked until the user confirms they hid everything (`screen.spec.ts` covers this).

## 5. Prompt injection ✅ / ⚠️
- Page text sits in a delimited, JSON-encoded block with `<`/`>` escaped, so it cannot close the block. Every system prompt says that block is untrusted data.
- Replies must match strict schemas. Each item is then checked:
  - ids must have been sent;
  - no URLs or action words;
  - keys must be real, and custom keys only for facts;
  - never-store data is never asked for;
  - deny policy is re-applied on the server and on the client;
  - drafts face the invention check (every name and number must be in what was sent);
  - extracted facts must appear in the résumé.
- **Adversarial suites** use "compromised" fake models that obey the injection:
  - classify (`ai.test.ts`) and the `ai-understanding` fixture with hidden "ignore previous instructions" text;
  - drafts that invent employers (`generate.test.ts`);
  - extraction that invents an employer (`extract.test.ts`);
  - **vision reading text in an image** (`vision.test.ts`): a "Password" field relabelled as email still comes back denied, a "Go to evil.example" label is dropped, purpose and warnings with links are replaced, boxes are clamped.
  - In every case the output contract holds.
- ⚠️ These suites use scripted models. How often a real model follows injected text is unmeasured until a live key exists (checkpoint B). The guards above do not depend on the model behaving.
- ⚠️ The panel shows a field's help text as the page provides it, so hidden injected text can be *displayed* (nothing acts on it).

## 6. Never clicking submit 🔧
- **Finding (fixed):** a `<button type="submit">Next</button>`, or a `<button>` with no type inside a form (which also submits), was classified as navigation because only its text was checked. Clicking it would send the form.
  - Any button that would submit its form is now submit-like, whatever it says.
  - Every name a button has (text, value, aria-label, title) is checked for commit words: a visible "Next" with `aria-label="Submit application"` is refused.
- `test-fixtures/submit-fuzz.html` holds 18 disguised commit buttons, all refused, with `security.spec.ts` asserting each verdict and that nothing was submitted:
  - form-submitting Next/Continue/Proceed, and an image button;
  - commit words hidden in aria-label or title;
  - spaced letters, a zero-width character inside "Submit", a Cyrillic look-alike letter;
  - an emoji-only button, an icon button whose text comes from CSS;
  - `div`/`a` with role=button ("Pay ₹499", "Checkout"), "Continue to payment", "Review & submit", "Done", "OK", "Next (final)".
- Real navigation (`type=button` Next / Save & continue / Back, and a formless Continue) stays allowed.
- Platform profiles can only *add* never-click texts, checked in the background before any navigation click.
- Filler never auto-clicks; the panel tells the user to click Next or Submit themselves.

## 7. Server: RLS and limits ✅
- `rls.test.ts` (16 tests) runs every migration on real Postgres (PGlite). It proves one user cannot read or change another user's rows in any table. A control test turns RLS off and shows the leak it prevents.
- Only the service role can count usage or touch the cache.
- Limits: per-user daily calls and tokens, plus a global daily counter. Both are checked *before* a model call, and refused calls are not counted. If the quota check itself fails, the request is refused (fail closed). A limit gives a friendly 429 and the extension switches to offline mode. Covered by function tests and `ai.spec.ts`.
- Every function requires a signed-in user and accepts only the extension's origin (web pages get 403).

## 8. Dependencies ✅
`pnpm audit` (production and development): no known vulnerabilities on 2026-10-03. CI runs it on every push.

## 9. Memory over long use 🔧
**Finding (fixed):** the background kept each session's history buffer after the session ended or was replaced. It is now freed on end, restart and tab close. `host.test.ts` runs 40 sessions on one tab and checks one session, one buffer and no stale queues remain, and that history keeps only the newest 10 per site.

## Known limitations (accepted)
1. Live AI behaviour (injection resistance, extraction and vision quality) is unmeasured until checkpoint B. Guards are model-independent.
2. Tab snapshots need `activeTab` (the user clicked Filler's toolbar button on that tab). Otherwise the user is told to click it, or to use Share.
3. Hiding areas in a picture needs a pointer (no keyboard drawing yet).
4. Hidden page text can be shown to the user as help text (never acted on).
5. Fill errors can show the attempted value in the user's own panel.
6. The Supabase sign-in session lives in `chrome.storage.local` (as supabase-js stores it). Anyone with access to the unlocked browser profile could use it to reach the user's *encrypted* cloud blob and AI quota, but not to decrypt the vault.
7. Changing the passphrase drops deletion markers for facts (row ids change with the key). The cloud copy is then replaced, as for any passphrase change.
