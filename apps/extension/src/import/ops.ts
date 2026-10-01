/**
 * Résumé / profile-text import, background side (PLAYBOOK Task 11.1).
 * The file itself never leaves the panel; only its text arrives here.
 * Contact details are found on the device; the AI (when on) gets the text
 * without them. The user reviews every row before anything is saved.
 */
import type { AiClient } from '@filler/ai-client';
import {
  EXTRACT_MAX_TEXT,
  extractLocally,
  mergeCandidates,
  planImport,
  withoutContacts,
  type Candidate,
  type FactValue,
  type ImportRow,
} from '@filler/core';
import type { Repositories, VaultService } from '@filler/vault';
import { fail, ok, type Result } from '../messaging/protocol';
import type { Settings } from '../settings';

export interface ImportAnalysis {
  rows: ImportRow[];
  /** How the text was read: on the device only, or with the AI as well. */
  mode: 'local' | 'ai';
  /** Why the AI was not used (shown to the user). */
  note?: string;
}

export interface ImportDeps {
  aiClient: AiClient;
  vault: VaultService;
  repos: Repositories;
  settings: () => Settings;
  newId?: () => string;
  now?: () => string;
}

export async function analyzeImport(
  deps: ImportDeps,
  text: string,
): Promise<Result<ImportAnalysis>> {
  if (!deps.vault.isUnlocked()) return fail('VAULT_LOCKED', 'Unlock your vault first.');
  const clean = text.replaceAll('\u0000', '').trim();
  if (clean.length < 20)
    return fail('INVALID', 'There is not enough text to read. Paste more, or pick another file.');
  const local = extractLocally(clean);
  let ai: Candidate[] = [];
  let mode: ImportAnalysis['mode'] = 'local';
  let note: string | undefined;
  if (deps.settings().aiAssist) {
    const result = await deps.aiClient.extract({
      text: withoutContacts(clean).slice(0, EXTRACT_MAX_TEXT),
    });
    if (result.ok) {
      ai = result.data.facts.map((f) => ({ ...f, source: 'ai' as const }));
      mode = 'ai';
    } else note = `Read on this device only (${result.message.replace(/\.$/, '')}).`;
  } else note = 'Read on this device only (AI help is turned off).';
  const rows = planImport(mergeCandidates(local, ai), await deps.repos.facts.list());
  return ok({ rows, mode, ...(note ? { note } : {}) });
}

export async function saveImport(
  deps: ImportDeps,
  input: { facts: Array<{ key: string; value: FactValue }>; text: string; fileName: string },
): Promise<Result<{ saved: number }>> {
  if (!deps.vault.isUnlocked()) return fail('VAULT_LOCKED', 'Unlock your vault first.');
  const saved: string[] = [];
  for (const f of input.facts) {
    await deps.repos.facts.setValue(f.key, f.value, { source: 'resume_import' });
    saved.push(f.key);
  }
  // The text (never the file) is kept in the encrypted vault for later imports and drafts.
  await deps.repos.documents.put({
    id: (deps.newId ?? (() => globalThis.crypto.randomUUID()))(),
    type: 'resume',
    name: input.fileName.slice(0, 255) || 'Pasted text',
    text: input.text.slice(0, 200_000),
    parsedFactKeys: saved,
    createdAt: (deps.now ?? (() => new Date().toISOString()))(),
  });
  return ok({ saved: saved.length });
}
