# Test fixtures

Local form pages used by automated tests. Tests never touch real third-party sites.

Serve them with `pnpm fixtures` (http://127.0.0.1:5178/).

Every page includes `fixture-harness.js`, which records submit attempts in
`window.__submits` (must stay empty after Filler runs). Every fillable control
carries a `data-fx="<ref>"` attribute (the scanner never reads it). Each
`<name>.html` has a `<name>.expected.json` listing, per ref, the expected label,
input type and constraints (checked by `e2e/scanner.spec.ts`) and the expected
`kind` / `canonicalKey` (used by the Phase 5 mapper).

| Fixture | What it exercises | Added in |
|---|---|---|
| `simple-contact.html` | 5 basic labelled fields | Phase 0 |
| `google-form-like.html` | Google-Forms structure: `role=heading` questions, `aria-labelledby`, ARIA radio/checkbox groups, listbox dropdown, "Other:" text, radio grid, `*` required markers | Phase 3 |
| `upwork-profile-like.html` | 3-step wizard (steps 2-3 hidden), counters (`0 / 70`, `0/5000`), tag input with chips, radio fieldset, placeholder select option, hidden "Add employment" modal | Phase 3 |
| `fiverr-seller-like.html` | Row layout with `.label` divs, first/last inputs sharing one row label (fall back to placeholders), `<small>Private</small>` badges, file input, ARIA combobox without options, disabled prefilled email | Phase 3 |
| `react-controlled.html` | Offline React-style controlled form: re-render recreates elements with random ids; values only stick through real input events | Phase 3 |
| `tricky.html` (+ `tricky-frame.html`) | Shadow DOM, same-origin iframe, sibling-div label, placeholder-only, name-only, contenteditable, optgroups, denied fields (password/card/passport/prefilled card), custom-styled checkbox, and six things that must NOT be found (honeypot, hidden input, display:none, visibility:hidden, aria-hidden, zero-size) | Phase 3 |
| `job-application-like.html` | Repeating fieldset sections (Education 1/2, Work experience), split day/month/year selects, month/date/number with min/max, pattern + maxlength, file upload, radio fieldset, consent checkbox | Phase 3 |
| `fill-lab.html` | Filler edge cases: keyboard-only input (needs typing mode), digits-only input (must fail with a reason), multi-select, date and month inputs, maxlength, rich-text editor, autocomplete suggestions, radio, yes/no checkbox | Phase 4 |
