"use client";

import { useEffect, useMemo, useState } from "react";
import MazeBenchCanvas, { type CanvasProps } from "./MazeBenchCanvas";
import { cameraFacingSlopeDirection } from "./cameraNavigation.mjs";

// Keep one renderer and cache the finished 96px tiles, not full-size PNGs.
// Camera turns only queue the slope variants that have not been captured yet.
const cache = new Map<string, HTMLCanvasElement>();
const previewWorld = { width: 1, height: 1, floorLayer: 0 as const };
const previewCamera = { yaw: Math.atan2(1.5, 1.8), tilt: Math.atan2(Math.hypot(1.5, 1.8), 1.2), zoom: 0.9 };
type Props = Pick<CanvasProps, "blocks" | "genericBlockIds"> & {
  genericIds: Record<string, number>;
  orangeWallDepths: Record<string, number>;
  cameraQuarterTurns: number;
};
type Job = { key: string; blockId: string; frame: CanvasProps["frame"] };

function cropPreview(source: HTMLCanvasElement) {
  // A small readback finds the bounds; draw the final tile from the original
  // buffer to retain detail without scanning/encoding a 512px image per tile.
  const sample = document.createElement("canvas");
  sample.width = 128;
  sample.height = Math.max(1, Math.round(128 * source.height / source.width));
  const scan = sample.getContext("2d", { willReadFrequently: true });
  const tile = document.createElement("canvas");
  tile.width = tile.height = 96;
  const context = tile.getContext("2d");
  if (!scan || !context) return tile;
  scan.drawImage(source, 0, 0, sample.width, sample.height);
  const { data } = scan.getImageData(0, 0, sample.width, sample.height);
  let left = sample.width, top = sample.height, right = -1, bottom = -1;
  for (let y = 0; y < sample.height; y++) for (let x = 0; x < sample.width; x++) {
    const offset = (y * sample.width + x) * 4;
    if (Math.max(Math.abs(data[offset] - 5), Math.abs(data[offset + 1] - 6), Math.abs(data[offset + 2] - 8)) < 12) continue;
    left = Math.min(left, x); right = Math.max(right, x);
    top = Math.min(top, y); bottom = Math.max(bottom, y);
  }
  if (right >= left && bottom >= top) {
    left = Math.max(0, left - 1); top = Math.max(0, top - 1);
    right = Math.min(sample.width - 1, right + 1); bottom = Math.min(sample.height - 1, bottom + 1);
    const width = right - left + 1, height = bottom - top + 1;
    const scale = Math.min(80 / width, 80 / height);
    const ratio = source.width / sample.width;
    context.drawImage(source, left * ratio, top * ratio, width * ratio, height * ratio,
      (96 - width * scale) / 2, (96 - height * scale) / 2, width * scale, height * scale);
  }
  return tile;
}

function paintPreview(job: Job, tile: HTMLCanvasElement) {
  const canvas = document.querySelector<HTMLCanvasElement>(`#lab-toolbox [data-block-id="${CSS.escape(job.blockId)}"] canvas`);
  if (!canvas || canvas.dataset.previewKey === job.key) return;
  const context = canvas.getContext("2d");
  if (!context) return;
  context.clearRect(0, 0, canvas.width, canvas.height);
  context.drawImage(tile, 0, 0, canvas.width, canvas.height);
  canvas.dataset.previewKey = job.key;
  canvas.dataset.previewReady = "true";
}

export default function LabToolboxPreviews({ blocks, genericBlockIds, genericIds, orangeWallDepths, cameraQuarterTurns }: Props) {
  const jobs = useMemo(() => blocks.map((block): Job => {
    const voxel = {
      x: 0, y: 0, z: 0, blockId: block.id,
      genericId: genericIds[block.id] ?? 0,
      mechanismDepth: orangeWallDepths[block.id] ?? 0,
      ...(block.visual.kind === "slope" ? { orientation: cameraFacingSlopeDirection(cameraQuarterTurns) } : {}),
    };
    return { key: JSON.stringify([block, voxel, genericBlockIds.has(block.id)]), blockId: block.id, frame: { voxels: [voxel] } };
  }), [blocks, genericBlockIds, genericIds, orangeWallDepths, cameraQuarterTurns]);
  const [job, setJob] = useState<Job | null>(null);
  useEffect(() => {
    for (const item of jobs) {
      const tile = cache.get(item.key);
      if (tile) paintPreview(item, tile);
    }
    // Retain the last frame while idle so shaders, models, and the WebGL
    // context survive the next camera turn or tool-state change.
    const frame = requestAnimationFrame(() => {
      setJob((current) => jobs.find((item) => !cache.has(item.key)) ?? current);
    });
    return () => cancelAnimationFrame(frame);
  }, [jobs]);

  if (!job) return null;
  return <div className="lab-tool-preview-renderer" aria-hidden="true">
    <MazeBenchCanvas compact frame={job.frame} blocks={blocks} genericBlockIds={genericBlockIds}
      world={previewWorld} layer={0} snapshotCamera={previewCamera} snapshotRequestId={job.key}
      onSnapshotCanvas={(source) => {
        const tile = cropPreview(source);
        if (cache.size >= Math.max(128, jobs.length)) cache.delete(cache.keys().next().value!);
        cache.set(job.key, tile);
        if (jobs.some((item) => item.key === job.key)) paintPreview(job, tile);
        setJob(jobs.find((item) => !cache.has(item.key)) ?? job);
      }} />
  </div>;
}
