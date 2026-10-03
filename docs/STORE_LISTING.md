# Chrome Web Store listing draft (v1.0.0)

This is a draft for the Chrome Web Store (and Edge Add-ons). The user owns the developer account and does the publishing; Filler's code never does it.

- **Package:** `pnpm package` → `apps/extension/.output/filler-1.0.0-chrome.zip`.
- **Fresh-profile check:** `pnpm verify:package`.

## Store item

| Field | Text |
|---|---|
| Name | Filler: private form-filling assistant |
| Summary (≤ 132 chars) | Fill forms from your own encrypted details. You review every value, and you press submit. Optional AI for open questions. |
| Category | Productivity → Workflow & Planning |
| Language | English |
| Icon | `apps/extension/public/icon/128.png` |
| Screenshots (1280×800) | Built from `docs/screenshots/`: start, AI draft, screen mode, import review, session in dark mode |
| Homepage / support | The project repository's README and issues page |
| Privacy policy | `docs/PRIVACY.md` (publish it at a public URL, such as the repository's page) |

### Description

> Filler fills web forms from details you save once, in a vault encrypted on your own device.
>
> **How it works**
> - Open the side panel on any form and press **Start on this page**.
> - Filler shows a plan: each field, the value it would use, and where it came from.
> - You approve the plan, then Filler types it in. It fills the way a person does, so modern sites register every value.
> - It asks once for anything it doesn't know and remembers it for next time.
> - It follows you across multi-page forms. You click Next and Submit yourself; Filler never presses a button that could submit.
>
> **Optional AI help** (needs a free account; can be turned off)
> - Understands unusual questions.
> - Drafts answers to open questions using only the facts you tick. A draft that mentions anything you never wrote is discarded.
> - Reads forms it can't access directly, such as canvas apps, from a picture you approve. You can paint over private areas first.
> - Imports details from your résumé for you to review.
>
> **Private by design**
> - The vault is encrypted with AES-256-GCM using a passphrase only you know.
> - Sync is optional and end-to-end encrypted.
> - Filler never fills or stores passwords, card or bank details, one-time codes, or government ID numbers (passport, Aadhaar, PAN and similar).
> - It never solves CAPTCHAs.
> - It works fully offline, without an account.

## Single purpose

Filler helps the user fill web forms with their own saved details after they review and approve a plan.

## Permission justifications

| Permission | Why Filler needs it |
|---|---|
| `sidePanel` | The whole interface lives in Chrome's side panel, next to the form the user is filling. |
| `storage` | Keeps settings and the session state of the open side panel. The user's details are stored encrypted in the extension's IndexedDB, never in plain text. |
| `activeTab` | Gives Filler temporary access only to the tab where the user clicked the toolbar button or started a session. That is how it reads the form's fields and takes a tab snapshot in Screen mode. |
| `scripting` | Injects Filler's own bundled page script, on demand, into the tab the user chose. The script scans fields, types approved values and highlights fields. No content script runs automatically, and no remote code is ever loaded. |
| Optional host access (`http://*/*`, `https://*/*`) | Never granted at install. Chrome asks the user only if they press **Allow access**, which appears when `activeTab` access has lapsed, for example after a multi-page form navigates. This lets Filler keep following the form. The user can remove it at any time on the extension's Chrome details page (Site access). |

**Remote code:** none. All JavaScript ships in the package, and the default MV3 content security policy applies. `pnpm audit:build` checks both.

## Data usage disclosures (Privacy practices tab)

| Data type | Collected? | Notes |
|---|---|---|
| Personally identifiable information | Yes, by the user's choice | Name, email, phone, address and work history that the user saves. They are stored encrypted on the device. If the user turns on sync, they are uploaded only as an end-to-end encrypted blob the server can't read. |
| Authentication information | Email address only | Used for the optional account (email sign-in code). Filler never handles passwords. |
| Website content | Only when the user asks for AI help | Field labels and options (classify), or an approved picture with private areas blacked out (Screen mode), are sent to Filler's own backend. The minimum needed is sent. |
| Financial / payment, health, location history, web history, user activity | No | Payment and ID fields are refused in code. |

Certifications to tick:
- The data is not sold to third parties.
- The data is not used or transferred for purposes unrelated to the single purpose.
- The data is not used to determine creditworthiness or for lending.

## Reviewer notes

> Test without an account: install, press **Get started**, create a vault, and open any page with a form. Press **Start on this page**. AI features need sign-in and can be left off; everything else works offline. Filler will not press submit buttons. That is intended.

## Before submitting (user's checklist)

1. Create the Chrome Web Store developer account. There is a one-time registration fee, and the user creates the account.
2. Build with the production Supabase URL and anon key in the root `.env` (see README), then run `pnpm package` and `pnpm verify:package`.
3. Publish `PRIVACY.md` at a public URL and paste the link into the listing.
4. Upload the zip, the screenshots and the 128 px icon. Paste the text above.
5. Choose the visibility. **Unlisted** is a good fit for a project demo.
