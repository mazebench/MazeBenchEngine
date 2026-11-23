let selected = "overview";
export const runTabVisible = name => selected === name && !document.hidden;
export function selectRunTab(name) {
  const button = document.querySelector(`[data-run-tab="${name}"]`);
  if (!button || button.hidden) return;
  selected = name;
  for (const tab of document.querySelectorAll("[data-run-tab]")) {
    const active = tab.dataset.runTab === name;
    tab.setAttribute("aria-selected", String(active)); tab.tabIndex = active ? 0 : -1;
  }
  for (const panel of document.querySelectorAll("[data-run-panel]")) panel.hidden = panel.dataset.runPanel !== name;
  document.dispatchEvent(new CustomEvent("run-tab-change", { detail: name }));
}
for (const button of document.querySelectorAll("[data-run-tab]")) {
  button.addEventListener("click", () => selectRunTab(button.dataset.runTab));
  button.addEventListener("keydown", event => {
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    const tabs = [...document.querySelectorAll("[data-run-tab]")].filter(tab => !tab.hidden);
    const index = tabs.indexOf(button);
    const next = event.key === "Home" ? tabs[0] : event.key === "End" ? tabs.at(-1) : tabs[(index + (event.key === "ArrowRight" ? 1 : -1) + tabs.length) % tabs.length];
    next.focus(); selectRunTab(next.dataset.runTab);
  });
}
