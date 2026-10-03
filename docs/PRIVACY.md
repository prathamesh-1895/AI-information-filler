# Filler privacy

Filler is built so that your details stay yours. This page says exactly what goes where.

## Stays on your device (always)

- **Your vault:** every detail, approved answer, field memory, imported résumé text and session history, encrypted with AES-256-GCM.
  - The key is derived from your passphrase (PBKDF2-SHA256, 600,000 iterations) and kept only in memory while unlocked.
  - Even the names of your details are hashed in storage.
- **Your passphrase:** never stored, never sent.
- **Résumé files:** read in the side panel; never uploaded.
- **Pictures in Screen mode:** taken only when you press the button. You see them first, and hidden areas are painted over before anything leaves the device.
- **Settings:** in the browser's extension storage (no personal data).
- **Optional:** "Stay unlocked until I close the browser" keeps the key in the browser's memory-only session storage.

Filler has no analytics, tracking, crash reports or advertising.

## Sent to your Supabase account (only if you sign in)

- **Sign-in:** your email address (for the 6-digit code) and Supabase's session tokens.
- **Sync** (only if you turn it on): **one encrypted blob** of your vault. The server cannot read values, detail names, sites, or how many details you have (beyond size). It is decrypted only on your devices, with your passphrase.
- **AI usage counters:** calls and tokens per day, per feature (no content).

## Sent to the AI provider (only with AI help on, and only when a feature runs)

Requests go through Filler's server (your Supabase project), which holds the provider key. The provider sees requests from that server, not from your browser.

| Feature | What is sent | What is never sent |
|---|---|---|
| Understanding fields | Field labels, options, help text and section titles; the site's address and page title; your goal. Emails, phone numbers and ID-like numbers in that text are removed first. | Any value from your vault; what is typed on the page; your own custom detail names |
| Drafting an answer | The question; your goal; **only the public details you leave ticked** (e.g. projects, skills); profile values already filled in this session (e.g. your headline or rate, never your name, contact details or address); up to 3 of your earlier approved answers to similar questions; your hint | Contact details, address, date of birth, family details, anything marked personal or private |
| Résumé import | The résumé text **with contact details removed on your device** (email, phone, links, date of birth, location) | The file itself; your contact details |
| Screen mode | The picture you previewed, downscaled, with hidden areas painted over; the page's title | Anything you hid; never-fill fields in tabs (hidden automatically) |

**Free-tier providers may use what they receive to improve their products** (for example Google AI Studio's free tier). This is one more reason Filler sends as little as possible. If that matters to you, keep AI help off (Settings), or use a paid tier or a local model (Ollama) on your own server.

The server logs only metadata: which feature, how many fields or tokens, how long it took, which provider. It never logs content, and nothing is cached except field classifications (which contain no personal data).

## Never stored, never filled

Passwords, one-time codes, card numbers, CVV, card expiry, bank account and IFSC, UPI PINs, passport, Aadhaar, PAN, SSN and other government ID numbers, security questions, CAPTCHAs. You can add your own phrases to this list (Settings); you cannot remove the built-in ones.

## Deleting everything

- **This device:** My details → Delete everything (type DELETE). The vault, history and memory are erased.
- **Learned fields for one site:** Settings → Forget what Filler learned on this site.
- **Cloud copy:** sign in, then delete the vault row and your account in your Supabase project (Authentication → Users), or ask your project administrator.
- **Extension:** remove it in `chrome://extensions`. Chrome deletes its storage.
