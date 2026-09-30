export default defineBackground(() => {
  // Toolbar icon opens the side panel.
  void browser.sidePanel?.setPanelBehavior({ openPanelOnActionClick: true });
});
