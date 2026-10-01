import { describe, expect, it } from 'vitest';
import { pdfItemsToText } from './read-file';

describe('pdfItemsToText', () => {
  it('rebuilds lines and the blank lines between entries', () => {
    const item = (str: string, y: number, hasEOL = true) => ({
      str,
      hasEOL,
      transform: [1, 0, 0, 1, 50, y],
    });
    expect(
      pdfItemsToText([
        item('Projects', 700),
        item('GST Automation – reports', 688),
        item('Tech: Excel', 676),
        item('Inventory Dashboard', 652),
      ]),
    ).toBe('Projects\nGST Automation – reports\nTech: Excel\n\nInventory Dashboard\n');
  });
});
