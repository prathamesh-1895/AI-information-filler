# Test fixtures

Local form pages used by automated tests. Tests never touch real third-party sites.

Serve them with `pnpm fixtures` (http://127.0.0.1:5178/).

Every page includes `fixture-harness.js`, which records submit attempts in
`window.__submits` (must stay empty after Filler runs). Each `<name>.html` has a
`<name>.expected.json` listing every field's expected label, kind and canonical key.

| Fixture | Purpose | Added in |
|---|---|---|
| `simple-contact.html` | 5 basic fields, harness smoke test | Phase 0 |
