// Documentation is derived only from authored frames, never engine output.
// Keep this pure so the audit can inspect projects without mutating their data.
import { createHash } from "node:crypto";
import { rotateVoxelsClockwise } from "../../apps/web/app/worldBounds.mjs";
import { normalizeOrangeWallFrame, orangeWallEngineAnchorZ, orangeWallMechanismValue } from "../../apps/web/app/orangeWalls.mjs";
import { buttonMechanismId, normalizeButtonOrientation, normalizeSlopeDirection, puncherMechanismId } from "../../apps/web/app/visualVariants.mjs";

const movingRoles = new Set(["player", "clone", "weightless-pushable", "pushable", "floating-floor"]);
const labels = { player: "Player", clone: "Clone", "weightless-pushable": "Box", pushable: "Crate", "floating-floor": "Floating floor", "player-lift": "Lift", "player-gate": "Gate", puncher: "Puncher", "orange-wall": "Orange walls", "orange-button": "Buttons", goal: "Gem" };
const compare = (a, b) => a.x - b.x || a.y - b.y || a.z - b.z;
const pos = v => `(${v.x}, ${v.y}, ${v.z})`;
const digest = value => createHash("sha256").update(JSON.stringify(value)).digest("hex");

export function normalizedPhysicsFrame(frame, world, project) {
  const blocks = new Map(project.blocks.map(b => [b.id, b]));
  const generic = new Set(project.roles.filter(r => r.generic).map(r => r.id));
  return normalizeOrangeWallFrame({ voxels: rotateVoxelsClockwise(frame.voxels, world, 0) }, blocks).voxels.map(v => {
    const b = blocks.get(v.blockId);
    let role = b?.roleId ?? `unknown:${v.blockId}`;
    let state = generic.has(role) ? v.genericId ?? 0 : -1;
    let z = v.z;
    if (b?.visual?.kind === "slope") role += `-slope-${normalizeSlopeDirection(v.orientation, v.variantId)}`;
    if (b?.visual?.kind === "button") state = buttonMechanismId(normalizeButtonOrientation(v.orientation, v.variantId), b.visual.buttonForm === "hidden");
    if (b?.visual?.kind === "puncher") state = puncherMechanismId(normalizeSlopeDirection(v.orientation, v.variantId), Number(v.genericId) === 1);
    if (role === "orange-wall") { z = orangeWallEngineAnchorZ(v); state = orangeWallMechanismValue(v); }
    return [v.x, v.y, z, role, state];
  }).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
}

export function auditContradictions(project) {
  const starts = new Map();
  for (const t of project.tests) {
    const key = digest([t.world.width, t.world.height, t.input, normalizedPhysicsFrame(t.start, t.world, project)]);
    const group = starts.get(key) ?? [];
    group.push(t);
    starts.set(key, group);
  }
  const contradictions = [], duplicates = [];
  for (const group of starts.values()) {
    if (group.length < 2) continue;
    const outcomes = new Set(group.map(t => digest([
      [...(t.intermediate ?? []), t.expected].map(f => normalizedPhysicsFrame(f, t.world, project)),
      t.cycle?.startTick ?? null, t.cycle?.repeatTick ?? null,
    ])));
    (outcomes.size > 1 ? contradictions : duplicates).push(group.map(t => ({ id: t.id, name: t.name, hidden: !!t.hidden, ticks: 1 + (t.intermediate?.length ?? 0) })));
  }
  return { contradictions, duplicates };
}

function entities(frame, blocks) {
  const groups = new Map();
  for (const v of frame.voxels) {
    const b = blocks.get(v.blockId);
    const role = b?.roleId;
    if (!labels[role]) continue;
    const numbered = role === "clone" || role === "weightless-pushable";
    const label = labels[role] + (numbered ? ` ${v.genericId ?? 0}` : "");
    const group = groups.get(label) ?? { label, role, voxels: [] };
    group.voxels.push(v);
    groups.set(label, group);
  }
  for (const group of groups.values()) group.voxels.sort(compare);
  return groups;
}

function configuration(v, role) {
  return [v.x, v.y, v.z,
    role === "orange-wall" ? v.mechanismDepth ?? 0 : v.genericId ?? -1,
    v.blockId];
}

function transition(before, after) {
  const a = before?.voxels ?? [], b = after?.voxels ?? [];
  const group = before ?? after;
  if (!b.length) return `${group.label} ${group.role === "goal" ? "is collected" : "disappears"}`;
  if (!a.length) return `${group.label} appears (${b.length} cell${b.length === 1 ? "" : "s"})`;
  if (JSON.stringify(a.map(v => configuration(v, group.role))) === JSON.stringify(b.map(v => configuration(v, group.role)))) return "";
  if (a.length === b.length) {
    const dx = b[0].x - a[0].x, dy = b[0].y - a[0].y, dz = b[0].z - a[0].z;
    if ((dx || dy || dz) && a.every((v, i) => b[i].x - v.x === dx && b[i].y - v.y === dy && b[i].z - v.z === dz)) {
      const moves = [dx ? `${Math.abs(dx)} ${dx > 0 ? "east" : "west"}` : "", dy ? `${Math.abs(dy)} ${dy > 0 ? "south" : "north"}` : "", dz ? `${Math.abs(dz)} ${dz > 0 ? "up" : "down"}` : ""].filter(Boolean);
      return `${group.label} moves ${moves.join(" and ")}`;
    }
  }
  if (group.role === "orange-wall") {
    const depths = [...new Set(b.map(v => v.mechanismDepth ?? 0))].sort((x, y) => x - y);
    return `Orange walls change to rise depth${depths.length === 1 ? "" : "s"} ${depths.join(", ")}`;
  }
  if (["player-lift", "player-gate", "puncher"].includes(group.role)) {
    const values = [...new Set(b.map(v => v.genericId ?? 0))].sort((x, y) => x - y);
    const wasRaised = a.filter(v => Number(v.genericId) % 2 === 1).length;
    const nowRaised = b.filter(v => Number(v.genericId) % 2 === 1).length;
    const action = group.role === "puncher"
      ? nowRaised > wasRaised ? "springs" : nowRaised < wasRaised ? "resets" : "changes its arrangement"
      : nowRaised > wasRaised ? "raises" : nowRaised < wasRaised ? "lowers" : "changes its arrangement";
    return `${group.label} ${action} (IDs ${values.join(", ")})`;
  }
  if (b.length < a.length) return `${group.label} loses ${a.length - b.length} cell${a.length - b.length === 1 ? "" : "s"}`;
  return `${group.label} changes its authored arrangement`;
}

export function describeTest(t, project) {
  const blocks = new Map(project.blocks.map(b => [b.id, b]));
  const frames = [t.start, ...(t.intermediate ?? []), t.expected];
  const groups = frames.map(f => entities(f, blocks));
  const steps = groups.slice(1).map((next, i) => [...new Set([...groups[i].keys(), ...next.keys()])]
    .map(key => {
      const event = transition(groups[i].get(key), next.get(key));
      if (event === "Floating floor disappears" && frames[i + 1].voxels.some(v =>
        blocks.get(v.blockId)?.roleId === "floor" && !frames[i].voxels.some(old =>
          old.blockId === v.blockId && old.x === v.x && old.y === v.y && old.z === v.z))) {
        return "Floating floor fills the hole and becomes permanent Floor";
      }
      return event;
    }).filter(Boolean).join("; ") || "The authored scene stays unchanged");
  const runs = [];
  for (const [i, text] of steps.entries()) {
    if (runs.at(-1)?.text === text) runs.at(-1).end = i + 1;
    else runs.push({ start: i + 1, end: i + 1, text });
  }
  const timeline = runs.map(r => `${r.start === r.end ? `Tick ${r.start}` : `Ticks ${r.start}–${r.end} (each tick)`}: ${r.text}.`).join("\n");
  const setup = [...groups[0].values()].filter(g => movingRoles.has(g.role)).map(g =>
    `${g.label}: ${g.voxels.length} cell${g.voxels.length === 1 ? "" : "s"}, starting at ${pos(g.voxels[0])}${g.voxels.length > 1 ? ` through ${pos(g.voxels.at(-1))}` : ""}`).join("; ");
  const mechanics = [...new Set(t.start.voxels.map(v => blocks.get(v.blockId)?.name).filter(Boolean))];
  const cycle = t.cycle ? ` The complete level repeats tick ${t.cycle.startTick} at tick ${t.cycle.repeatTick}, then rolls back to Start.` : "";
  const description = `One Up command in a ${t.world.width}×${t.world.height} room; expect exactly ${frames.length - 1} tick${frames.length === 2 ? "" : "s"} after Start.${cycle}\n${setup}. Terrain and fixtures: ${mechanics.filter(n => !["Player", "Weightless Pushbox", "Clone", "Amber crate"].includes(n)).join(", ") || "none"}.\n\n${timeline}\n\nCoordinates are (x, y, z); north decreases y. Every frame is checked in all four rotations. Unmentioned objects retain their authored positions and states.`;
  const groupName = project.tags.find(tag => tag.id === t.folderId)?.name ?? "Physics";
  const dynamicChanges = [...groups[0].keys()].filter(key => groups.slice(1).some((next, i) => transition(groups[i].get(key), next.get(key))));
  let titleAction;
  if (t.cycle) titleAction = `Loop from tick ${t.cycle.startTick} to ${t.cycle.repeatTick}`;
  else if (!dynamicChanges.length) titleAction = "Blocked command preserves the scene";
  else {
    const nonPlayer = dynamicChanges.find(k => k !== "Player");
    const subject = nonPlayer ?? dynamicChanges[0];
    const subjectGroups = groups.map(g => g.get(subject));
    const first = subjectGroups[0], last = subjectGroups.at(-1);
    if (!last) titleAction = subject === "Floating floor" && steps.some(s => s.includes("becomes permanent Floor"))
      ? "Floating floor fills the hole" : `${subject} ${first.role === "goal" ? "is collected" : "falls into the void"}`;
    else if (movingRoles.has(first.role)) {
      const all = subjectGroups.flatMap(g => g?.voxels ?? []);
      const startMin = Math.min(...first.voxels.map(v => v.z));
      const raised = subjectGroups.some(g => g?.voxels.length && Math.min(...g.voxels.map(v => v.z)) > startMin);
      const fallen = all.some(v => v.z < startMin);
      titleAction = raised ? `${subject} rises${fallen ? " and descends" : ""}` : fallen ? `${subject} descends` : transition(first, last) || `${subject} returns to its starting position`;
    } else titleAction = transition(first, last) || `${subject} completes a state transition`;
  }
  const anchor = groups[0].get("Player")?.voxels[0];
  const conciseAction = titleAction.replaceAll("moves 1 ", "moves ");
  const generatedTitle = `${groupName}: ${conciseAction} · ${frames.length - 1}t${anchor ? ` at ${pos(anchor)}` : ""}`;
  return { generatedTitle, description, steps, mechanics, frames: frames.length };
}

export function immutableTestFingerprint(t) {
  const { name, description, ...rest } = t;
  return digest(rest);
}
