# Filler — 7-minute live demo

Everything runs on the bundled practice forms, so no real site, account or form is ever submitted. The script is rehearsed automatically in two modes by `e2e/demo.spec.ts` (AI on through the local mock backend, and offline).

## Before you start (5 minutes, the day before)

1. `pnpm install`, then `pnpm --filter @filler/extension build`.
   - For **AI on** with a real provider, finish Supabase setup and the AI key first (README).
   - For a rehearsal with no internet, use the mock instead: `node scripts/mock-supabase.mjs` and build with `VITE_SUPABASE_URL=http://127.0.0.1:54321 VITE_SUPABASE_ANON_KEY=test-anon-key`.
2. `pnpm fixtures`. Practice forms are on http://127.0.0.1:5178/.
3. Load the extension: `chrome://extensions` → Developer mode → Load unpacked → `apps/extension/.output/chrome-mv3`. Pin it.
4. Use a **fresh Chrome profile**. Open these tabs:
   - `google-form-like.html`;
   - `upwork-profile-like.html`;
   - `canvas-form.html`.
5. Have `test-fixtures/resumes/asha-verma.pdf` ready (synthetic person).

## The demo

| Time | Do | Say |
|---|---|---|
| 0:00 | Title slide: one form after another asking the same things. | "Every site asks the same questions. Filler answers them once, safely, and you stay in control." |
| 0:30 | Click the Filler icon → **Get started** → passphrase → tick "cannot be recovered" → **Create vault** → **Skip for now**. | "Everything is encrypted on this laptop with a passphrase only I know." |
| 1:00 | **My details → Import a résumé** → choose `asha-verma.pdf` → **Find my details**. Scroll the review. Untick *Date of birth* → **Save**. | "The file never leaves the laptop. Contact details are found locally and never sent to AI. I review every detail before it's saved." |
| 2:00 | Google-Form tab → **Fill → Start on this page**. Answer *Which year* (Final year) and the two ratings with the buttons. **Approve all from vault → Fill**. | "It recognised name, email, phone, city and skills, and asked only what it couldn't know. Ratings are my call, so it asks." |
| 3:00 | Upwork tab → Template **Upwork profile: role** = "Business consultant" → **Start**. Point at goal chips and **Tips for Upwork / Freelance marketplace**. | "It knows what kind of site this is: a 1,000–5,000 character overview works best." |
| 3:30 | The résumé already gave title, skills and overview: **Approve all from vault → Fill**. Click **Next** on the page (step 2: address from the vault) → **Approve all from vault → Fill** → **Next** again. | "I click Next myself. Filler never clicks a button that could submit. It just follows." |
| 4:15 | *(AI on)* Step 3, *Why should clients hire you?*: show **Using: Projects (2), Skills…** → **Draft with AI**. Show the yellow card: count, Why this, other versions. Type "mention my GST Automation project" → **Regenerate** → **Approve** → **Fill**. | "Only the details I tick are sent. Drafts can only use my facts; a draft naming anything I never wrote is thrown away. AI text is never approved for me." |
| 5:00 | Canvas tab → **Screen → Snapshot this tab**. Drag over the *Password* box: it turns solid. **Read with AI**. Click **Copy** next to Full name; paste into Notepad. | "Some forms can't be read: canvas apps, other programs. Filler reads a picture I approved, with private areas painted over on my laptop. It can't type here, so I copy each value." |
| 6:00 | Privacy: open the tricky form (`tricky.html`) → **Start** → open **Not filled by Filler**: Password, Card number, Passport number show **Never filled**. Click **What is this?** on Passport. | "Passwords, cards, bank details, Aadhaar, PAN, passport: never filled, never stored. That rule is in code, not a prompt." |
| 6:30 | Settings: show **AI help → usage today**, **Offline mode** chip (sign out), and **Delete everything** (don't confirm). | "Without an account or AI it still fills from my vault. There's a daily limit, and I can erase everything in one step." |
| 7:00 | Close. | "Type once. Review always. Submit yourself." |

## If AI is off or down

Run the same script. On the overview, Filler says "Offline mode: Filler needs you to write this one". Type two sentences and keep **Save for reuse** ticked. In Screen mode the panel says reading the picture needs AI and that nothing has been sent. Point out that the rest of the flow is unchanged. That is the offline guarantee.

## Questions to expect

- **"Does it submit?"** No: disguised buttons included (show `test-fixtures/submit-fuzz.html` in the security audit).
- **"Where's my data?"** See [PRIVACY.md](PRIVACY.md): device, plus an encrypted blob if sync is on; the AI only gets what each feature needs.
- **"Which AI?"** Any free-tier provider behind one interface (Gemini by default). Model names are configuration.
