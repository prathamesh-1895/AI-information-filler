import { expect, test } from './fixtures';
import { fillByLabel, openAndScan, submits } from './agent';

/** PLAYBOOK Tasks 4.1–4.2: every control type on every fixture, with read-back verification. */

test('simple-contact: fills and verifies every field', async ({ context }) => {
  const page = await context.newPage();
  const { byLabel, frame } = await openAndScan(page, 'simple-contact.html');
  const results = await fillByLabel(frame, byLabel, {
    'Full name': 'Priya Sharma',
    'Email address': 'priya@example.com',
    'Mobile number': '+91 98765 43210',
    City: 'Pune',
    Message: 'Hello!\nI would like to know more.',
  });
  for (const r of Object.values(results)) expect(r.status, r.error).toBe('filled');
  await expect(page.locator('#full-name')).toHaveValue('Priya Sharma');
  await expect(page.locator('#message')).toHaveValue('Hello!\nI would like to know more.');
  expect(await submits(page)).toEqual([]);
});

test('react-controlled: values survive a re-render (state received real events)', async ({
  context,
}) => {
  const page = await context.newPage();
  const { byLabel, frame } = await openAndScan(page, 'react-controlled.html');
  const results = await fillByLabel(frame, byLabel, {
    'First name': 'Priya',
    'Last name': 'Sharma',
    Email: 'priya@example.com',
    Country: 'India',
    'Send me the newsletter': 'yes',
  });
  for (const r of Object.values(results)) expect(r.status, r.error).toBe('filled');
  await page.evaluate(() => (window as unknown as { __rerender: () => void }).__rerender());
  expect(await page.evaluate(() => (window as unknown as { __state: unknown }).__state)).toEqual({
    firstName: 'Priya',
    lastName: 'Sharma',
    email: 'priya@example.com',
    country: 'IN',
    newsletter: true,
  });
  await expect(page.locator('[data-fx="email"]')).toHaveValue('priya@example.com');
});

test('google-form-like: ARIA radios, checkboxes, listbox, grid and dates', async ({ context }) => {
  const page = await context.newPage();
  const { byLabel, frame } = await openAndScan(page, 'google-form-like.html');
  const results = await fillByLabel(frame, byLabel, {
    'Full name': 'Priya Sharma',
    'Email address': 'priya@example.com',
    'Which year are you in?': 'Final year',
    'Skills you have': ['Excel', 'Python'],
    'Preferred city': 'Mumbai',
    'Rate yourself: Communication': 'Good',
    'Date of birth': '14/05/2003',
    'Why do you want to be a campus ambassador?': 'I enjoy organising events.',
  });
  for (const [label, r] of Object.entries(results))
    expect(r.status, `${label}: ${r.error}`).toBe('filled');
  const checked = (sel: string) =>
    page
      .locator(`${sel} [aria-checked="true"]`)
      .evaluateAll((els) => els.map((e) => e.getAttribute('aria-label')));
  expect(await checked('[data-fx="year"]')).toEqual(['Final year']);
  expect(await checked('[data-fx="skills"]')).toEqual(['Excel', 'Python']); // SQL was unticked
  expect(await checked('[data-fx="grid-communication"]')).toEqual(['Good']);
  expect(await checked('[data-fx="grid-teamwork"]')).toEqual([]);
  await expect(page.locator('[data-fx="city"] [aria-selected="true"]')).toHaveText('Mumbai');
  await expect(page.locator('[data-fx="dob"]')).toHaveValue('2003-05-14');
  expect(results['Date of birth']!.finalValue).toBe('2003-05-14');
});

test('upwork-profile-like: tags, radios, prefix option match, and no silent truncation', async ({
  context,
}) => {
  const page = await context.newPage();
  const { byLabel, frame } = await openAndScan(page, 'upwork-profile-like.html');
  const results = await fillByLabel(frame, byLabel, {
    'Your professional role': 'Business Consultant for Growing SMBs',
    'Hourly rate': '25',
    Skills: ['Excel', 'SQL', 'Power BI'],
    'Experience level': 'Intermediate',
    'English proficiency': 'Native',
    'Profile overview': 'x'.repeat(5001),
  });
  for (const label of [
    'Your professional role',
    'Hourly rate',
    'Skills',
    'Experience level',
    'English proficiency',
  ]) {
    expect(results[label]!.status, `${label}: ${results[label]!.error}`).toBe('filled');
  }
  await expect(page.locator('.chip')).toHaveText(['Excel', 'SQL', 'Power BI']);
  await expect(page.locator('input[name="level"][value="intermediate"]')).toBeChecked();
  await expect(page.locator('#english')).toHaveValue('native');
  await expect(page.locator('.counter').first()).toContainText('36 / 70');

  expect(results['Profile overview']).toMatchObject({ status: 'failed' });
  expect(results['Profile overview']!.error).toContain(
    '5001 characters but this field allows 5000',
  );
  await expect(page.locator('#overview')).toHaveValue(''); // nothing was cut and pasted in
});

test('fiverr-seller-like: combobox whose options only exist once opened', async ({ context }) => {
  const page = await context.newPage();
  const { byLabel, frame } = await openAndScan(page, 'fiverr-seller-like.html');
  const results = await fillByLabel(frame, byLabel, {
    'Your Occupation': 'Data Analyst',
    'Language Level': 'Fluent',
    Language: 'Hindi',
    'Display Name': 'Priya S.',
  });
  for (const [label, r] of Object.entries(results))
    expect(r.status, `${label}: ${r.error}`).toBe('filled');
  await expect(page.locator('[data-fx="occupation"]')).toHaveText('Data Analyst');
  await expect(page.locator('#occ-list')).toHaveCount(0);

  const disabled = await fillByLabel(frame, byLabel, { Email: 'other@example.com' });
  expect(disabled.Email).toMatchObject({
    status: 'failed',
    error: expect.stringContaining('disabled'),
  });
});

test('job-application-like: split date selects, month input, files refused', async ({
  context,
}) => {
  const page = await context.newPage();
  const { fields, frame } = await openAndScan(page, 'job-application-like.html');
  const pick = (label: string, section?: string) =>
    fields.find((f) => f.label === label && (!section || f.sectionHeading === section))!;
  const items = [
    { f: pick('Day'), value: '2' },
    { f: pick('Month'), value: 'February' },
    { f: pick('Year'), value: '2003' },
    { f: pick('Start', 'Education 1'), value: 'Aug 2022' },
    { f: pick('Institution', 'Education 2'), value: 'Fergusson College' },
    { f: pick('How did you hear about us?'), value: 'College placement cell' },
    { f: pick('Resume / CV'), value: 'cv.pdf' },
  ].map(({ f, value }) => ({ id: f.id, selector: f.selector, signature: f.signature, value }));
  const results = (await frame.evaluate(
    (list) =>
      (globalThis.__fillerPageAgent as unknown as { fill: (l: unknown) => Promise<unknown> }).fill(
        list,
      ),
    items,
  )) as Array<{ status: string; error?: string }>;
  expect(results.slice(0, 6).map((r) => r.status)).toEqual(Array(6).fill('filled'));
  expect(results[6]).toMatchObject({
    status: 'failed',
    error: expect.stringContaining('never attaches files'),
  });
  await expect(page.locator('[name="dob_month"]')).toHaveValue('2');
  await expect(page.locator('#e1-start')).toHaveValue('2022-08');
  await expect(page.locator('#e2-inst')).toHaveValue('Fergusson College');
  await expect(page.locator('#e1-inst')).toHaveValue(''); // the other "Institution" stayed empty
  await expect(page.locator('input[name="source"][value="college"]')).toBeChecked();
});

test('tricky: shadow DOM, editor and iframe fill; denied fields are refused even when asked', async ({
  context,
}) => {
  const page = await context.newPage();
  const { byLabel, frame } = await openAndScan(page, 'tricky.html');
  const results = await fillByLabel(frame, byLabel, {
    'Company name': 'Acme Consulting',
    'Cover letter': 'Dear team,\nI would love to join.',
    State: 'Maharashtra',
    Password: 'hunter2hunter2',
    'Card number': '4111 1111 1111 1111',
    'Passport number': 'Z1234567',
    'Reference code': 'ABC',
  });
  expect(results['Company name']!.status).toBe('filled');
  expect(results['Cover letter']!.status).toBe('filled');
  expect(results.State!.status).toBe('filled');
  for (const label of ['Password', 'Card number', 'Passport number', 'Reference code']) {
    expect(results[label], label).toMatchObject({
      status: 'failed',
      error: expect.stringMatching(/never/i),
    });
  }
  await expect(page.locator('#pw')).toHaveValue('');
  await expect(page.locator('#card')).toHaveValue('');
  await expect(page.locator('#passport')).toHaveValue('');
  expect(
    await page
      .locator('fx-field')
      .evaluate((h) => (h.shadowRoot!.querySelector('input') as HTMLInputElement).value),
  ).toBe('Acme Consulting');

  const child = page.frames().find((f) => f.url().endsWith('tricky-frame.html'))!;
  const inner = await openAndScan(page, 'tricky-frame.html', child);
  const referral = await fillByLabel(inner.frame, inner.byLabel, { 'Referral code': 'FRIEND50' });
  expect(referral['Referral code']!.status).toBe('filled');
  await expect(child.locator('#referral-code')).toHaveValue('FRIEND50');
  expect(await submits(page)).toEqual([]);
});

test('fill-lab: typing fallback, rejected values, multi-select, dates, autocomplete, bad options', async ({
  context,
}) => {
  const page = await context.newPage();
  const { byLabel, frame } = await openAndScan(page, 'fill-lab.html');
  const results = await fillByLabel(frame, byLabel, {
    Nickname: 'Pri',
    'Pin code': '41-10-01',
    'Languages known': ['English', 'Marathi'],
    'Joining date': '1 July 2026',
    'Graduation month': '2026-06-30',
    'Short code': 'TOO-LONG',
    Bio: 'Business analyst.\nLoves spreadsheets.',
    'Current city': 'Pune',
    'Work mode': 'Freelance',
    'You may contact me about openings': 'maybe',
  });
  expect(results.Nickname).toMatchObject({ status: 'filled', method: 'typing' });
  expect(
    await page.evaluate(() => (window as unknown as { __nickModel: () => string }).__nickModel()),
  ).toBe('Pri');

  expect(results['Pin code']).toMatchObject({
    status: 'failed',
    error: expect.stringContaining('did not accept'),
  });
  expect(results['Pin code']!.finalValue).toBe('411001');

  expect(results['Languages known']!.status).toBe('filled');
  expect(
    await page
      .locator('#langs')
      .evaluate((s: HTMLSelectElement) => Array.from(s.selectedOptions, (o) => o.value)),
  ).toEqual(['English', 'Marathi']);

  await expect(page.locator('#join')).toHaveValue('2026-07-01');
  await expect(page.locator('#grad')).toHaveValue('2026-06');

  expect(results['Short code']).toMatchObject({
    status: 'failed',
    error: expect.stringContaining('allows 6'),
  });
  expect(results.Bio!.status).toBe('filled');
  await expect(page.locator('[data-fx="bio"]')).toHaveText(/Loves spreadsheets/);

  expect(results['Current city']!.status).toBe('filled');
  await expect(page.locator('#city')).toHaveAttribute('data-picked', 'Pune');

  expect(results['Work mode']).toMatchObject({ status: 'failed' });
  expect(results['Work mode']!.error).toBe(
    'Option not found: "Freelance". Available: Remote, Hybrid, On-site.',
  );
  expect(results['You may contact me about openings']).toMatchObject({
    status: 'failed',
    error: expect.stringContaining('yes/no'),
  });
  expect(await submits(page)).toEqual([]);
});

test('unknown or stale ids fail with a readable reason, never throw', async ({ context }) => {
  const page = await context.newPage();
  await openAndScan(page, 'simple-contact.html');
  const results = (await page.evaluate(() =>
    (globalThis.__fillerPageAgent as unknown as { fill: (l: unknown) => Promise<unknown> }).fill([
      { id: 'f99999', selector: '#nope', signature: 'a'.repeat(64), value: 'x' },
    ]),
  )) as Array<{ status: string; error: string }>;
  expect(results).toEqual([
    { id: 'f99999', status: 'failed', error: expect.stringContaining('Scan again') },
  ]);
});
