// Writes test-fixtures/resumes/asha-verma.pdf and .docx from asha-verma.txt
// (synthetic data), so e2e can exercise the real PDF and Word readers.
//   node scripts/make-resume-files.mjs
import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const dir = join(root, 'test-fixtures', 'resumes');
const lines = readFileSync(join(dir, 'asha-verma.txt'), 'utf8').replace(/\r/g, '').split('\n');

// ---- PDF: one page, Helvetica (WinAnsi), one text line per résumé line.
const WIN_ANSI = {
  '–': '\\226',
  '—': '\\227',
  '’': '\\222',
  '“': '\\223',
  '”': '\\224',
  '•': '\\225',
};
const pdfText = (s) =>
  s.replace(/[\\()]/g, (c) => `\\${c}`).replace(/[–—’“”•]/g, (c) => WIN_ANSI[c]);
let y = 800;
const ops = ['BT', '/F1 9 Tf', '12 TL', `50 ${y} Td`];
for (const line of lines) {
  ops.push(`(${pdfText(line)}) Tj T*`);
  y -= 12;
}
ops.push('ET');
const stream = ops.join('\n');
const objects = [
  '<< /Type /Catalog /Pages 2 0 R >>',
  '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
  '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>',
  `<< /Length ${Buffer.byteLength(stream, 'latin1')} >>\nstream\n${stream}\nendstream`,
  '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>',
];
let pdf = '%PDF-1.4\n';
const offsets = [];
objects.forEach((body, i) => {
  offsets.push(Buffer.byteLength(pdf, 'latin1'));
  pdf += `${i + 1} 0 obj\n${body}\nendobj\n`;
});
const xref = Buffer.byteLength(pdf, 'latin1');
pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
for (const off of offsets) pdf += `${String(off).padStart(10, '0')} 00000 n \n`;
pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
writeFileSync(join(dir, 'asha-verma.pdf'), Buffer.from(pdf, 'latin1'));

// ---- DOCX: the smallest valid package (content types, relationships, document).
const require = createRequire(join(root, 'apps', 'extension', 'package.json'));
const JSZip = require('jszip');
const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const zip = new JSZip();
zip.file(
  '[Content_Types].xml',
  '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
);
zip.file(
  '_rels/.rels',
  '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>',
);
zip.file(
  'word/document.xml',
  `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${lines
    .map((l) => `<w:p><w:r><w:t xml:space="preserve">${esc(l)}</w:t></w:r></w:p>`)
    .join('')}</w:body></w:document>`,
);
writeFileSync(join(dir, 'asha-verma.docx'), await zip.generateAsync({ type: 'nodebuffer' }));
console.log('Wrote asha-verma.pdf and asha-verma.docx');
