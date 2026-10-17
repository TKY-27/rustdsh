// The project dashboard opens in its simple view by default and keeps the
// advanced panels for the detailed view. These suites exercise those panels,
// so every context they create starts in the detailed view. The simple view
// itself is covered by dashboard/test/ui-view-mode.test.mjs.
export function detailedView(browser) {
  const newContext = browser.newContext.bind(browser);
  browser.newContext = async (...args) => {
    const context = await newContext(...args);
    await context.addInitScript(() => {
      try {
        localStorage.setItem("rdsh_dashboard_view", "full");
      } catch {}
    });
    return context;
  };
  return browser;
}
