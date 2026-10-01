// Writes test-fixtures/__ai__/vision/<fixture>.json: scripted vision-model
// replies for each fixture page, used by the function tests and the e2e mock
// (tests never call a live provider). They are written in the model's output
// format from each fixture's .expected.json, with the imperfections a real
// model shows: changed casing and punctuation, asterisks kept, and one field
// missed on longer forms. Boxes are a simple column layout (labels matter for
// the measurement; the canvas fixture has exact hand-measured boxes).
// Not live recordings: replace with real ones after checkpoint B.
//
//   node scripts/make-vision-recordings.mjs
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', 'test-fixtures');
const out = join(root, '__ai__', 'vision');
mkdirSync(out, { recursive: true });

const titleOf = (html) => /<title>([^<]*)<\/title>/i.exec(html)?.[1]?.trim() ?? '';
const noisy = (label, i) => {
  if (i % 4 === 1) return label.replace(/\b\w/g, (c) => c.toUpperCase()); // Title Case
  if (i % 4 === 2) return `${label} *`; // required marker kept
  if (i % 4 === 3) return label.replace(/[?:]$/, ''); // punctuation dropped
  return label;
};

for (const file of readdirSync(root).filter((f) => f.endsWith('.expected.json'))) {
  const expected = JSON.parse(readFileSync(join(root, file), 'utf8'));
  const name = file.replace('.expected.json', '');
  const title = titleOf(readFileSync(join(root, `${name}.html`), 'utf8'));
  const fields = expected.fields.filter((f) => f.label);
  // A real model misses things: drop the 7th field on longer forms.
  const seen = fields.length > 8 ? fields.filter((_, i) => i !== 6) : fields;
  const response = {
    formPurpose: title,
    warnings: [],
    fields: seen.map((f, i) => ({
      id: `f${i + 1}`,
      label: noisy(f.label, i),
      kind: f.kind,
      bbox: { x: 40, y: 60 + i * 56, width: 400, height: 36 },
      ...(f.options?.length ? { options: f.options } : {}),
      ...(f.canonicalKey && f.kind !== 'denied'
        ? { canonicalKey: f.canonicalKey.replace(/\[\d+\]/, '[]') }
        : {}),
    })),
  };
  writeFileSync(join(out, `${name}.json`), `${JSON.stringify({ title, response }, null, 2)}\n`);
}

// The canvas form: boxes measured from test-fixtures/canvas-form.html (input box at y + 8).
const canvasRows = [
  ['Full name', 100, 'fact', 'person.name.full'],
  ['Email address', 190, 'fact', 'contact.email'],
  ['City', 280, 'fact', 'address.city'],
  ['Password', 370, 'denied'],
  ['Why do you want to attend?', 460, 'open_ended'],
];
writeFileSync(
  join(out, 'canvas-form.json'),
  `${JSON.stringify(
    {
      title: 'Canvas registration form',
      response: {
        formPurpose: 'Event registration',
        warnings: [],
        fields: canvasRows.map(([label, y, kind, key], i) => ({
          id: `f${i + 1}`,
          label,
          kind,
          bbox: { x: 40, y: y + 8, width: 400, height: 36 },
          ...(key ? { canonicalKey: key } : {}),
          hint:
            kind === 'denied' ? 'A password for the account' : `Asks for ${label.toLowerCase()}`,
        })),
      },
    },
    null,
    2,
  )}\n`,
);
console.log(`Wrote vision recordings to ${out}`);
