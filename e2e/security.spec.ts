import type { BrowserContext, Page } from '@playwright/test';
import { expect, test } from './fixtures';
import { openAndScan, submits } from './agent';

/**
 * PLAYBOOK Task 12.1 (security audit), end to end:
 *  - submit safety against disguised buttons;
 *  - nothing readable at rest (IndexedDB, chrome.storage) after real use;
 *  - what each AI endpoint received across a full session (classify,
 *    generate, extract, vision) never contains personal or private details.
 */

const MOCK = 'http://127.0.0.1:54321';
const PASS = 'correct horse battery staple';

type Agent = {
  listNavigation: () => Array<{ id: string; text: string; submitLike: boolean }>;
  clickNavigation: (id: string) => { ok: boolean; error?: string };
};

test('submit fuzz: every disguised commit button is refused; real navigation is allowed; nothing submits', async ({
  context,
}) => {
  const page = await context.newPage();
  await openAndScan(page, 'submit-fuzz.html');
  const result = await page.evaluate(() => {
    const agent = globalThis.__fillerPageAgent as unknown as Agent;
    const listed = agent.listNavigation();
    // The same buttons, in the same document order, with what the fixture says they are.
    const els = [
      ...document.querySelectorAll(
        'button, input[type="submit"], input[type="button"], input[type="image"], [role="button"], a[role="button"]',
      ),
    ];
    const truth = els.map((el) => (el.hasAttribute('data-commit') ? 'commit' : 'nav'));
    const clicks = listed.map((b) => agent.clickNavigation(b.id).ok);
    return { listed: listed.map((b) => b.submitLike), truth, clicks };
  });
  expect(result.listed).toHaveLength(result.truth.length);
  expect(result.truth.filter((t) => t === 'commit')).toHaveLength(18);
  result.truth.forEach((t, i) => {
    expect(result.listed[i], `button #${i + 1} (${t})`).toBe(t === 'commit');
    expect(result.clicks[i], `click #${i + 1} (${t})`).toBe(t === 'nav');
  });
  expect(await submits(page)).toEqual([]);
});

async function panelWithVault(context: BrowserContext, extensionId: string, fixture: string) {
  const page = await context.newPage();
  await page.goto(`/${fixture}`);
  const panel = await context.newPage();
  await panel.setViewportSize({ width: 360, height: 1400 });
  await panel.goto(`chrome-extension://${extensionId}/sidepanel.html`);
  await panel.getByRole('button', { name: 'Get started' }).click();
  await panel.getByLabel('Passphrase', { exact: true }).fill(PASS);
  await panel.getByLabel('Type it again').fill(PASS);
  await panel.getByLabel('I understand my passphrase cannot be recovered.').check();
  await panel.getByRole('button', { name: 'Create vault' }).click();
  await expect(panel.getByRole('heading', { name: 'A few details to start' })).toBeVisible({
    timeout: 15_000,
  });
  await panel.getByLabel('Full name', { exact: true }).fill('Zubeida Quraishi');
  await panel.getByLabel('City', { exact: true }).fill('Ratnagiri');
  await panel.getByLabel('Mobile number', { exact: true }).fill('+91 97300 55117');
  await panel.getByLabel('Email', { exact: true }).fill('zubeida.q@example.com');
  await panel.getByLabel('Skills', { exact: true }).fill('Tally, GST filing');
  await panel.getByRole('button', { name: 'Save and continue' }).click();
  await expect(panel.getByRole('tab', { name: 'Fill' })).toBeVisible();
  await panel.evaluate((m) => chrome.runtime.sendMessage(m), {
    type: 'FACT_BATCH',
    remove: [],
    set: [
      { key: 'person.dob', value: '1994-08-21' },
      { key: 'address.line1', value: '14 Kolhapur Wadi' },
      { key: 'family.mother_name', value: 'Rukhsana Quraishi' },
      { key: 'custom.medical_note', value: 'Asthmatic since childhood', sensitivity: 'restricted' },
      { key: 'projects[0].name', value: 'Ledger Cleanup' },
    ],
  });
  return { page, panel };
}

const PRIVATE = [
  '97300',
  '55117',
  'zubeida.q@example.com',
  '1994-08-21',
  '21 Aug 1994',
  'Kolhapur Wadi',
  'Rukhsana',
  'Asthmatic',
  'Ratnagiri',
];

test('at rest: no readable personal data in IndexedDB or chrome.storage after real use', async ({
  context,
  extensionId,
}) => {
  const { panel } = await panelWithVault(context, extensionId, 'simple-contact.html');
  await panel.getByRole('button', { name: 'Start on this page' }).click();
  await expect(panel.getByTestId('phase')).toHaveText('Ready for your review');
  const message = panel.getByTestId('question').filter({ hasText: 'Message' });
  await message.getByRole('textbox').fill('Please ring after Maghrib prayers');
  await message.getByRole('button', { name: 'Use this answer' }).click();
  await panel.getByRole('button', { name: /Approve all from vault/ }).click();
  await panel.getByRole('button', { name: /Fill \d+ approved/ }).click();
  await expect(panel.getByTestId('ready')).toBeVisible();

  const dump = await panel.evaluate(async () => {
    const dbs = await indexedDB.databases();
    const out: unknown[] = [];
    for (const info of dbs) {
      const db = await new Promise<IDBDatabase>((res, rej) => {
        const r = indexedDB.open(info.name!);
        r.onsuccess = () => res(r.result);
        r.onerror = () => rej(r.error);
      });
      for (const store of db.objectStoreNames) {
        const rows = await new Promise<unknown[]>((res) => {
          const r = db.transaction(store).objectStore(store).getAll();
          r.onsuccess = () => res(r.result as unknown[]);
        });
        out.push({ db: info.name, store, rows });
      }
      db.close();
    }
    return {
      idb: JSON.stringify(out),
      local: JSON.stringify(await chrome.storage.local.get(null)),
      session: JSON.stringify(await chrome.storage.session.get(null)),
    };
  });
  expect(dump.idb).toContain('ciphertext');
  for (const where of ['idb', 'local', 'session'] as const)
    for (const secret of [...PRIVATE, 'Zubeida', 'Tally', 'Maghrib', PASS])
      expect(dump[where], `${secret} in ${where}`).not.toContain(secret);
  // Key names of custom facts are not stored readably either.
  expect(dump.idb).not.toContain('medical_note');
});

test('AI payload audit: classify, generate, extract and vision never see private details', async () => {
  const { launchDevice } = await import('./fixtures');
  const { context, extensionId } = await launchDevice({ capture: true, realViewport: true });
  await fetch(`${MOCK}/__mock/ai`, {
    method: 'POST',
    body: JSON.stringify({ mode: 'up', limitCalls: 200, clearCache: true }),
  });
  const before = ((await (await fetch(`${MOCK}/__mock/ai`)).json()) as { prompts: string[] })
    .prompts.length;
  const page = await context.newPage();
  await page.goto('http://127.0.0.1:5178/ai-understanding.html');
  const panel = await context.newPage();
  await panel.goto(`chrome-extension://${extensionId}/sidepanel.html`);
  const setup = await panelSetup(panel);
  await setup.signIn();

  // classify (+ generate) on a page full of unknown fields.
  await panel.getByRole('tab', { name: 'Fill' }).click();
  await panel
    .getByLabel('What are we doing? (optional)')
    .fill('Register for Build Weekend as a tax consultant');
  await panel.getByRole('button', { name: 'Start on this page' }).click();
  await expect(panel.getByTestId('phase')).toHaveText('Ready for your review');
  const challenge = panel.getByTestId('question').filter({ hasText: 'Tell us about a challenge' });
  await challenge.getByRole('button', { name: 'Draft with AI' }).click();
  await expect(
    panel.getByTestId('review-row').filter({ hasText: 'Tell us about a challenge' }),
  ).toBeVisible();

  // extract (résumé import with contacts in it).
  await panel.getByRole('tab', { name: 'My details' }).click();
  await panel
    .getByLabel('Or paste text (a résumé, or your LinkedIn About and Experience)')
    .fill(
      'Zubeida Quraishi\nTax Consultant\nzubeida.q@example.com | +91 97300 55117\nDate of birth: 21 Aug 1994\nLocation: Ratnagiri, Maharashtra\n\nExperience\nTax Associate, Konkan Accountants (Jan 2019 – Present)\n- Filed GST returns for 60 shops.',
    );
  await panel.getByRole('button', { name: 'Find my details' }).click();
  await expect(panel.getByTestId('import-review')).toBeVisible();

  // vision (tab snapshot of a page showing the user's details).
  await page.locator('#based').fill('Ratnagiri');
  await panel.getByRole('tab', { name: 'Screen' }).click();
  await panel.getByRole('button', { name: 'Snapshot this tab' }).click();
  await expect(panel.getByTestId('frame-canvas')).toBeVisible();
  await panel.getByRole('button', { name: 'Read with AI' }).click();
  await expect(panel.getByTestId('screen-results')).toBeVisible();

  const prompts = (
    (await (await fetch(`${MOCK}/__mock/ai`)).json()) as { prompts: string[] }
  ).prompts.slice(before);
  const kinds = prompts.map((p) =>
    p.includes('<<<PAGE_DATA')
      ? 'classify'
      : p.includes('<<<DRAFT_DATA')
        ? 'generate'
        : p.includes('<<<RESUME_TEXT')
          ? 'extract'
          : p.includes('<<<SCREEN_DATA')
            ? 'vision'
            : 'other',
  );
  expect(new Set(kinds)).toEqual(new Set(['classify', 'generate', 'extract', 'vision']));
  const all = prompts.join('\n');
  for (const secret of PRIVATE) expect(all, secret).not.toContain(secret);
  // classify carries no vault values at all; generate only the public facts it was allowed.
  const classify = prompts.filter((_, i) => kinds[i] === 'classify').join('\n');
  for (const value of ['Zubeida', 'Tally', 'Ledger Cleanup']) expect(classify).not.toContain(value);
  const generate = prompts.filter((_, i) => kinds[i] === 'generate').join('\n');
  expect(generate).toContain('Ledger Cleanup'); // a public project, ticked by default
  // (Vision only gets pixels and the page title: the typed "Ratnagiri" can only be in the image,
  //  which the user previewed. Hidden areas are covered in screen.spec.ts.)
  await context.close();
});

async function panelSetup(panel: Page) {
  await panel.setViewportSize({ width: 360, height: 1400 });
  await panel.getByRole('button', { name: 'Get started' }).click();
  await panel.getByLabel('Passphrase', { exact: true }).fill(PASS);
  await panel.getByLabel('Type it again').fill(PASS);
  await panel.getByLabel('I understand my passphrase cannot be recovered.').check();
  await panel.getByRole('button', { name: 'Create vault' }).click();
  await expect(panel.getByRole('heading', { name: 'A few details to start' })).toBeVisible({
    timeout: 15_000,
  });
  await panel.getByLabel('Full name', { exact: true }).fill('Zubeida Quraishi');
  await panel.getByLabel('City', { exact: true }).fill('Ratnagiri');
  await panel.getByLabel('Mobile number', { exact: true }).fill('+91 97300 55117');
  await panel.getByLabel('Email', { exact: true }).fill('zubeida.q@example.com');
  await panel.getByLabel('Skills', { exact: true }).fill('Tally, GST filing');
  await panel.getByRole('button', { name: 'Save and continue' }).click();
  await expect(panel.getByRole('tab', { name: 'Fill' })).toBeVisible();
  await panel.evaluate((m) => chrome.runtime.sendMessage(m), {
    type: 'FACT_BATCH',
    remove: [],
    set: [
      { key: 'person.dob', value: '1994-08-21' },
      { key: 'address.line1', value: '14 Kolhapur Wadi' },
      { key: 'family.mother_name', value: 'Rukhsana Quraishi' },
      { key: 'custom.medical_note', value: 'Asthmatic since childhood', sensitivity: 'restricted' },
      { key: 'projects[0].name', value: 'Ledger Cleanup' },
    ],
  });
  return {
    async signIn() {
      const email = `audit-${Math.random().toString(36).slice(2, 8)}@example.com`;
      await panel.getByRole('tab', { name: 'Settings' }).click();
      await panel.getByLabel('Email', { exact: true }).fill(email);
      await panel.getByRole('button', { name: 'Email me a code' }).click();
      await expect(panel.getByText(`We emailed a 6-digit code to ${email}.`)).toBeVisible();
      const { code } = (await (
        await fetch(`${MOCK}/__mock/code?email=${encodeURIComponent(email)}`)
      ).json()) as {
        code: string;
      };
      await panel.getByLabel('Code from the email').fill(code);
      await panel.getByRole('button', { name: 'Sign in' }).click();
      await expect(panel.getByTestId('signed-in-as')).toBeVisible();
    },
  };
}
