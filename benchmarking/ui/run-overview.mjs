// Reuse the existing chart elements without changing the historical page shell.
export function createOverviewCharts(elements) {
  const charts = document.createElement("div");
  charts.className = "overview-insights";
  const status = document.createElement("p");
  status.className = "section-status overview-chart-status";
  status.id = "overview-chart-status";
  status.setAttribute("role", "status");
  status.hidden = true;

  const heatmap = elements.heatmap.closest(".heatmap-panel");
  const novelty = elements["novelty-chart"].closest(".novelty-panel");
  heatmap.querySelector(".panel-heading strong").textContent = "Visit heatmap";
  novelty.querySelector(".panel-heading strong").textContent = "Novelty";

  const heatmapFooter = document.createElement("div");
  heatmapFooter.className = "overview-chart-footer";
  const compare = document.getElementById("compare-heatmap");
  compare.textContent = "Compare runs ↗";
  heatmapFooter.append(heatmap.querySelector(".heat-legend"), compare);
  heatmap.append(heatmapFooter);

  const noveltyFooter = document.createElement("div");
  noveltyFooter.className = "overview-chart-footer";
  noveltyFooter.append(document.getElementById("novelty-window-value"));
  novelty.append(noveltyFooter);
  charts.append(status, heatmap, novelty);
  document.querySelector("#view-overview .overview-grid").append(charts);
  return status;
}
