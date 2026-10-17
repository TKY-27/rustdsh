// Simple / detailed view for the project dashboard.
//
// The simple view (default) keeps what a person needs while working with an
// agent: the current state, what is waiting for them, the agent's screens and
// the results. Every other panel stays in the page and returns with the
// detailed view, so no feature or test hook disappears. The boot script in
// ui.html applies the stored view before paint; this module keeps the toggle
// label, the storage and a few comfort details in sync afterwards.

const VIEW_KEY = "rdsh_dashboard_view";
const INTRO_KEY = "rdsh_dashboard_intro_dismissed";
const root = document.documentElement;
const language = root.lang || "ja";
const pick = (ja, en, zh) =>
  language.startsWith("ja") ? ja : language.startsWith("zh") ? zh : en;

const LABELS = {
  toSimple: pick("かんたん表示", "Simple view", "简洁视图"),
  toFull: pick("くわしく表示", "Detailed view", "详细视图"),
  dismiss: pick("わかった", "Got it", "知道了"),
};
// Panels the simple view opens so their content is visible without a click.
const OPEN_IN_SIMPLE = ["tasks-detail", "progress-detail", "agent-ui-detail"];

function storage(action) {
  try {
    return action(localStorage);
  } catch {
    return null;
  }
}

const currentView = () => (root.dataset.view === "full" ? "full" : "simple");

function renderToggle() {
  const button = document.getElementById("view-toggle");
  if (!button) return;
  const simple = currentView() === "simple";
  button.textContent = simple ? LABELS.toFull : LABELS.toSimple;
  button.setAttribute("aria-pressed", String(!simple));
}

export function setView(view, persist = true) {
  root.dataset.view = view === "full" ? "full" : "simple";
  if (persist) storage((store) => store.setItem(VIEW_KEY, root.dataset.view));
  if (root.dataset.view === "simple")
    for (const id of OPEN_IN_SIMPLE) {
      const panel = document.getElementById(id);
      if (panel) panel.open = true;
    }
  renderToggle();
}

function setupIntro() {
  const card = document.getElementById("first-visit");
  const close = document.getElementById("first-visit-dismiss");
  if (!card || !close) return;
  close.textContent = LABELS.dismiss;
  if (storage((store) => store.getItem(INTRO_KEY)) === "1") card.hidden = true;
  close.addEventListener("click", () => {
    card.hidden = true;
    storage((store) => store.setItem(INTRO_KEY, "1"));
  });
}

document.getElementById("view-toggle")?.addEventListener("click", () => {
  setView(currentView() === "simple" ? "full" : "simple");
  window.scrollTo({ top: 0, behavior: "smooth" });
});
setupIntro();
setView(currentView(), false);
