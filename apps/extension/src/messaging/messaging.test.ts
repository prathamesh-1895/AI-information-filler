import { describe, expect, it } from 'vitest';
import { PageScanSchema, PanelRequestSchema, resultSchema, TargetTabSchema } from './protocol';
import { classifyInjectionError, isRestrictedUrl, mergeFrameScans } from './scan-merge';

const field = (id: string, label: string) => ({
  id,
  frameId: 0,
  selector: `#${id}`,
  tag: 'input',
  inputType: 'text',
  label,
  labelSource: 'label-for',
  required: false,
  isVisible: true,
  isDisabled: false,
  signature: 'a'.repeat(64),
});

const frameScan = (url: string, fields: unknown[], errors: string[] = []) => ({
  url,
  title: 'T',
  scannedAt: '2026-10-01T00:00:00.000Z',
  fields,
  errors,
});

describe('protocol schemas', () => {
  it('accepts known requests and rejects unknown ones', () => {
    expect(PanelRequestSchema.safeParse({ type: 'SCAN_REQUEST', tabId: 3 }).success).toBe(true);
    expect(PanelRequestSchema.safeParse({ type: 'GET_TARGET_TAB' }).success).toBe(true);
    expect(PanelRequestSchema.safeParse({ type: 'SCAN_REQUEST' }).success).toBe(false);
    expect(PanelRequestSchema.safeParse({ type: 'SUBMIT_FORM', tabId: 3 }).success).toBe(false);
    expect(PanelRequestSchema.safeParse({ type: 'SCAN_REQUEST', tabId: -1 }).success).toBe(false);
  });

  it('validates ok/error results', () => {
    const schema = resultSchema(TargetTabSchema);
    expect(schema.safeParse({ ok: true, data: { tabId: 1 } }).success).toBe(true);
    expect(schema.safeParse({ ok: false, error: { code: 'NO_TAB', message: 'x' } }).success).toBe(
      true,
    );
    expect(schema.safeParse({ ok: false, error: { code: 'WHATEVER', message: 'x' } }).success).toBe(
      false,
    );
    expect(schema.safeParse({ ok: true, data: { tabId: 'x' } }).success).toBe(false);
  });
});

describe('mergeFrameScans', () => {
  it('prefixes ids with the frame, sets frameId and keeps the top frame first', () => {
    const merged = mergeFrameScans(7, [
      { frameId: 12, result: frameScan('https://x.test/frame', [field('f0', 'Referral code')]) },
      {
        frameId: 0,
        result: frameScan('https://x.test/', [field('f0', 'Name'), field('f1', 'Email')]),
      },
    ]);
    expect(merged).not.toBeNull();
    expect(PageScanSchema.parse(merged)).toEqual(merged);
    expect(merged!.url).toBe('https://x.test/');
    expect(merged!.frames).toBe(2);
    expect(merged!.fields.map((f) => [f.id, f.frameId, f.label])).toEqual([
      ['0:f0', 0, 'Name'],
      ['0:f1', 0, 'Email'],
      ['12:f0', 12, 'Referral code'],
    ]);
  });

  it('skips frames without an agent and reports invalid results', () => {
    const merged = mergeFrameScans(1, [
      {
        frameId: 0,
        result: frameScan('https://x.test/', [field('f0', 'Name')], ['one field skipped']),
      },
      { frameId: 3, result: null },
      { frameId: 4, result: { bogus: true } },
    ]);
    expect(merged!.fields).toHaveLength(1);
    expect(merged!.errors).toEqual([
      expect.stringContaining('frame 4: invalid'),
      'frame 0: one field skipped',
    ]);
  });

  it('returns null when no frame produced a result', () => {
    expect(mergeFrameScans(1, [{ frameId: 0, result: null }])).toBeNull();
  });
});

describe('errors and restricted pages', () => {
  it.each([
    'chrome://settings',
    'chrome-extension://abc/page.html',
    'about:blank',
    'https://chromewebstore.google.com/detail/x',
    'edge://extensions',
  ])('%s is restricted', (url) => expect(isRestrictedUrl(url)).toBe(true));

  it.each(['https://www.upwork.com/nx/create-profile', 'http://127.0.0.1:5178/x.html', undefined])(
    '%s is not restricted',
    (url) => expect(isRestrictedUrl(url)).toBe(false),
  );

  it.each([
    ['Cannot access a chrome:// URL', 'RESTRICTED_PAGE'],
    ['The extensions gallery cannot be scripted.', 'RESTRICTED_PAGE'],
    [
      'Cannot access contents of url "about:blank". Extension manifest must request permission to access this host.',
      'RESTRICTED_PAGE',
    ],
    [
      'Cannot access contents of url "https://www.upwork.com/x". Extension manifest must request permission to access this host.',
      'NO_PERMISSION',
    ],
    [
      'Cannot access contents of the page. Extension manifest must request permission to access the respective host.',
      'NO_PERMISSION',
    ],
    ['No tab with id: 55.', 'NO_TAB'],
    ['Something odd', 'INJECTION_FAILED'],
  ])('%s → %s', (message, code) =>
    expect(classifyInjectionError(new Error(message)).code).toBe(code),
  );
});

describe('Phase 4 messages', () => {
  const sig = 'b'.repeat(64);

  it('groups fill items by frame and swaps in frame-local ids', async () => {
    const { groupByFrame } = await import('./scan-merge');
    const groups = groupByFrame([
      { fieldId: '0:f1', value: 'a' },
      { fieldId: '12:f0', value: 'b' },
      { fieldId: '0:f7', value: 'c' },
    ]);
    expect([...groups.keys()]).toEqual([0, 12]);
    expect(groups.get(0)).toEqual([
      { id: 'f1', value: 'a' },
      { id: 'f7', value: 'c' },
    ]);
    expect(groups.get(12)).toEqual([{ id: 'f0', value: 'b' }]);
  });

  it('validates fill, highlight and navigation requests', async () => {
    const { PanelRequestSchema, splitId, joinId } = await import('./protocol');
    const fill = {
      type: 'FILL_REQUEST',
      tabId: 1,
      items: [{ fieldId: '0:f1', selector: '#a', signature: sig, value: ['x', 'y'] }],
    };
    expect(PanelRequestSchema.safeParse(fill).success).toBe(true);
    expect(PanelRequestSchema.safeParse({ ...fill, items: [] }).success).toBe(false);
    expect(
      PanelRequestSchema.safeParse({ ...fill, items: [{ ...fill.items[0], fieldId: 'f1' }] })
        .success,
    ).toBe(false);
    expect(
      PanelRequestSchema.safeParse({ ...fill, items: [{ ...fill.items[0], signature: 'nope' }] })
        .success,
    ).toBe(false);
    expect(
      PanelRequestSchema.safeParse({
        type: 'HIGHLIGHT_REQUEST',
        tabId: 1,
        items: [{ fieldId: '3:f2', state: 'vault' }],
      }).success,
    ).toBe(true);
    expect(
      PanelRequestSchema.safeParse({
        type: 'HIGHLIGHT_REQUEST',
        tabId: 1,
        items: [{ fieldId: '3:f2', state: 'purple' }],
      }).success,
    ).toBe(false);
    expect(
      PanelRequestSchema.safeParse({ type: 'NAV_CLICK_REQUEST', tabId: 1, buttonId: '0:b4' })
        .success,
    ).toBe(true);
    expect(
      PanelRequestSchema.safeParse({ type: 'NAV_CLICK_REQUEST', tabId: 1, buttonId: '0:f4' })
        .success,
    ).toBe(false);
    expect(splitId('12:f0')).toEqual({ frameId: 12, localId: 'f0' });
    expect(joinId(3, 'b1')).toBe('3:b1');
  });

  it('validates page events', async () => {
    const { PageEventSchema } = await import('./protocol');
    expect(PageEventSchema.safeParse({ type: 'FIELD_FOCUSED', id: 'f2' }).success).toBe(true);
    expect(
      PageEventSchema.safeParse({
        type: 'FIELDS_CHANGED',
        reason: 'mutation',
        url: 'https://x.test',
        added: [],
        removed: ['f1'],
      }).success,
    ).toBe(true);
    expect(
      PageEventSchema.safeParse({
        type: 'FIELDS_CHANGED',
        reason: 'reload',
        url: 'x',
        added: [],
        removed: [],
      }).success,
    ).toBe(false);
  });
});
