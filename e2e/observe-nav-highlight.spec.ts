import type { Page } from '@playwright/test';
import { expect, test } from './fixtures';
import { openAndScan, submits } from './agent';

/** PLAYBOOK Tasks 4.3 (observer, wizard navigation) and 4.4 (highlighter). */

interface Change {
  reason: string;
  url: string;
  added: Array<{ id: string; label: string }>;
  removed: string[];
}

async function startObserving(page: Page) {
  await page.evaluate(() => {
    const w = window as unknown as { __changes: unknown[] };
    w.__changes = [];
    globalThis.__fillerPageAgent!.observe((c) => w.__changes.push(c));
  });
}

const changes = (page: Page) =>
  page.evaluate(() => (window as unknown as { __changes: Change[] }).__changes);

type Agent = {
  listNavigation: () => Array<{ id: string; text: string; submitLike: boolean }>;
  clickNavigation: (id: string) => { ok: boolean; error?: string };
};

async function navButtons(page: Page) {
  return page.evaluate(() => (globalThis.__fillerPageAgent as unknown as Agent).listNavigation());
}

async function clickNav(page: Page, text: string) {
  const buttons = await navButtons(page);
  const button = buttons.find((b) => b.text === text);
  if (!button) throw new Error(`No button "${text}" in ${JSON.stringify(buttons)}`);
  return page.evaluate(
    (id) => (globalThis.__fillerPageAgent as unknown as Agent).clickNavigation(id),
    button.id,
  );
}

test('observer: next wizard step reports only the new fields and the ones that went away', async ({
  context,
}) => {
  const page = await context.newPage();
  const { fields } = await openAndScan(page, 'upwork-profile-like.html');
  await startObserving(page);
  expect(await clickNav(page, 'Next')).toEqual({ ok: true });
  await expect.poll(async () => (await changes(page)).length).toBeGreaterThan(0);
  await page.waitForTimeout(400); // let any trailing debounce settle
  const all = await changes(page);
  expect(all).toHaveLength(1);
  expect(all[0]!.reason).toBe('mutation');
  expect(all[0]!.added.map((f) => f.label)).toEqual([
    'Street address',
    'City',
    'ZIP/Postal code',
    'Phone',
  ]);
  expect(all[0]!.removed.sort()).toEqual(fields.map((f) => f.id).sort());
});

test('observer: an "Add experience" modal reports its fields; overlay changes are ignored', async ({
  context,
}) => {
  const page = await context.newPage();
  const { fields } = await openAndScan(page, 'upwork-profile-like.html');
  await startObserving(page);
  // The highlighter adds/removes its own overlay; that must not count as a page change.
  await page.evaluate(
    (ids) => globalThis.__fillerPageAgent!.highlight(ids.map((id) => ({ id, state: 'input' }))),
    fields.map((f) => f.id),
  );
  await page.waitForTimeout(500);
  expect(await changes(page)).toEqual([]);

  expect(await clickNav(page, '+ Add experience')).toEqual({ ok: true });
  await expect
    .poll(async () => (await changes(page)).flatMap((c) => c.added.map((f) => f.label)))
    .toEqual(['Company', 'Title', 'Description']);
  expect((await changes(page)).flatMap((c) => c.removed)).toEqual([]);
});

test('observer: single-page-app navigation is reported with the new URL', async ({ context }) => {
  const page = await context.newPage();
  await openAndScan(page, 'simple-contact.html');
  await startObserving(page);
  await page.evaluate(() => {
    history.pushState({}, '', '/simple-contact.html#step-2');
    document.querySelector('#contact')!.innerHTML =
      '<label for="q">Company website</label><input id="q" type="url">';
  });
  await expect
    .poll(async () =>
      (await changes(page)).some((c) => c.reason === 'navigation' || c.url.endsWith('#step-2')),
    )
    .toBe(true);
  const added = (await changes(page)).flatMap((c) => c.added.map((f) => f.label));
  expect(added).toEqual(['Company website']);
  await page.evaluate(() => globalThis.__fillerPageAgent!.stopObserving());
});

test('navigation: Next is allowed, Submit is refused in code, and nothing is ever submitted', async ({
  context,
}) => {
  const page = await context.newPage();
  await openAndScan(page, 'upwork-profile-like.html');
  const first = await navButtons(page);
  expect(first.map((b) => [b.text, b.submitLike])).toEqual([
    ['+ Add experience', false],
    ['Next', false],
  ]);
  expect(await clickNav(page, 'Next')).toEqual({ ok: true });
  await expect(page.locator('[data-step="2"]')).toBeVisible();
  expect(await clickNav(page, 'Next')).toEqual({ ok: true });
  await expect(page.locator('[data-step="3"]')).toBeVisible();

  const last = await navButtons(page);
  expect(last.map((b) => [b.text, b.submitLike])).toEqual([
    ['Back', false],
    ['Submit profile', true],
  ]);
  const refused = await clickNav(page, 'Submit profile');
  expect(refused.ok).toBe(false);
  expect(refused.error).toContain('never clicks "Submit profile"');
  expect(await submits(page)).toEqual([]);
});

test('navigation: a button that turns into Submit after listing is still refused', async ({
  context,
}) => {
  const page = await context.newPage();
  await openAndScan(page, 'upwork-profile-like.html');
  const next = (await navButtons(page)).find((b) => b.text === 'Next')!;
  await page.evaluate(() => {
    document.querySelector('[data-step="1"] .next')!.textContent = 'Submit';
  });
  const result = await page.evaluate(
    (id) => (globalThis.__fillerPageAgent as unknown as Agent).clickNavigation(id),
    next.id,
  );
  expect(result.ok).toBe(false);
  await expect(page.locator('[data-step="1"]')).toBeVisible();
});

test('highlighter: outlines fields by state, never blocks the page, reports focus, cleans up', async ({
  context,
}) => {
  const page = await context.newPage();
  const { byLabel } = await openAndScan(page, 'simple-contact.html');
  const states = {
    'Full name': 'vault',
    'Email address': 'ai',
    'Mobile number': 'input',
    City: 'filled',
    Message: 'denied',
  } as const;
  await page.evaluate(() => {
    (window as unknown as { __focused: string[] }).__focused = [];
  });
  const result = await page.evaluate(
    (items) =>
      globalThis.__fillerPageAgent!.highlight(items, (e) =>
        (window as unknown as { __focused: string[] }).__focused.push(e.id),
      ),
    Object.entries(states).map(([label, state]) => ({
      id: byLabel(label).id,
      state,
      title: `Source for ${label}`,
      preview: 'pr••••@example.com',
    })),
  );
  expect(result).toEqual({ shown: 5, missing: [] });

  const boxes = await page.evaluate(() => {
    const host = document.querySelector('[data-filler-overlay]')!;
    return Array.from(host.shadowRoot!.querySelectorAll('.box')).map((b) => {
      const r = b.getBoundingClientRect();
      return {
        cls: b.className,
        badge: b.textContent,
        pe: getComputedStyle(b).pointerEvents,
        x: r.x,
        y: r.y,
        w: r.width,
        h: r.height,
      };
    });
  });
  expect(boxes.map((b) => b.badge)).toEqual([
    'Vault',
    'AI draft',
    'Needs you',
    '✓ Filled',
    'Never filled',
  ]);
  expect(boxes.every((b) => b.pe === 'none')).toBe(true);
  const email = await page.locator('#email').boundingBox();
  const emailBox = boxes[1]!;
  expect(emailBox.x).toBeLessThanOrEqual(email!.x);
  expect(emailBox.x + emailBox.w).toBeGreaterThanOrEqual(email!.x + email!.width);

  // Clicking through the overlay reaches the real input and reports which field it was.
  await page.locator('#email').click();
  expect(await page.evaluate(() => document.activeElement?.id)).toBe('email');
  expect(
    await page.evaluate(() => (window as unknown as { __focused: string[] }).__focused),
  ).toContain(byLabel('Email address').id);

  // Hover shows the tooltip with the (already masked) preview.
  await page.locator('#email').hover();
  await expect
    .poll(() =>
      page.evaluate(() => {
        const tip = document
          .querySelector('[data-filler-overlay]')!
          .shadowRoot!.querySelector('.tip') as HTMLElement;
        return tip.hidden ? '' : tip.textContent;
      }),
    )
    .toBe('Source for Email addresspr••••@example.com');

  // Boxes follow the page when it scrolls.
  await page.setViewportSize({ width: 800, height: 300 });
  await page.evaluate(() => window.scrollTo(0, 120));
  await page.waitForTimeout(100);
  const after = await page.evaluate(
    () =>
      document
        .querySelector('[data-filler-overlay]')!
        .shadowRoot!.querySelectorAll('.box')[1]!
        .getBoundingClientRect().y,
  );
  const inputY = (await page.locator('#email').boundingBox())!.y;
  expect(Math.abs(after - (inputY - 3))).toBeLessThanOrEqual(2);

  // The overlay is never mistaken for form fields.
  expect((await page.evaluate(() => globalThis.__fillerPageAgent!.scan())).fields).toHaveLength(5);

  await page.evaluate(() => globalThis.__fillerPageAgent!.clearHighlights());
  await expect(page.locator('[data-filler-overlay]')).toHaveCount(0);
});
