import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { Page } from '@playwright/test';
import { expect, test } from './fixtures';

/**
 * PLAYBOOK Task 12.2: the ARCHITECTURE §12 targets, measured on the fixtures.
 *  - scan → plan shown for a 20+ field page: < 5 s (offline, and with AI via the local mock);
 *  - AI cost per page: tokens sent to classify for a page of unknown fields.
 * Results go to test-results/metrics.json (copied into PROGRESS.md).
 */

const MOCK = 'http://127.0.0.1:54321';
type Reply<T> = { ok: true; data: T } | { ok: false; error: { message: string } };
const data = async <T>(panel: Page, message: unknown): Promise<T> => {
  const r = (await panel.evaluate((m) => chrome.runtime.sendMessage(m), message)) as Reply<T>;
  if (!r.ok) throw new Error(r.error.message);
  return r.data;
};

test('performance and cost per page', async ({ context, extensionId }) => {
  test.setTimeout(90_000);
  const page = await context.newPage();
  const panel = await context.newPage();
  await panel.goto(`chrome-extension://${extensionId}/sidepanel.html`);
  await data(panel, { type: 'VAULT_CREATE', passphrase: 'correct horse battery staple' });
  for (const [key, value] of Object.entries({
    'person.name.first': 'Priya',
    'person.name.last': 'Sharma',
    'contact.email': 'priya@example.com',
    'contact.phone.mobile': '+91 98765 43210',
    'education[0].institution': 'Pune University',
    'education[0].degree': 'B.Com',
  }))
    await data(panel, { type: 'FACT_SET', key, value });
  const selfTabId = await panel.evaluate(async () => (await chrome.tabs.getCurrent())!.id);

  const rows: Array<Record<string, string | number>> = [];
  for (const fixture of [
    'job-application-like.html',
    'upwork-profile-like.html',
    'college-form-like.html',
    'ai-understanding.html',
  ]) {
    await page.goto(`/${fixture}`);
    await page.bringToFront();
    const { tabId } = await data<{ tabId: number }>(panel, { type: 'GET_TARGET_TAB', selfTabId });
    const times: number[] = [];
    let fields = 0;
    for (let i = 0; i < 5; i++) {
      const t0 = Date.now();
      const s = await data<{ phase: string; fields: unknown[] }>(panel, {
        type: 'SESSION_START',
        tabId,
      });
      times.push(Date.now() - t0);
      fields = s.fields.length;
      expect(s.phase).toBe('AWAITING_REVIEW');
    }
    times.sort((a, b) => a - b);
    rows.push({ fixture, fields, medianMs: times[2]!, worstMs: times[4]! });
    expect(times[4]!).toBeLessThan(5_000);
  }

  // AI on (local mock, real handlers): one classify call for a page of unknown fields.
  const email = `metrics-${Math.random().toString(36).slice(2, 8)}@example.com`;
  await fetch(`${MOCK}/__mock/ai`, {
    method: 'POST',
    body: JSON.stringify({ mode: 'up', clearCache: true }),
  });
  await panel.evaluate(
    (e) => chrome.runtime.sendMessage({ type: 'AUTH_SEND_CODE', email: e }),
    email,
  );
  const { code } = (await (
    await fetch(`${MOCK}/__mock/code?email=${encodeURIComponent(email)}`)
  ).json()) as { code: string };
  await data(panel, { type: 'AUTH_VERIFY', email, code });
  // End the open session first, or navigating would re-scan (and classify) inside it.
  const open = await data<{ tabId: number }>(panel, { type: 'GET_TARGET_TAB', selfTabId });
  await data(panel, { type: 'SESSION_EVENT', tabId: open.tabId, event: { type: 'END' } });
  await page.goto('/ai-understanding.html');
  const before = ((await (await fetch(`${MOCK}/__mock/ai`)).json()) as { prompts: string[] })
    .prompts.length;
  await page.bringToFront();
  const { tabId } = await data<{ tabId: number }>(panel, { type: 'GET_TARGET_TAB', selfTabId });
  const t0 = Date.now();
  const s = await data<{ fields: unknown[]; ai?: { mode: string } }>(panel, {
    type: 'SESSION_START',
    tabId,
  });
  const aiMs = Date.now() - t0;
  expect(s.ai?.mode).toBe('ai');
  const prompts = (
    (await (await fetch(`${MOCK}/__mock/ai`)).json()) as { prompts: string[] }
  ).prompts.slice(before);
  const chars = prompts.join('').length;
  const inputTokens = Math.ceil(chars / 4); // ~4 characters per token for English text
  const outputTokens = 12 * 60; // ~60 tokens per classified field, 12 fields
  rows.push({
    fixture: 'ai-understanding.html (AI on)',
    fields: s.fields.length,
    medianMs: aiMs,
    worstMs: aiMs,
  });
  expect(aiMs).toBeLessThan(5_000);

  const metrics = {
    pages: rows,
    classify: { calls: prompts.length, promptChars: chars, inputTokens, outputTokens },
  };
  console.log(JSON.stringify(metrics, null, 2));
  writeFileSync(
    fileURLToPath(new URL('../test-results/metrics.json', import.meta.url)),
    `${JSON.stringify(metrics, null, 2)}\n`,
  );
  expect(prompts.length).toBe(1); // one batched call per page
});
