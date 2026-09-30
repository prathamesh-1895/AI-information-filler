import { handlePanelMessage } from '@/src/messaging/background-handler';

export default defineBackground(() => {
  // Toolbar icon opens the side panel.
  void browser.sidePanel?.setPanelBehavior({ openPanelOnActionClick: true });

  browser.runtime.onMessage.addListener((message, sender, sendResponse) => {
    // Only Filler's own extension pages may drive the background (never web pages or page scripts).
    if (sender.id !== browser.runtime.id || !sender.url?.startsWith(browser.runtime.getURL('')))
      return false;
    void handlePanelMessage(message).then(sendResponse);
    return true; // async response
  });
});
