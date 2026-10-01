/**
 * Turns a résumé file into text in the panel (PLAYBOOK Task 11.1). PDF via
 * pdfjs-dist, DOCX via mammoth, plain text as-is. The file is read on the
 * device and never uploaded anywhere.
 */
import pdfWorkerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';

export const MAX_FILE_BYTES = 5 * 1024 * 1024;

/**
 * Joins PDF text items into lines: a new line on end-of-line marks or a
 * vertical jump, and a blank line where the gap is clearly bigger than a
 * normal line (PDFs drop empty lines, but they separate résumé entries).
 */
export function pdfItemsToText(
  items: ReadonlyArray<{ str: string; hasEOL?: boolean; transform?: number[] }>,
): string {
  let out = '';
  let lastY: number | undefined;
  let lineGap = Infinity;
  for (const item of items) {
    const y = item.transform?.[5];
    if (lastY !== undefined && y !== undefined && Math.abs(y - lastY) > 2) {
      const gap = Math.abs(y - lastY);
      if (!out.endsWith('\n')) out += '\n';
      if (gap > lineGap * 1.6) out += '\n';
      lineGap = Math.min(lineGap, gap);
    }
    out += item.str;
    if (item.hasEOL && !out.endsWith('\n')) out += '\n';
    if (y !== undefined) lastY = y;
  }
  return out;
}

export async function readResumeFile(file: File): Promise<string> {
  if (file.size > MAX_FILE_BYTES)
    throw new Error('That file is larger than 5 MB. Paste the text instead.');
  const name = file.name.toLowerCase();
  if (name.endsWith('.txt') || name.endsWith('.md') || file.type.startsWith('text/'))
    return file.text();
  if (name.endsWith('.pdf') || file.type === 'application/pdf') {
    const pdfjs = await import('pdfjs-dist');
    pdfjs.GlobalWorkerOptions.workerSrc = pdfWorkerUrl;
    const doc = await pdfjs.getDocument({ data: new Uint8Array(await file.arrayBuffer()) }).promise;
    const pages: string[] = [];
    for (let n = 1; n <= Math.min(doc.numPages, 10); n++) {
      const content = await (await doc.getPage(n)).getTextContent();
      pages.push(
        pdfItemsToText(
          content.items as Array<{ str: string; hasEOL?: boolean; transform?: number[] }>,
        ),
      );
    }
    await doc.cleanup();
    return pages.join('\n\n');
  }
  if (name.endsWith('.docx')) {
    const mammoth = (await import('mammoth/mammoth.browser.js')) as unknown as {
      extractRawText(input: { arrayBuffer: ArrayBuffer }): Promise<{ value: string }>;
    };
    // mammoth ends every paragraph with a blank line; an empty paragraph adds one more.
    const raw = (await mammoth.extractRawText({ arrayBuffer: await file.arrayBuffer() })).value;
    return raw.replace(/\n\n/g, '\n');
  }
  throw new Error('Filler reads PDF, Word (.docx) and plain text files.');
}
