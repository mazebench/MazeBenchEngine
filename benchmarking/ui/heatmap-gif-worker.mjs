import { GIFEncoder, applyPalette } from "./vendor/gifenc-1.0.3.mjs";
import { HEAT_COLORS, croppedBounds, comparisonScale, heatColor, visitValue } from "./heatmap-comparison.mjs";
import { advanceTimeline, animationExtent, timelineState } from "./heatmap-timeline.mjs";

// One fixed palette for the whole animation prevents colors flickering as new
// tiles appear. Gray entries preserve antialiased text against the black canvas.
const palette = Array.from({ length: 32 }, (_, i) => Array(3).fill(Math.round(i * 255 / 31)));
for (let i = 0; i < 224; i++) {
  const value = i / 223 * (HEAT_COLORS.length - 1);
  const index = Math.min(HEAT_COLORS.length - 2, Math.floor(value)), blend = value - index;
  palette.push(HEAT_COLORS[index].map((c, j) => Math.round(c + (HEAT_COLORS[index + 1][j] - c) * blend)));
}

const elapsedLabel = ms => {
  const seconds = Math.floor(ms / 1000), hours = Math.floor(seconds / 3600);
  return `${hours}h ${String(Math.floor(seconds % 3600 / 60)).padStart(2, "0")}m ${String(seconds % 60).padStart(2, "0")}s`;
};

self.onmessage = ({ data: { panels, mode, seconds, scale } }) => {
  try {
    const extent = animationExtent(panels, mode), width = 1280, height = 720;
    const canvas = new OffscreenCanvas(width, height), ctx = canvas.getContext("2d", { willReadFrequently: true });
    if (!ctx) throw new Error("Canvas rendering is unavailable in this browser.");
    const maps = panels.map(p => p.finalMap), crops = maps.map(croppedBounds), colors = comparisonScale(maps, scale);
    const margin = 32, gap = Math.min(40, 160 / panels.length), panelWidth = (width - 2 * margin - gap * (panels.length - 1)) / panels.length;
    const cell = Math.min(panelWidth / Math.max(...crops.map(c => c.columns)), 540 / Math.max(...crops.map(c => c.rows)));
    const mapBottom = 582, states = panels.map(() => timelineState());
    ctx.font = "500 30px system-ui, sans-serif";
    const fontSize = Math.min(30, ...panels.map(p => 30 * panelWidth / Math.max(1, ctx.measureText(p.name).width)));
    const gif = GIFEncoder(), frameCount = Math.round(Math.max(5, Math.min(30, seconds)) * 10);
    for (let frame = 0; frame < frameCount; frame++) {
      const threshold = frame === 0 ? -1 : extent * (frame - 1) / (frameCount - 2);
      ctx.fillStyle = "#000"; ctx.fillRect(0, 0, width, height);
      ctx.textAlign = "center"; ctx.textBaseline = "middle";
      for (let i = 0; i < panels.length; i++) {
        const panel = panels[i], crop = crops[i], center = margin + panelWidth / 2 + i * (panelWidth + gap);
        const left = center - crop.columns * cell / 2, top = mapBottom - crop.rows * cell;
        const state = panel.snapshot ? null : advanceTimeline(states[i], panel, mode, threshold);
        const points = panel.snapshot ? panel.finalMap.points : [...state.counts].map(([tile, count]) => ({ x: tile % 256, y: Math.floor(tile / 256), count }));
        for (const point of points) {
          // Share mode uses the final visit total throughout, so the color of a
          // tile only grows with visits and the last frame matches the still map.
          ctx.fillStyle = heatColor(visitValue(point.count, panel.finalMap.total, scale), colors);
          const x = Math.round(left + (point.x - crop.minX) * cell), y = Math.round(top + (point.y - crop.minY) * cell);
          ctx.fillRect(x, y, Math.round(left + (point.x - crop.minX + 1) * cell) - x, Math.round(top + (point.y - crop.minY + 1) * cell) - y);
        }
        ctx.fillStyle = "#fff"; ctx.font = `500 ${fontSize}px system-ui, sans-serif`;
        ctx.fillText(panel.name, center, 614);
        ctx.fillStyle = "#aaa"; ctx.font = "16px system-ui, sans-serif";
        ctx.fillText(panel.snapshot ? "Snapshot · history unavailable" : `${Math.max(0, state.move).toLocaleString("en-US")} moves`, center, 647);
      }
      ctx.fillStyle = "#aaa"; ctx.font = "15px system-ui, sans-serif";
      const progress = Math.max(0, threshold);
      const clock = mode === "elapsed" ? `Elapsed ${elapsedLabel(progress)} · includes pauses`
        : `Move ${Math.floor(progress).toLocaleString("en-US")} / ${extent.toLocaleString("en-US")}`;
      ctx.fillText(`${clock}  ·  ${scale === "share" ? "Share of final visits" : "Visits per tile"}`, width / 2, 692);
      const pixels = applyPalette(ctx.getImageData(0, 0, width, height).data, palette);
      gif.writeFrame(pixels, width, height, { ...(frame === 0 ? { palette } : {}), delay: frame === frameCount - 1 ? 2100 : 100, repeat: 0 });
      if (frame % 5 === 0) self.postMessage({ type: "progress", percent: Math.round((frame + 1) / frameCount * 100) });
    }
    gif.finish();
    const bytes = gif.bytes();
    self.postMessage({ type: "done", bytes }, [bytes.buffer]);
  } catch (error) { self.postMessage({ type: "error", message: error.message || "GIF export failed." }); }
};
