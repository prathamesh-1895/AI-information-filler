/**
 * Validates every request from Filler's extension pages and routes it to the
 * tab operations (scan/fill/…) or to the vault and session services.
 */
import {
  VaultExistsError,
  VaultLockedError,
  VaultNotInitializedError,
  VaultValidationError,
  WeakPassphraseError,
  WrongPassphraseError,
} from '@filler/vault';
import {
  clickNavigationTab,
  endSessionTab,
  fillTab,
  getTargetTab,
  highlightTab,
  listNavigationTab,
  observeTab,
  scanTab,
} from '../messaging/background-handler';
import { z } from 'zod';
import { fail, ok, PanelRequestSchema, type Result } from '../messaging/protocol';
import { aiUsageToday, testAiConnection } from '../cloud/ai-ops';
import { captureTab } from '../vision/capture';
import { analyzeImport, saveImport, type ImportDeps } from '../import/ops';
import { explainSessionField, readScreen, type VisionDeps } from '../vision/ops';
import { createPolicy, neverClickByProfile, reusableValues } from '@filler/core';
import { supabase } from '../cloud/supabase';
import {
  ai,
  aiClient,
  auth,
  cloud,
  currentSettings,
  host,
  ready,
  repos,
  updateSettings,
  vault,
} from './services';

function vaultFailure(error: unknown): Result<never> {
  if (error instanceof WrongPassphraseError) return fail('WRONG_PASSPHRASE', error.message);
  if (error instanceof VaultLockedError) return fail('VAULT_LOCKED', error.message);
  if (error instanceof VaultNotInitializedError) return fail('VAULT_MISSING', error.message);
  if (error instanceof VaultExistsError) return fail('VAULT_EXISTS', error.message);
  if (error instanceof WeakPassphraseError || error instanceof VaultValidationError)
    return fail('INVALID', error.message);
  return fail(
    'BAD_REQUEST',
    `Unexpected vault error: ${error instanceof Error ? error.message : String(error)}`,
  );
}

async function vaultCall<T>(fn: () => Promise<T>): Promise<Result<T>> {
  try {
    return ok(await fn());
  } catch (error) {
    return vaultFailure(error);
  }
}

async function cloudCall<T>(fn: () => Promise<T>): Promise<Result<T>> {
  try {
    return ok(await fn());
  } catch (error) {
    if (error instanceof WrongPassphraseError) return fail('WRONG_PASSPHRASE', error.message);
    if (error instanceof z.ZodError)
      return fail('INVALID', error.issues[0]?.message ?? 'Check what you typed.');
    return fail('CLOUD', error instanceof Error ? error.message : String(error));
  }
}

const visionDeps: VisionDeps = {
  aiClient,
  vault,
  repos,
  settings: currentSettings,
  session: (tabId) => host.get(tabId),
};

const importDeps: ImportDeps = { aiClient, vault, repos, settings: currentSettings };

export async function handlePanelMessage(raw: unknown): Promise<Result<unknown>> {
  await ready;
  const parsed = PanelRequestSchema.safeParse(raw);
  if (!parsed.success) return fail('BAD_REQUEST', 'Unknown request.');
  const request = parsed.data;
  switch (request.type) {
    case 'GET_TARGET_TAB':
      return getTargetTab(request.selfTabId);
    case 'SCAN_REQUEST':
      return scanTab(request.tabId);
    case 'FILL_REQUEST':
      return fillTab(request.tabId, request.items);
    case 'HIGHLIGHT_REQUEST':
      return highlightTab(request.tabId, request.items);
    case 'OBSERVE_REQUEST':
      return observeTab(request.tabId);
    case 'END_SESSION_REQUEST':
      return endSessionTab(request.tabId);
    case 'NAV_LIST_REQUEST':
      return listNavigationTab(request.tabId);
    case 'NAV_CLICK_REQUEST': {
      // A platform profile can only add buttons Filler must never click.
      const profile = host.get(request.tabId)?.profile;
      if (profile?.neverClick.length) {
        const buttons = await listNavigationTab(request.tabId);
        const button = buttons.ok
          ? buttons.data.find((b) => b.buttonId === request.buttonId)
          : undefined;
        if (
          !button ||
          neverClickByProfile({ navigation: { neverClick: profile.neverClick } }, button.text)
        )
          return fail(
            'REFUSED',
            `Filler never clicks "${button?.text ?? 'that button'}" on ${profile.name} pages. Click it yourself when you are ready.`,
          );
      }
      return clickNavigationTab(request.tabId, request.buttonId);
    }

    case 'VAULT_STATUS':
      return ok({ status: await vault.status() });
    case 'VAULT_CREATE':
      return vaultCall(async () => {
        await vault.create(request.passphrase);
        await host.broadcast({ type: 'VAULT_UNLOCKED' });
        return { status: 'unlocked' as const };
      });
    case 'VAULT_UNLOCK':
      return vaultCall(async () => {
        await vault.unlock(request.passphrase);
        await host.broadcast({ type: 'VAULT_UNLOCKED' });
        return { status: 'unlocked' as const };
      });
    case 'VAULT_LOCK':
      vault.lock();
      return ok({ status: await vault.status() });
    case 'FACT_SET':
      return vaultCall(() =>
        repos.facts.setValue(
          request.key,
          request.value,
          request.sensitivity ? { sensitivity: request.sensitivity } : {},
        ),
      );
    case 'FACT_DELETE':
      return vaultCall(async () => {
        await repos.facts.delete(request.key);
        return { deleted: request.key };
      });
    case 'FACT_LIST':
      return vaultCall(() => repos.facts.list());
    case 'FACT_BATCH':
      return vaultCall(async () => {
        // Removals first, so moving a list item to a freed index works.
        for (const key of request.remove) await repos.facts.delete(key);
        const saved = [];
        for (const f of request.set) {
          saved.push(
            await repos.facts.setValue(
              f.key,
              f.value,
              f.sensitivity ? { sensitivity: f.sensitivity } : {},
            ),
          );
        }
        return saved;
      });
    case 'VAULT_EXPORT':
      return vaultCall(async () => ({
        json: await vault.exportBackup(),
        filename: `filler-backup-${new Date().toISOString().slice(0, 10)}.filler`,
      }));
    case 'VAULT_IMPORT':
      return vaultCall(async () => {
        await vault.importBackup(request.json, request.passphrase);
        await host.broadcast({ type: 'VAULT_UNLOCKED' });
        return { status: 'unlocked' as const };
      });
    case 'VAULT_WIPE':
      return vaultCall(async () => {
        await vault.wipe();
        return { status: 'uninitialized' as const };
      });
    case 'MEMORY_CLEAR_SITE':
      return vaultCall(async () => ({
        removed: await repos.fieldMemory.deleteBySite(request.site),
      }));
    case 'AUTH_STATUS':
      return ok(await auth.status());
    case 'AUTH_SEND_CODE':
      return cloudCall(async () => {
        await auth.sendCode(request.email);
        return { sent: true };
      });
    case 'AUTH_VERIFY':
      return cloudCall(async () => {
        const status = await auth.verify(request.email, request.code);
        await ai.refreshStatus(true);
        return status;
      });
    case 'AUTH_SIGN_OUT':
      return cloudCall(async () => {
        await auth.signOut();
        await ai.refreshStatus(true);
        return auth.status();
      });
    case 'SYNC_STATUS':
      return ok(await cloud.status());
    case 'SYNC_NOW':
      return cloudCall(() => cloud.syncNow());
    case 'SYNC_USE_CLOUD':
      return cloudCall(async () => {
        const result = await cloud.useCloudCopy(request.passphrase);
        await host.broadcast({ type: 'VAULT_UNLOCKED' });
        return result;
      });
    case 'SYNC_REPLACE_CLOUD':
      return cloudCall(() => cloud.replaceCloudCopy());
    case 'AI_STATUS':
      return ok(await ai.refreshStatus(request.refresh ?? false));
    case 'AI_TEST':
      return ok(await testAiConnection(aiClient, ai));
    case 'AI_USAGE':
      return cloudCall(() => aiUsageToday(supabase(), aiClient));
    case 'VISION_CAPTURE':
      return captureTab(request.tabId, {
        segments: request.segments,
        policy: createPolicy({ extraPatterns: currentSettings().denyPatterns }),
      });
    case 'VISION_READ':
      return readScreen(visionDeps, request.request, request.target);
    case 'VISION_RELABEL':
      if (!host.get(request.tabId))
        return fail('NO_SESSION', 'There is no Filler session on this tab. Start one first.');
      return ok(await host.dispatch(request.tabId, { type: 'RELABEL', labels: request.labels }));
    case 'HISTORY_LIST':
      return vaultCall(() => repos.history.forSite(request.site));
    case 'HISTORY_REUSE':
      return vaultCall(async () => {
        const state = host.get(request.tabId);
        if (!state) throw new Error('There is no Filler session on this tab.');
        const [last] = (await repos.history.forSite(state.site)).filter((h) => h.id !== state.id);
        if (!last) return state;
        const values = reusableValues(state, last);
        if (!Object.keys(values).length) return state;
        return host.dispatch(request.tabId, {
          type: 'REUSE',
          values,
          from: new Date(last.endedAt).toLocaleDateString('en-IN', {
            day: 'numeric',
            month: 'short',
          }),
        });
      });
    case 'IMPORT_ANALYZE':
      return analyzeImport(importDeps, request.text).catch(vaultFailure);
    case 'IMPORT_SAVE':
      return saveImport(importDeps, request).catch(vaultFailure);
    case 'EXPLAIN':
      return explainSessionField(visionDeps, request.tabId, request.fieldId);
    case 'SETTINGS_GET':
      return ok(currentSettings());
    case 'SETTINGS_SET':
      return ok(await updateSettings(request.patch));

    case 'SESSION_START':
      return ok(await host.start(request.tabId, request.goal));
    case 'SESSION_GET':
      return ok(host.get(request.tabId) ?? null);
    case 'SESSION_EVENT':
      if (!host.get(request.tabId))
        return fail('NO_SESSION', 'There is no Filler session on this tab. Start one first.');
      return ok(await host.dispatch(request.tabId, request.event));
  }
}
