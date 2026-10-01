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
import { fail, ok, PanelRequestSchema, type Result } from '../messaging/protocol';
import { host, repos, vault } from './services';

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

export async function handlePanelMessage(raw: unknown): Promise<Result<unknown>> {
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
    case 'NAV_CLICK_REQUEST':
      return clickNavigationTab(request.tabId, request.buttonId);

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
