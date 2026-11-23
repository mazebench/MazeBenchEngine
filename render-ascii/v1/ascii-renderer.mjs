import { ASCII_RENDERER_VERSION } from "./glyph-contract.mjs";
import { glyphCatalogForRoom, renderAsciiFrameV1 } from "./ascii-scene.mjs";

export class AsciiMazeRendererV1 {
  constructor(boardElement, legendElement, definitions, options = {}) {
    this.boardElement = boardElement;
    this.legendElement = legendElement;
    this.definitions = definitions;
    this.hideNames = options.hideNames === true;
    this.hideNamesSeed = String(options.hideNamesSeed || "1");
    this.yaw = 0;
    this.pitch = 1;
    this.room = null;
    this.catalog = null;
    this.catalogRoomName = "";
    this.renderGeneration = 0;
    this.boardElement.dataset.asciiRendererVersion = ASCII_RENDERER_VERSION;
  }

  openRoom(room) {
    this.room = room;
    this.catalog = glyphCatalogForRoom(room);
    this.catalogRoomName = room.fileName || room.position?.join("x") || "room";
    return this.render();
  }

  setRoom(room) {
    this.room = room;
    const roomName = room.fileName || room.position?.join("x") || "room";
    if (!this.catalog || roomName !== this.catalogRoomName) {
      this.catalog = glyphCatalogForRoom(room);
      this.catalogRoomName = roomName;
    }
    return this.render();
  }

  setYaw(yaw) {
    this.yaw = yaw;
    return this.render();
  }

  setPitch(pitch) {
    this.pitch = pitch;
    return this.render();
  }

  setSeedOptions({ hideNames = this.hideNames, hideNamesSeed = this.hideNamesSeed } = {}) {
    this.hideNames = hideNames === true;
    this.hideNamesSeed = String(hideNamesSeed || "1");
    return this.render();
  }

  async render() {
    if (!this.room) return;
    const generation = ++this.renderGeneration;
    const frame = await renderAsciiFrameV1(this.room, this.definitions, {
      catalog: this.catalog,
      hideNames: this.hideNames,
      hideNamesSeed: this.hideNamesSeed,
      pitch: this.pitch,
      yaw: this.yaw
    });
    if (generation !== this.renderGeneration) return;
    this.paintBoard(frame);
    this.paintLegend(frame.legend);
  }

  paintBoard(frame) {
    const fragment = document.createDocumentFragment();
    frame.pixels.forEach((row) => {
      let run = null;
      const flush = () => {
        if (!run) return;
        const span = document.createElement("span");
        span.style.color = run.color;
        span.title = run.name;
        span.textContent = run.text;
        fragment.append(span);
      };
      row.forEach((pixel) => {
        if (run && run.color === pixel.color && run.name === pixel.name && run.glyph === pixel.glyph) {
          run.text += pixel.glyph;
        } else {
          flush();
          run = { ...pixel, text: pixel.glyph };
        }
      });
      flush();
      fragment.append("\n");
    });
    this.boardElement.replaceChildren(fragment);
    this.boardElement.dataset.asciiWidth = String(frame.width);
    this.boardElement.dataset.asciiHeight = String(frame.height);
    this.boardElement.dataset.asciiYaw = String(this.yaw);
    this.boardElement.dataset.asciiPitch = String(frame.pitch);
    this.boardElement.dataset.asciiSeeded = String(this.hideNames);
    this.boardElement.dataset.asciiSeed = this.hideNamesSeed;
  }

  paintLegend(entries) {
    if (!this.legendElement) return;
    const fragment = document.createDocumentFragment();
    entries.forEach((entry) => {
      const item = document.createElement("span");
      const glyph = document.createElement("b");
      glyph.style.color = entry.color;
      glyph.textContent = entry.glyph;
      item.append(glyph, ` ${entry.name}`);
      fragment.append(item);
    });
    this.legendElement.replaceChildren(fragment);
    this.legendElement.hidden = entries.length === 0;
  }
}
