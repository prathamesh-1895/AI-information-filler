/**
 * Background-worker singletons: the encrypted vault, its repositories and the
 * session host. Only the background worker imports this module, so decrypted
 * values never live in any other extension context except the panel showing them.
 */
import { createRepositories, VaultService } from '@filler/vault';
import {
  endSessionTab,
  fillTab,
  highlightTab,
  observeTab,
  scanTab,
} from '../messaging/background-handler';
import type { SessionStateMessage } from '../messaging/protocol';
import { SessionHost } from './host';

export const vault = new VaultService();
export const repos = createRepositories(vault);

export const host = new SessionHost({
  vault,
  repos,
  scanTab,
  fillTab,
  highlightTab,
  observeTab,
  endTab: endSessionTab,
  publish(tabId, state) {
    const message: SessionStateMessage = { type: 'SESSION_STATE', tabId, state };
    // Only extension pages (the panel) receive runtime messages from the background.
    void browser.runtime.sendMessage(message).catch(() => undefined);
  },
});

vault.onLock(() => void host.broadcast({ type: 'VAULT_LOCKED' }));
