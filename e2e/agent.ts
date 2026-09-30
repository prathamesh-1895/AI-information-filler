import { fileURLToPath } from 'node:url';
import type { Frame, Page } from '@playwright/test';
import type { FieldDescriptor } from '@filler/core';

/** Helpers that drive the built page agent directly inside fixture pages. */

export const agentPath = fileURLToPath(
  new URL('../apps/extension/.output-e2e/chrome-mv3/page-agent.js', import.meta.url),
);

export interface FillResult {
  id: string;
  status: 'filled' | 'failed';
  finalValue?: string | string[];
  error?: string;
  method?: string;
}

/** Loads a fixture, injects the agent and scans; returns fields keyed by label. */
export async function openAndScan(page: Page, fixture: string, frame?: Frame) {
  if (!frame) await page.goto(`/${fixture}`);
  const target = frame ?? page.mainFrame();
  await target.addScriptTag({ path: agentPath });
  const { fields } = await target.evaluate(() => globalThis.__fillerPageAgent!.scan());
  const byLabel = (label: string): FieldDescriptor => {
    const found = fields.filter((f) => f.label === label);
    if (found.length !== 1)
      throw new Error(`Expected one field labelled "${label}", found ${found.length}`);
    return found[0]!;
  };
  return { fields, byLabel, frame: target };
}

/** Fills `label → value` pairs through the agent; returns results keyed by label. */
export async function fillByLabel(
  frame: Frame,
  byLabel: (label: string) => FieldDescriptor,
  values: Record<string, string | string[]>,
  mode?: 'auto' | 'typing',
): Promise<Record<string, FillResult>> {
  const items = Object.entries(values).map(([label, value]) => {
    const f = byLabel(label);
    return {
      id: f.id,
      selector: f.selector,
      signature: f.signature,
      value,
      ...(mode ? { mode } : {}),
    };
  });
  const results = (await frame.evaluate(
    (list) =>
      (globalThis.__fillerPageAgent as unknown as { fill: (l: unknown) => Promise<unknown> }).fill(
        list,
      ),
    items,
  )) as FillResult[];
  const labels = Object.keys(values);
  return Object.fromEntries(results.map((r, i) => [labels[i]!, r]));
}

export const submits = (page: Page) =>
  page.evaluate(() => (window as unknown as { __submits: unknown[] }).__submits);
