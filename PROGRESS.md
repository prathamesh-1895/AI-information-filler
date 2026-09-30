# Filler — Build Progress

**Last completed phase:** Phase 0 — Foundation & repo scaffold (2026-10-01)

Playbook: `docs/PLAYBOOK.md` · Architecture: `docs/ARCHITECTURE.md`

## Phase status

| # | Phase | Status | Summary |
|---|---|---|---|
| 0 | Foundation & repo scaffold | ✅ COMPLETE (2026-10-01) | pnpm/Turbo monorepo, 4 packages, WXT extension shell with side panel, Vitest + Playwright harness, fixture server, governance files |
| 1 | Core domain model & policy | ⬜ NOT STARTED | |
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

- Next: **Phase 1, Task 1.1** (canonical key schema). Model: **Opus 5.5**.
- **Model log:** Phase 0 — Opus 5.5.
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
