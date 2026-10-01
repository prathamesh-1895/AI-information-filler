import { PageEventSchema } from '@/src/messaging/protocol';
import { handlePanelMessage } from '@/src/session/router';
import { host } from '@/src/session/services';

export default defineBackground(() => {
  // Toolbar icon opens the side panel.
  void browser.sidePanel?.setPanelBehavior({ openPanelOnActionClick: true });

  const extensionOrigin = browser.runtime.getURL('');

  browser.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (sender.id !== browser.runtime.id) return false;

    // Filler's own extension pages (the side panel) drive everything.
    if (sender.url?.startsWith(extensionOrigin) && !sender.tab?.url?.startsWith('http')) {
      void handlePanelMessage(message).then(sendResponse);
      return true; // async response
    }

    // Page agents (isolated world of a web page) may only *report* page changes.
    // They can never request scans, fills or vault access.
    const tabId = sender.tab?.id;
    if (tabId === undefined || !host.get(tabId)) return false;
    const parsed = PageEventSchema.safeParse(message);
    if (parsed.success && parsed.data.type === 'FIELDS_CHANGED') {
      const frameId = sender.frameId ?? 0;
      const event = parsed.data;
      void host.dispatch(tabId, {
        type: 'FIELDS_CHANGED',
        url: event.url,
        added: event.added.map((f) => ({ ...f, id: `${frameId}:${f.id}`, frameId })),
        removed: event.removed.map((id) => `${frameId}:${id}`),
        at: new Date().toISOString(),
      });
    }
    return false;
  });

  // The side panel holds a port open while it is visible; an open port keeps
  // this worker (and the in-memory session state) alive.
  browser.runtime.onConnect.addListener((port) => {
    if (port.name !== 'panel' || port.sender?.id !== browser.runtime.id) port.disconnect();
  });

  // Keyboard shortcut (PLAYBOOK Task 6.5): open the panel and start on this tab.
  browser.commands.onCommand.addListener((command, tab) => {
    if (command !== 'start-session' || tab?.id === undefined) return;
    const tabId = tab.id;
    // sidePanel.open must run inside the shortcut's user gesture, before any await.
    void browser.sidePanel.open({ tabId }).catch(() => undefined);
    void host.start(tabId);
  });

  browser.tabs.onRemoved.addListener((tabId) => {
    if (!host.get(tabId)) return;
    void host.dispatch(tabId, { type: 'TAB_CLOSED' }).then(() => host.forget(tabId));
  });

  // A full page load ends the page agent; rescan on the same site, end the session elsewhere.
  browser.tabs.onUpdated.addListener((tabId, change, tab) => {
    const session = host.get(tabId);
    if (
      !session ||
      change.status !== 'complete' ||
      session.phase === 'ENDED' ||
      session.phase === 'SCANNING'
    )
      return;
    void host.dispatch(tabId, {
      type: 'NAVIGATED',
      url: tab.url ?? session.url,
      at: new Date().toISOString(),
    });
  });
});
