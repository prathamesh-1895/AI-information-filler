import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { Page } from '@playwright/test';
import { isDynamicIdentifier } from '@filler/core';
import { expect, test } from './fixtures';
import { agentPath } from './agent';

/**
 * Real scanner output for every fixture, saved to test-fixtures/__scans__/ so
 * the core mapper can be measured in fast unit tests (packages/core
 * mapper.fixtures.test.ts). Run with UPDATE_SCANS=1 to rewrite the snapshots;
 * otherwise this test fails when a snapshot no longer matches the scanner.
 */

const dir = fileURLToPath(new URL('../test-fixtures/__scans__/', import.meta.url));
const update = process.env.UPDATE_SCANS === '1';

interface Case {
  name: string;
  fixture: string;
  prepare?: (page: Page) => Promise<void>;
}

const CASES: Case[] = [
  ...[
    'simple-contact',
    'google-form-like',
    'upwork-profile-like',
    'fiverr-seller-like',
    'react-controlled',
    'tricky',
    'job-application-like',
    'fill-lab',
    'ai-understanding',
    'college-form-like',
  ].map((n) => ({ name: n, fixture: `${n}.html` })),
  {
    name: 'upwork-profile-like.step2',
    fixture: 'upwork-profile-like.html',
    prepare: (page) => page.getByRole('button', { name: 'Next' }).click(),
  },
  {
    name: 'upwork-profile-like.modal',
    fixture: 'upwork-profile-like.html',
    prepare: async (page) => {
      await page.getByRole('button', { name: '+ Add experience' }).click();
      await page.evaluate(() => {
        // Only the modal's fields: hide the step behind it.
        (document.querySelector('[data-step="1"]') as HTMLElement).hidden = true;
      });
    },
  },
];

for (const c of CASES) {
  test(`scan snapshot: ${c.name}`, async ({ context }) => {
    const page = await context.newPage();
    await page.goto(`/${c.fixture}`);
    await c.prepare?.(page);
    const fields = [];
    for (const frame of page.frames()) {
      if (!frame.url().startsWith('http')) continue;
      await frame.addScriptTag({ path: agentPath });
      const scanned = await frame.evaluate(async () => {
        const agent = globalThis.__fillerPageAgent!;
        const { fields } = await agent.scan();
        const out = [];
        for (const f of fields) {
          const ref = (await agent.resolve(f))?.getAttribute('data-fx') ?? null;
          // id and bbox vary between runs/layouts; everything else is stable.
          const { id: _id, bbox: _bbox, ...stable } = f;
          out.push({ ref, ...stable });
        }
        return out;
      });
      // Generated ids (react-controlled re-renders with random ids) differ on every load.
      fields.push(
        ...scanned.map(({ domId, ...f }) =>
          domId && !isDynamicIdentifier(domId) ? { ...f, domId } : f,
        ),
      );
    }
    const file = `${dir}${c.name}.json`;
    if (update || !existsSync(file)) {
      mkdirSync(dir, { recursive: true });
      writeFileSync(file, `${JSON.stringify(fields, null, 2)}\n`);
    }
    expect(fields).toEqual(JSON.parse(readFileSync(file, 'utf8')));
  });
}
