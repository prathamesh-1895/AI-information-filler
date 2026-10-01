import type { BrowserContext, Page } from '@playwright/test';
import { expect, launchDevice, test } from './fixtures';

/**
 * PLAYBOOK Tasks 7.2–7.3 end to end: email-code sign-in and end-to-end
 * encrypted sync between two browser profiles ("devices"), against the local
 * mock Supabase (scripts/mock-supabase.mjs). The mock enforces the same
 * per-user and version rules as the real RLS policies.
 */

const MOCK = 'http://127.0.0.1:54321';
const PASS = 'correct horse battery staple';
const emailFor = (name: string) => `${name}-${Math.random().toString(36).slice(2, 8)}@example.com`;

async function panelFor(context: BrowserContext, extensionId: string): Promise<Page> {
  const page = await context.newPage();
  await page.goto('/simple-contact.html');
  const panel = await context.newPage();
  await panel.setViewportSize({ width: 360, height: 1100 });
  await panel.goto(`chrome-extension://${extensionId}/sidepanel.html`);
  return panel;
}

async function code(email: string): Promise<string> {
  const res = await fetch(`${MOCK}/__mock/code?email=${encodeURIComponent(email)}`);
  return ((await res.json()) as { code: string }).code;
}

async function signIn(panel: Page, email: string) {
  await panel.getByLabel('Email', { exact: true }).fill(email);
  await panel.getByRole('button', { name: 'Email me a code' }).click();
  await expect(panel.getByText(`We emailed a 6-digit code to ${email}.`)).toBeVisible();
  await panel.getByLabel('Code from the email').fill(await code(email));
  await panel.getByRole('button', { name: 'Sign in' }).click();
}

async function createVault(panel: Page, name: string) {
  await panel.getByRole('button', { name: 'Get started' }).click();
  await panel.getByLabel('Passphrase', { exact: true }).fill(PASS);
  await panel.getByLabel('Type it again').fill(PASS);
  await panel.getByLabel('I understand my passphrase cannot be recovered.').check();
  await panel.getByRole('button', { name: 'Create vault' }).click();
  await panel.getByLabel('Full name', { exact: true }).fill(name);
  await panel.getByLabel('City', { exact: true }).fill('Pune');
  await panel.getByRole('button', { name: 'Save and continue' }).click();
}

test('sign in with an email code, sync, and restore on a second device; the server holds only ciphertext', async ({
  context,
  extensionId,
}) => {
  const email = emailFor('priya');
  const laptop = await panelFor(context, extensionId);
  await createVault(laptop, 'Priya Sharma');

  await laptop.getByRole('tab', { name: 'Settings' }).click();
  await expect(laptop.getByTestId('account-card')).toContainText('Sign in to keep your vault');
  // A wrong code is refused with a readable message.
  await laptop.getByLabel('Email', { exact: true }).fill(email);
  await laptop.getByRole('button', { name: 'Email me a code' }).click();
  await laptop.getByLabel('Code from the email').fill('000000');
  await laptop.getByRole('button', { name: 'Sign in' }).click();
  await expect(laptop.getByRole('alert')).toContainText('wrong or has expired');
  await laptop.getByRole('button', { name: 'Change email' }).click();
  await signIn(laptop, email);
  await expect(laptop.getByTestId('signed-in-as')).toHaveText(`Signed in as ${email}`);

  await laptop.getByRole('switch', { name: 'Sync my vault' }).click();
  await laptop.getByRole('button', { name: 'Sync now' }).click();
  await expect(laptop.getByText('Your vault is saved to your account.').first()).toBeVisible();

  // What the "server" stored: one opaque blob. No values, no key names.
  const db = (await (await fetch(`${MOCK}/__mock/db`)).json()) as {
    vault_blobs: Array<Record<string, unknown>>;
  };
  const row = db.vault_blobs.find(
    (r) =>
      r.device_id &&
      JSON.stringify(r).length > 0 &&
      r.version === 1 &&
      typeof r.ciphertext === 'string' &&
      r.ciphertext.length > 100,
  );
  expect(row).toBeDefined();
  const stored = JSON.stringify(db);
  for (const secret of ['Priya', 'Pune', 'person.name.full', 'address.city', PASS])
    expect(stored).not.toContain(secret);

  // Second device: restore from the account with the passphrase.
  const phoneDevice = await launchDevice();
  try {
    const phone = await panelFor(phoneDevice.context, phoneDevice.extensionId);
    await phone
      .getByRole('button', { name: 'I already use Filler: restore from my account' })
      .click();
    await signIn(phone, email);
    await phone.getByLabel('Your vault passphrase').fill('a wrong passphrase');
    await phone.getByRole('button', { name: 'Restore' }).click();
    await expect(phone.getByRole('alert')).toContainText('passphrase is not correct');
    await phone.getByLabel('Your vault passphrase').fill(PASS);
    await phone.getByRole('button', { name: 'Restore' }).click();
    await phone.getByRole('tab', { name: 'My details' }).click();
    await expect(phone.getByTestId('fact-value').filter({ hasText: 'Priya Sharma' })).toBeVisible();

    // Edit on the phone, sync; the laptop picks it up.
    const city = phone.getByTestId('fact-row').filter({ hasText: 'City' });
    await city.getByRole('button', { name: 'Edit City' }).click();
    await city.getByLabel('New value for City').fill('Mumbai');
    await city.getByRole('button', { name: 'Save' }).click();
    await phone.getByRole('tab', { name: 'Settings' }).click();
    await phone.getByRole('button', { name: 'Sync now' }).click();
    await expect(phone.getByText(/saved to your account|Merged/).first()).toBeVisible();

    await laptop.getByRole('button', { name: 'Sync now' }).click();
    await expect(laptop.getByText('Updated this device from your account.').first()).toBeVisible();
    await laptop.getByRole('tab', { name: 'My details' }).click();
    await expect(
      laptop.getByTestId('fact-row').filter({ hasText: 'City' }).getByTestId('fact-value'),
    ).toHaveText('Mumbai');
  } finally {
    await phoneDevice.context.close();
  }
});

test('a second vault made with another passphrase is detected and the user chooses which to keep', async ({
  context,
  extensionId,
}) => {
  const email = emailFor('dual');
  const first = await launchDevice();
  try {
    const a = await panelFor(first.context, first.extensionId);
    await createVault(a, 'Priya Sharma');
    await a.getByRole('tab', { name: 'Settings' }).click();
    await signIn(a, email);
    await a.getByRole('button', { name: 'Sync now' }).click();
    await expect(a.getByText('Your vault is saved to your account.').first()).toBeVisible();
  } finally {
    await first.context.close();
  }

  // This device made its own vault (different passphrase) before signing in.
  const b = await panelFor(context, extensionId);
  await b.getByRole('button', { name: 'Get started' }).click();
  await b.getByLabel('Passphrase', { exact: true }).fill('another long passphrase');
  await b.getByLabel('Type it again').fill('another long passphrase');
  await b.getByLabel('I understand my passphrase cannot be recovered.').check();
  await b.getByRole('button', { name: 'Create vault' }).click();
  await b.getByRole('button', { name: 'Skip for now' }).click();
  await b.getByRole('tab', { name: 'Settings' }).click();
  await signIn(b, email);
  await b.getByRole('button', { name: 'Sync now' }).click();
  await expect(
    b.getByText('Your account has a vault made with a different passphrase.'),
  ).toBeVisible();
  await b.getByLabel('Passphrase of the vault in your account').fill(PASS);
  await b.getByRole('button', { name: 'Use the account’s vault here' }).click();
  await expect(b.getByText('Updated this device from your account.').first()).toBeVisible();
  await b.getByRole('tab', { name: 'My details' }).click();
  await expect(b.getByTestId('fact-value').filter({ hasText: 'Priya Sharma' })).toBeVisible();
});
