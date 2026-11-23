import { JoinedMazeRenderer } from './joined-maze-renderer.mjs';
import { prepareBrowserModels } from './browser-world.mjs';
import { AsciiMazeRendererV2 } from '../render-ascii/v2/ascii-renderer.mjs';
import { renderAsciiFrameV2 as renderAsciiFrameV1, glyphCatalogForRoom } from '../render-ascii/v2/ascii-scene.mjs';
import { loadMazeBenchEngineV1 } from '../engine/v1/engine.mjs';
import { PlaySessionV1 } from '../play/v1/play-session.mjs';
import { cameraRelativeMoveDirection } from '../play/v1/camera-relative-input.mjs';
import { mountEditorCameraPad } from './editor-camera-pad.mjs';
import { playTimeline } from '../animations/v1/player.mjs';
import { easeInOut } from '../animations/v1/timeline.mjs';
import { objectCatalog, makeLabRoom, makeGenericLabRoom, labWorld, labHint, LABELS } from './object-lab-catalog.mjs';
import { loadMainWorldV2 } from '../render/v1/voxel-world-v2.mjs';
import { inventoryGenericBodies, genericSampleCount, symbolsInFrame, auditObjectSymbols } from './object-lab-audit.mjs';

const $ = id => document.getElementById(id);
const cameraPitches = [Math.PI / 2 - .001, 3 * Math.PI / 8, Math.PI / 4, Math.PI / 8, 0];
let blocks, entries, engine, renderer, painter, session, entry, displayedRoom;
let orientation, state = 0, bodyId = 0, play = false, yaw = 0, pitch = 2;
let selectionGeneration = 0, frameGeneration = 0, referenceGeneration = 0;
let noticeTimer;
let cameraTransition = null;
let allBodies = false, inventory, inventoryPromise, auditPromise, genericGeneration = 0;
const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');

// The lab owns camera input so both panels always use one cardinal camera.
// In particular, the inherited renderer must not consume the movement keys.
class LabRenderer extends JoinedMazeRenderer {
  installEvents() {
    this.canvas.addEventListener('contextmenu', event => event.preventDefault());
  }
}

function notice(message) {
  clearTimeout(noticeTimer);
  $('notice').textContent = message;
  noticeTimer = setTimeout(() => { $('notice').textContent = ''; }, 4000);
}

function renderList() {
  const query = $('search').value.trim().toLowerCase();
  const matches = entries.filter(item => `${item.name} ${item.id} ${item.group} ${item.roleId}`.toLowerCase().includes(query));
  const fragment = document.createDocumentFragment();
  for (const group of ['Actors', 'Terrain', 'Mechanisms', 'Slopes', 'Scenery']) {
    const members = matches.filter(item => item.group === group);
    if (!members.length) continue;
    const section = document.createElement('div'); section.className = 'object-group';
    const heading = document.createElement('h2'); heading.textContent = group; section.append(heading);
    for (const item of members) {
      const button = document.createElement('button'); button.className = 'object-item';
      button.dataset.object = item.id; button.setAttribute('aria-current', String(item.id === entry?.id));
      const dot = document.createElement('span'); dot.className = 'object-dot'; dot.style.background = item.color;
      const label = document.createElement('span'); label.textContent = item.name;
      const check = document.createElement('span'); check.className = 'object-check'; check.textContent = '✓'; check.setAttribute('aria-hidden', 'true');
      button.append(dot, label, check); button.addEventListener('click', () => {
        $('object-picker').close();
        selectObject(item);
      }); section.append(button);
    }
    fragment.append(section);
  }
  if (!matches.length) { const empty = document.createElement('p'); empty.className = 'empty'; empty.textContent = 'No matching objects.'; fragment.append(empty); }
  $('object-list').replaceChildren(fragment);
}

function segmentButtons(container, values, selected, label, onSelect) {
  container.replaceChildren(...values.map((value, index) => {
    const button = document.createElement('button'); button.textContent = label(value, index);
    button.setAttribute('aria-pressed', String(value === selected));
    button.addEventListener('click', () => onSelect(value, index)); return button;
  }));
}

function updateControls() {
  $('orientation-control').hidden = !entry.orientations.length;
  $('orientation-label').textContent = ['lift', 'orange-button'].includes(entry.id) ? 'Mount' : 'Direction';
  segmentButtons($('orientations'), entry.orientations, orientation, value => LABELS[value], value => {
    orientation = value; rebuildRoom();
  });
  $('state-control').hidden = !entry.states.length;
  $('state-label').textContent = play ? 'Start state' : 'State';
  segmentButtons($('states'), entry.states, entry.states[state], value => value, (_, index) => {
    state = index; rebuildRoom();
  });
  $('body-control').hidden = !entry.numbered || allBodies;
  $('generic-reference').hidden = !entry.numbered;
  $('view-bodies').setAttribute('aria-pressed', String(allBodies));
  $('view-bodies').textContent = allBodies ? 'Inspect one body' : 'View all together';
  document.querySelector('.object-controls').hidden = !entry.orientations.length && !entry.states.length && (!entry.numbered || allBodies);
  $('body-id').value = bodyId;
  $('inspect-mode').setAttribute('aria-pressed', String(!play));
  $('play-mode').setAttribute('aria-pressed', String(play));
  $('lab').classList.toggle('is-playing', play);
  $('lab').classList.toggle('all-bodies', allBodies);
  $('play-controls').hidden = !play;
  $('play-hint').textContent = labHint(entry, orientation);
}

async function selectObject(next) {
  const generation = ++selectionGeneration;
  session?.reset();
  entry = next; orientation = entry.orientations[0]; state = 0; bodyId = 0; allBodies = false;
  $('object-name').textContent = entry.name;
  $('selected-object-dot').style.background = entry.color;
  $('choose-object').setAttribute('aria-label', `Choose an object. Current: ${entry.name}`);
  $('object-description').textContent = entry.description;
  history.replaceState(null, '', `#${encodeURIComponent(entry.id)}`);
  renderList();
  // Prepare only this object's models (and the playground's gem), not a world.
  const urls = blocks.filter(block => [entry.id, 'gem'].includes(block.id)).map(block => block.visual?.modelUrl).filter(Boolean);
  await prepareBrowserModels(new Set(urls));
  if (generation !== selectionGeneration) return;
  rebuildRoom();
  if (entry.numbered) loadInventory().then(() => {
    if (generation !== selectionGeneration) return;
    // Update the preview catalogue without resetting an in-progress playground.
    if (!play) rebuildRoom();
    else updateGenericReference();
  }).catch(error => { $('generic-world-usage').textContent = `World usage unavailable: ${error.message}`; });
}

function rebuildRoom() {
  updateControls();
  const room = allBodies ? makeGenericLabRoom(entry, { orientation, count: genericSampleCount(entry, inventory) })
    : makeLabRoom(entry, { orientation, state, bodyId, play });
  // Opening also cancels any in-flight command from the previous setup.
  session.open(room);
  updateReference();
  updateGenericReference();
}

function loadInventory() {
  if (!inventoryPromise) inventoryPromise = loadMainWorldV2().then(world => {
    inventory = inventoryGenericBodies(world.rooms, world.blocks);
    return inventory;
  }).catch(error => { inventoryPromise = null; throw error; });
  return inventoryPromise;
}

function previewCatalog(room) {
  if (!entry.numbered || allBodies) return glyphCatalogForRoom(room);
  const samples = makeGenericLabRoom(entry, { count: genericSampleCount(entry, inventory) });
  // Include a manually entered ID outside the sample range, too.
  return glyphCatalogForRoom({ objects: [...samples.objects, ...room.objects] });
}

async function updateGenericReference() {
  const generation = ++genericGeneration;
  if (!entry.numbered) return;
  const selected = entry, count = genericSampleCount(entry, inventory);
  const catalog = glyphCatalogForRoom(makeGenericLabRoom(entry, { count }));
  $('generic-description').textContent = `${count} distinct bodies · IDs 0–${count - 1}. Select an ID to inspect it. Amber marks repeated top-down symbols.`;
  const usage = inventory?.types.find(type => type.id === entry.id);
  $('generic-world-usage').textContent = usage ? usage.highestId === null ? 'No numbered bodies of this type in Main World.'
    : `Main World: highest ID ${usage.highestId} (${usage.highestIdRooms.join(', ')}); most in one room: ${usage.mostBodies} (${usage.mostBodiesRooms.join(', ')}).`
    : 'Checking Main World’s highest IDs…';
  const previews = await Promise.all(Array.from({ length: count }, async (_, id) => {
    const room = makeLabRoom(selected, { orientation, bodyId: id });
    const [top, tilted] = await Promise.all([0, 2].map(pitch => renderAsciiFrameV1(room, blocks, { yaw, pitch, catalog })));
    return { id, top: symbolsInFrame(top, selected.id).join(''), tilted: symbolsInFrame(tilted, selected.id).join('') };
  }));
  if (generation !== genericGeneration) return;
  const fragment = document.createDocumentFragment();
  for (const preview of previews) {
    const button = document.createElement('button'); button.className = 'generic-tile';
    button.dataset.bodyId = preview.id;
    button.setAttribute('aria-pressed', String(!allBodies && bodyId === preview.id));
    button.setAttribute('aria-label', `${selected.name}, body ID ${preview.id}`);
    const duplicate = previews.filter(item => item.top === preview.top).length > 1;
    button.classList.toggle('repeated-symbol', duplicate);
    button.title = duplicate ? 'This top-down symbol is shared by multiple body IDs.' : 'Distinct top-down symbol in this set.';
    const label = document.createElement('strong'); label.textContent = `ID ${preview.id}`;
    button.append(label);
    for (const [label, value] of [['Top', preview.top], ['Tilted', preview.tilted]]) {
      const row = document.createElement('span'); row.textContent = label;
      const glyph = document.createElement('code'); glyph.textContent = value || '—'; row.append(glyph); button.append(row);
    }
    button.addEventListener('click', () => { bodyId = preview.id; allBodies = false; rebuildRoom(); });
    fragment.append(button);
  }
  $('generic-gallery').replaceChildren(fragment);
}

async function showSymbolReview() {
  if (auditPromise) return auditPromise;
  auditPromise = (async () => {
    $('audit-status').textContent = 'Checking Main World and all object views…';
    const inventory = await loadInventory();
    const audit = await auditObjectSymbols(blocks, { inventory, yieldProgress: async id => {
      $('audit-status').textContent = `Checking symbols: ${entries.find(item => item.id === id).name}…`;
      await new Promise(resolve => setTimeout(resolve, 0));
    } });
    const gameplay = audit.collisions.filter(item => item.kind === 'gameplay'), mixed = audit.collisions.filter(item => item.kind === 'mixed');
    $('audit-status').textContent = `${audit.objects} object types · ${audit.viewsChecked.toLocaleString()} views checked · ${inventory.roomCount} rooms scanned`;
    const result = document.createDocumentFragment();
    const message = text => { const p = document.createElement('p'); p.textContent = text; result.append(p); };
    message(`${gameplay.length} shared gameplay symbols; ${mixed.length} shared between gameplay objects and scenery; ${audit.collisions.filter(item => item.kind === 'scenery').length} shared scenery symbols. Greek and Latin lookalikes are different Unicode characters.`);
    for (const collision of audit.collisions) {
      const row = document.createElement('p'); row.className = 'audit-collision';
      const code = document.createElement('code'); code.textContent = collision.glyph;
      const names = [...new Set(collision.owners.map(owner => owner.name))];
      row.append(code, document.createTextNode(`${names.join(' · ')}${collision.kind === 'scenery' ? ' (scenery only)' : ` · ${collision.owners.length} object identities`}`)); result.append(row);
    }
    message(audit.topDownMismatches.length ? 'Some top-down symbols differ from their catalogue entries.' : 'Every visible top-down symbol matches its catalogue entry. Exit is retired; E and e remain reserved.');
    const table = document.createElement('table'); table.className = 'inventory-table';
    const heading = table.createTHead().insertRow();
    for (const title of ['Type', 'Highest ID', 'Most IDs / room']) { const th = document.createElement('th'); th.scope = 'col'; th.textContent = title; heading.append(th); }
    for (const type of inventory.types) {
      const row = table.createTBody().insertRow();
      for (const text of [type.name, type.highestId === null ? 'None' : `${type.highestId} · ${type.highestIdRooms.join(', ')}`, `${type.mostBodies} · ${type.mostBodiesRooms.join(', ') || 'None'}`]) row.insertCell().textContent = text;
    }
    result.append(table);
    for (const note of audit.notes) message(note);
    $('audit-results').replaceChildren(result);
  })().catch(error => { $('audit-status').textContent = `Review unavailable: ${error.message}`; auditPromise = null; });
  return auditPromise;
}

function fitCamera() {
  renderer.target.y = Math.max(1, ...displayedRoom.objects.filter(object => object.x >= 0).map(object =>
    object.z + (blocks.find(block => block.id === object.blockId)?.visual?.height || 1))) / 3;
  renderer.distance = renderer.fitDistance() * 1.05;
}

function updateCameraLabels() {
  $('camera-heading').textContent = `${yaw * 90}°`;
  $('camera-pitch').querySelectorAll('button').forEach(button => button.setAttribute('aria-pressed', String(Number(button.dataset.pitch) === pitch)));
  $('lab-camera-pad').querySelectorAll('button').forEach(button => {
    button.disabled = (button.dataset.camera === 'up' && pitch === 0) ||
      (button.dataset.camera === 'down' && pitch === cameraPitches.length - 1);
  });
}

function updateCamera(animate = false) {
  cameraTransition?.abort();
  cameraTransition = null;
  renderer.heading = yaw;
  updateCameraLabels();
  const startYaw = renderer.yaw, startPitch = renderer.pitch;
  // Cross 0° by the nearest quarter-turn, and retarget from the displayed pose.
  const targetYaw = yaw * Math.PI / 2;
  const yawDelta = Math.atan2(Math.sin(targetYaw - startYaw), Math.cos(targetYaw - startYaw));
  const targetPitch = cameraPitches[pitch];
  if (!animate || reducedMotion.matches || document.hidden ||
      (Math.abs(yawDelta) < 1e-8 && Math.abs(targetPitch - startPitch) < 1e-8)) {
    renderer.yaw = targetYaw; renderer.pitch = targetPitch;
    renderer.canvas.dataset.cameraAnimating = 'false';
    renderer.render();
    return;
  }
  const controller = new AbortController();
  cameraTransition = controller;
  renderer.canvas.dataset.cameraAnimating = 'true';
  const duration = 240;
  playTimeline({ duration }, elapsed => {
    const t = easeInOut(elapsed / duration);
    renderer.yaw = startYaw + yawDelta * t;
    renderer.pitch = startPitch + (targetPitch - startPitch) * t;
    renderer.render();
  }, { signal: controller.signal, finish: () => document.hidden || reducedMotion.matches }).then(completed => {
    if (cameraTransition !== controller) return;
    cameraTransition = null;
    if (completed) { renderer.yaw = targetYaw; renderer.pitch = targetPitch; renderer.render(); }
    renderer.canvas.dataset.cameraAnimating = 'false';
  }).catch(error => {
    if (cameraTransition !== controller) return;
    updateCamera(false);
    notice(error.message);
  });
}

async function showFrame(engineState, room) {
  const generation = ++frameGeneration;
  displayedRoom = engine.roomFromState(engineState, room);
  if (!renderer) {
    renderer = new LabRenderer($('scene'), labWorld(displayedRoom, blocks), { mode: 'play', pickVoxels: true });
    renderer.fuzzyOverlay.enabled = false;
    renderer.fuzzyOverlay.canvas.remove();
    new ResizeObserver(() => { renderer.resize(); fitCamera(); renderer.render(); }).observe($('scene'));
  } else renderer.setWorld(labWorld(displayedRoom, blocks), { preserveCamera: true });
  fitCamera();
  if (!cameraTransition) updateCamera();
  else renderer.render();
  await paintText(generation);
}

async function paintText(generation = ++frameGeneration) {
  const frame = await renderAsciiFrameV1(displayedRoom, blocks, { yaw, pitch, catalog: painter.catalog });
  if (generation !== frameGeneration) return;
  painter.yaw = yaw;
  painter.pitch = pitch;
  painter.paintBoard(frame);
  $('ascii').dataset.frame = String(generation);
  $('scene').dataset.frame = String(generation);
  const symbols = [...new Set(frame.pixels.flat().filter(pixel => pixel.name === entry.id).map(pixel => pixel.glyph))].filter(symbol => symbol.trim());
  const label = document.createElement('span'); label.append(document.createTextNode('Symbols'));
  for (const symbol of symbols) {
    const glyph = document.createElement('code'); glyph.textContent = symbol;
    glyph.title = [...symbol].map(character => `U+${character.codePointAt(0).toString(16).toUpperCase().padStart(4, '0')}`).join(' ');
    label.append(glyph);
  }
  if (!symbols.length) label.textContent = 'Object hidden from this angle';
  $('glyphs').replaceChildren(label);
}

async function updateReference() {
  const generation = ++referenceGeneration;
  const orientations = entry.orientations.length ? entry.orientations : [0, 1, 2, 3];
  const fragment = document.createDocumentFragment();
  const notes = [];
  if (entry.orientations.length) notes.push('Select a rotation below to inspect it. Hidden faces appear when you rotate the camera.');
  else notes.push('The same object from four camera directions. Select a view below.');
  if (entry.numbered) notes.push('Symbols depend on the body IDs present in a room; use Body ID to explore them.');
  if (entry.id === 'puncher') notes.push('The current text renderer distinguishes direction, but its puncher symbols do not distinguish resting from sprung.');
  if (entry.id === 'orange-slope') notes.push('In the benchmark engine used here, orange ramps currently behave as fixed ice ramps: the button does not retract them. State lets you inspect the retracted geometry separately.');
  if (entry.id === 'orange-button') notes.push('An exposed button occupies the middle 2 × 2 characters of its face. An occupant can hide it.');
  if (entry.roleId === 'orange-wall') notes.push('A fully retracted wall has no exposed text pixels.');
  if (play) notes.push('These reference tiles show the selected starting setup. The large panels show the live room.');
  $('render-note').textContent = notes.join(' ');
  const results = await Promise.all(orientations.map(async value => {
    const room = makeLabRoom(entry, { orientation: entry.orientations.length ? value : orientation, state, bodyId });
    const frame = await renderAsciiFrameV1(room, blocks, { yaw: entry.orientations.length ? yaw : value, pitch, catalog: painter.catalog });
    return { value, frame };
  }));
  if (generation !== referenceGeneration) return;
  for (const { value, frame } of results) {
    const button = document.createElement('button'); button.className = 'rotation-tile';
    button.setAttribute('aria-pressed', String(value === (entry.orientations.length ? orientation : yaw)));
    const name = document.createElement('span'); name.className = 'rotation-name';
    name.textContent = entry.orientations.length ? LABELS[value] : `${value * 90}°`;
    const pre = document.createElement('pre'); pre.className = 'ascii-board';
    const points = frame.pixels.flatMap((row, y) => row.flatMap((pixel, x) => pixel.name === entry.id ? [{ x, y }] : []));
    if (points.length) {
      const xs = points.map(point => point.x), ys = points.map(point => point.y);
      const minX = Math.min(...xs), maxX = Math.max(...xs), minY = Math.min(...ys), maxY = Math.max(...ys);
      for (let y = minY; y <= maxY; y++) {
        for (let x = minX; x <= maxX; x++) {
          const pixel = frame.pixels[y][x]; const span = document.createElement('span');
          span.textContent = pixel.name === entry.id ? pixel.glyph : ' ';
          span.style.color = pixel.color; pre.append(span);
        }
        if (y < maxY) pre.append(document.createTextNode('\n'));
      }
    } else { pre.textContent = 'Not visible'; pre.classList.add('not-visible'); }
    button.append(name, pre);
    button.addEventListener('click', () => {
      if (entry.orientations.length) { orientation = value; rebuildRoom(); }
      else { yaw = value; changeCamera(); }
    });
    fragment.append(button);
  }
  $('rotation-gallery').replaceChildren(fragment);
}

function changeCamera() {
  if (!session?.state) return;
  updateCamera(true);
  paintText().catch(error => notice(error.message));
  updateReference();
  updateGenericReference();
}

function cameraCommand(direction) {
  if (direction === 'left' || direction === 'right') yaw = (yaw + (direction === 'left' ? 3 : 1)) % 4;
  else {
    const nextPitch = Math.max(0, Math.min(cameraPitches.length - 1, pitch + (direction === 'up' ? -1 : 1)));
    if (nextPitch === pitch) return;
    pitch = nextPitch;
  }
  changeCamera();
}

function move(direction) {
  if (!play || session.running) return;
  // Same camera-relative movement convention as Play; ASCII's screen-direction
  // glyph rotation is the inverse mapping of camera input to world commands.
  return session.move(cameraRelativeMoveDirection(direction, yaw));
}

async function start() {
  mountEditorCameraPad($('lab-camera-pad'));
  await import('./control-pad-feedback.mjs');
  const [manifest, loadedEngine] = await Promise.all([
    fetch('../level-data/v2/main-world/world.json').then(response => {
      if (!response.ok) throw new Error('Could not load the object catalogue.');
      return response.json();
    }).then(value => { $('load-progress').value += 1; return value; }),
    loadMazeBenchEngineV1().then(value => { $('load-progress').value += 1; return value; })
  ]);
  engine = loadedEngine;
  blocks = manifest.blocks.map(block => ({ ...block, visual: { ...block.visual,
    ...(block.visual?.modelUrl ? { modelUrl: new URL(block.visual.modelUrl, new URL('../level-data/v2/main-world/world.json', import.meta.url)).href } : {}) } }));
  entries = objectCatalog(blocks);
  painter = new AsciiMazeRendererV2($('ascii'), null, blocks);
  session = new PlaySessionV1(engine, blocks, {
    frameDelay: 100,
    onFrame(engineState, room) {
      // Freeze the room's identity catalogue across movement and collection.
      if (!session.moves && !session.running) painter.catalog = previewCatalog(room);
      showFrame(engineState, room).catch(error => notice(error.message));
    },
    onChange(change) {
      $('move-count').textContent = `${change.moves} ${change.moves === 1 ? 'move' : 'moves'}`;
      $('undo').disabled = !change.canUndo;
      $('play-status').textContent = change.error || (!change.playerActive ? 'Player fell out. Undo or reset to continue.' : change.cycle ? 'This movement loop was rolled back by the engine.' : '');
      document.querySelectorAll('[data-move]').forEach(button => { button.disabled = change.busy || !change.playerActive; });
    }
  });
  $('lab').hidden = false;
  const initial = entries.find(item => item.id === decodeURIComponent(location.hash.slice(1))) || entries.find(item => item.id === 'lift') || entries[0];
  await selectObject(initial);
  $('load-progress').value = 3; $('loading').hidden = true;
  $('search').addEventListener('input', renderList);
  $('choose-object').addEventListener('click', () => {
    $('camera-settings').open = false;
    $('search').value = '';
    renderList();
    $('object-picker').showModal();
  });
  $('close-picker').addEventListener('click', () => $('object-picker').close());
  $('symbol-review').addEventListener('toggle', () => { if ($('symbol-review').open) showSymbolReview(); });
  $('view-bodies').addEventListener('click', () => { allBodies = !allBodies; play = false; rebuildRoom(); });
  $('object-picker').addEventListener('click', event => {
    if (event.target !== $('object-picker')) return;
    const bounds = $('object-picker').getBoundingClientRect();
    if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) $('object-picker').close();
  });
  $('inspect-mode').addEventListener('click', () => { play = false; rebuildRoom(); });
  $('play-mode').addEventListener('click', () => { play = true; allBodies = false; rebuildRoom(); });
  $('body-id').addEventListener('change', () => {
    bodyId = Math.max(0, Math.min(999, Math.trunc(Number($('body-id').value) || 0))); rebuildRoom();
  });
  $('lab-camera-pad').addEventListener('click', event => {
    const button = event.target.closest('[data-camera]');
    if (button && !button.disabled) cameraCommand(button.dataset.camera);
  });
  $('camera-pitch').addEventListener('click', event => {
    const button = event.target.closest('[data-pitch]'); if (!button) return;
    pitch = Number(button.dataset.pitch); changeCamera();
    $('camera-settings').open = false;
  });
  document.addEventListener('pointerdown', event => {
    if (!$('camera-settings').contains(event.target)) $('camera-settings').open = false;
  });
  $('undo').addEventListener('click', () => session.undo());
  $('reset').addEventListener('click', () => session.reset());
  document.querySelectorAll('[data-move]').forEach(button => button.addEventListener('click', () => move(button.dataset.move)));
  window.addEventListener('keydown', event => {
    if (event.key === 'Escape' && $('camera-settings').open) {
      $('camera-settings').open = false;
      $('camera-settings').querySelector('summary').focus();
      event.preventDefault();
      return;
    }
    if ($('object-picker').open || event.defaultPrevented || event.isComposing || event.ctrlKey || event.metaKey || event.altKey ||
        event.target.closest?.('input,textarea,select,[contenteditable]')) return;
    const key = event.key.toLowerCase();
    if (['w', 'a', 's', 'd'].includes(key)) {
      event.preventDefault();
      if (event.repeat) return;
      cameraCommand({ w: 'up', a: 'left', s: 'down', d: 'right' }[key]);
      return;
    }
    const direction = { ArrowUp: 'up', ArrowRight: 'right', ArrowDown: 'down', ArrowLeft: 'left' }[event.key];
    if (direction && play) { event.preventDefault(); if (!event.repeat) move(direction); }
  });
  reducedMotion.addEventListener('change', () => { if (cameraTransition) updateCamera(false); });
  document.addEventListener('visibilitychange', () => { if (document.hidden && cameraTransition) updateCamera(false); });
  $('copy-text').addEventListener('click', async () => {
    try { await navigator.clipboard.writeText($('ascii').textContent); notice('Text view copied.'); }
    catch { notice('Could not copy. Select the text view and copy it manually.'); }
  });
}

start().catch(error => {
  $('loading').replaceChildren(document.createTextNode(`Could not open the lab: ${error.message}`));
  console.error(error);
});
