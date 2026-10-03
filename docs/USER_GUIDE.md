# Filler user guide

Filler fills web forms with your own details. It asks before it types, never submits, and never touches passwords, payment details or ID numbers.

## 1. First start

1. Click the Filler icon (or press **Alt+Shift+F**). The side panel opens.
2. **Get started** → choose a passphrase. It encrypts everything Filler stores. **It cannot be recovered**: if you forget it, delete the vault and start again.
3. Add a few details (name, email, city, skills…), import a résumé (see 4), or skip.

## 2. Filling a page

1. Open the form (sign in to the site yourself first).
2. In **Fill**, optionally say what you're doing ("Create my Upwork profile as a business consultant"), or pick a **template**. Then press **Start on this page**.
   - **Alt+Shift+S** starts on the current tab directly.
3. Filler shows:
   - **Filler needs you:** questions for details it doesn't have yet. Your answer is saved for next time unless you untick **Save to my vault** / **Save for reuse**.
   - **Review:** what it would fill, with where each value came from (Vault, Remembered, You, AI draft). **Approve**, **Edit** or **Skip** each one, or **Approve all from vault**. Keyboard: ↑/↓ to move, A approve, E edit, S skip.
   - **Not filled by Filler:** fields it never fills (passwords, card, bank, Aadhaar, PAN, passport, OTP, CAPTCHA) or that you skipped.
4. Press **Fill n approved**. Filler types the values and checks the page accepted them.
5. On multi-step forms, click **Next** on the page yourself; Filler follows and plans the next step.
6. When everything is done: "Filler is done. Review the page and press Submit yourself."

**What is this?** next to any field explains what it asks, the value Filler would use, and where that explanation came from.

**Site profiles:** on common kinds of sites (freelance, jobs, online forms, events, college and government forms), Filler shows **Tips** and length targets. Turn them off in Settings; Filler works the same without them.

## 3. AI help (optional)

Needs an account (Settings → Account → sign in with a 6-digit email code) and AI on the server. The chip at the top always says **AI on** or **Offline mode** and why.

- **Understanding fields:** unfamiliar questions ("Where can we see your code?") are matched to your details. Only the page's labels, options and help text are sent, never your details.
- **Drafts:** on long questions, **Using: Projects (2), Skills…** shows exactly which of your details may be sent. Untick any, add a hint, then press **Draft with AI**.
  - The yellow card shows the draft, a character count, **Why this**, other versions, and **Regenerate** with "Change it how?".
  - Drafts only use your facts. A draft that names something you never wrote is thrown away.
  - AI text is never approved automatically. Approved drafts are saved for reuse.
- **Goal chips:** role, audience, tone, platform and language for drafts. Edit them any time.
- **Limits:** there is a daily limit. When reached, Filler keeps working offline and asks you instead.

## 4. Import a résumé

**My details → Import a résumé or profile:** choose a PDF, Word or text file, or paste text (for example your LinkedIn About and Experience). **Find my details**.

- The file never leaves your device. Contact details are found on the device; with AI on, the rest of the text goes to the AI to pick out details.
- Every detail is shown with **New**, **Already saved**, **Different from saved** (with the saved value) or **Adds to saved**. Untick or edit anything, then **Save**. Changes to saved values are never ticked for you.

## 5. Screen mode

For forms Filler can't read (drawn on a canvas, inside other apps), open the **Screen** tab:

- **Snapshot this tab**, or **Share a screen or window** (the browser asks you which; a red **Sharing** badge stays on until you press **Stop sharing**).
- You see the picture first. Password, card and ID fields are blacked out automatically in tabs. **Drag** over anything else private to hide it. Hidden areas are painted over on your device; the AI never sees them.
- **Read with AI** lists the fields in screen order with your values and **Copy** buttons. "Filler can't type into this app. Copy each value."
- **What is this?** → drag around one field to ask about just that area.
- If the picture doesn't line up with the page, Filler asks you to hide private fields yourself and confirm before anything is sent.

## 6. My details

- Search, edit, reveal or delete details. Repeating sections (education, jobs, projects, languages, certifications) can be added, edited and reordered.
- **Never filled:** the built-in list (locked) plus your own phrases.
- **Export backup** downloads an encrypted backup (useless without your passphrase); **Import backup** restores one, on this or another device. **Delete everything** (type DELETE) erases the vault.

## 7. Settings

- **Security:** auto-lock time, stay unlocked until the browser closes, lock now.
- **Account and sync:** sign in, turn on encrypted sync. The server only ever stores one encrypted blob.
- **AI help:** on/off, Test AI connection, usage today.
- **Filling:** site profiles on/off, typing mode, highlight fields, answer language, trusted sites (vault values approved automatically; never AI text), forget what was learned on a site, extra never-fill phrases, theme.

## 8. History

The start screen lists **Past sessions** on the current site (values masked). In a session, **Re-use them** offers last time's answers for fields still waiting. **Copy summary** copies what was filled (personal values masked).

## FAQ

- **Does Filler submit forms?** No. Never. It also refuses buttons like Submit, Pay, Apply, Publish or Confirm, even when they are disguised.
- **Does it fill passwords or card numbers?** No. These are detected and left empty, and Filler refuses to store them.
- **Do I need an account?** No. Without one, everything except sync and AI works.
- **Where is my data?** In your browser, encrypted. With sync on, an encrypted copy is in your Supabase account. See [PRIVACY.md](PRIVACY.md).
- **I forgot my passphrase.** It cannot be recovered. Delete the vault (My details → Delete everything) and start again, or import a backup whose passphrase you remember.
- **A site's Next button isn't clicked.** Filler never clicks buttons that would submit a form; click Next yourself and Filler follows.
