const $ = id => document.getElementById(id);

// Keep every tick. Nearby hit targets share a picker so dense parts of a long
// replay never hide a gem or make a timestamp impossible to tap.
export function groupMarkers(events, duration, width, spacing = 22) {
  const groups = [];
  for (const event of events) {
    const x = duration ? width * event.at / duration : 0;
    let group = groups.at(-1);
    if (!group || x - group.last >= spacing) {
      group = { first: x, last: x, events: [] };
      groups.push(group);
    }
    group.last = x;
    group.events.push(event);
  }
  return groups;
}

export class ReplayMarkers {
  constructor({ seek, pause, roomLabel, formatTime }) {
    Object.assign(this, { seek, pause, roomLabel, formatTime, mode: "none" });
    this.track = $("timeline-markers");
    this.preview = $("marker-preview");
    this.picker = $("marker-picker");
    $("show-none").onclick = () => this.setMode("none");
    $("show-gems").onclick = () => this.setMode("gems");
    $("show-rooms").onclick = () => this.setMode("rooms");
    new ResizeObserver(() => this.render()).observe(this.track);
    document.addEventListener("pointerdown", event => {
      if (!this.picker.contains(event.target) && !this.track.contains(event.target)) this.closePicker();
    });
    this.picker.addEventListener("keydown", event => {
      if (event.key === "Escape") { this.closePicker(); this.origin?.focus(); }
    });
  }

  setMovie(movie) {
    this.movie = movie;
    $("gem-count").textContent = movie.gems.length.toLocaleString();
    $("room-count").textContent = movie.visits.length.toLocaleString();
    this.setMode(this.mode);
  }

  setMode(mode) {
    this.mode = mode;
    $("show-none").setAttribute("aria-pressed", String(mode === "none"));
    $("show-gems").setAttribute("aria-pressed", String(mode === "gems"));
    $("show-rooms").setAttribute("aria-pressed", String(mode === "rooms"));
    this.track.dataset.mode = mode;
    this.track.hidden = mode === "none";
    this.track.setAttribute("aria-label", mode === "none" ? "Timeline timestamps" : mode === "gems" ? "Gem collection timestamps" : "First room visit timestamps");
    this.render();
  }

  label(event) {
    const name = this.roomLabel(event.room);
    return this.mode === "gems" ? `Gem ${event.number} · ${name}` : `${name}${event.at === 0 ? " · Start room" : " · First visit"}`;
  }

  closePicker() { this.picker.hidden = true; }

  place(element, x) {
    const width = this.track.clientWidth;
    // Align with the seek thumb's six-pixel inset and keep the bubble onscreen.
    const half = Math.min(element.offsetWidth / 2, width / 2);
    element.style.left = `${6 + Math.max(half, Math.min(width - half, x))}px`;
  }

  render() {
    if (!this.movie) return;
    this.closePicker();
    this.preview.hidden = true;
    this.track.replaceChildren();
    const events = (this.mode === "none" ? [] : this.mode === "gems" ? this.movie.gems : this.movie.visits)
      .map((event, index) => ({ ...event, number: index + 1 }));
    $("marker-status").textContent = this.mode === "gems" && !events.length ? "No gems collected" : "";
    for (const event of events) {
      const tick = document.createElement("i");
      tick.style.left = `${100 * event.at / this.movie.duration}%`;
      tick.setAttribute("aria-hidden", "true");
      this.track.append(tick);
    }
    for (const group of groupMarkers(events, this.movie.duration, this.track.clientWidth)) {
      const button = document.createElement("button");
      const middle = (group.first + group.last) / 2, multiple = group.events.length > 1;
      const first = group.events[0], last = group.events.at(-1);
      const description = multiple
        ? `${group.events.length} ${this.mode === "gems" ? "gems" : "new rooms"} · ${this.formatTime(first.at, true)}–${this.formatTime(last.at, true)}`
        : `${this.formatTime(first.at, true)} · ${this.label(first)}`;
      button.type = "button";
      button.className = "timeline-marker";
      button.style.left = `${middle}px`;
      button.style.width = `${Math.max(22, group.last - group.first + 22)}px`;
      button.setAttribute("aria-label", multiple ? `${description}. Choose a timestamp` : `Jump to ${description}`);
      if (multiple) {
        const badge = document.createElement("span");
        badge.textContent = group.events.length;
        button.append(badge);
      }
      const preview = () => {
        if (!this.picker.hidden) return;
        this.preview.textContent = description;
        this.preview.hidden = false;
        this.place(this.preview, middle);
      };
      button.onpointerenter = preview;
      button.onfocus = preview;
      button.onpointerleave = button.onblur = () => { this.preview.hidden = true; };
      button.onclick = () => {
        this.pause();
        this.preview.hidden = true;
        if (!multiple) { this.closePicker(); this.seek(first.at); return; }
        this.origin = button;
        this.picker.replaceChildren();
        for (const event of group.events) {
          const item = document.createElement("button");
          const timestamp = document.createElement("time"), label = document.createElement("span");
          timestamp.textContent = this.formatTime(event.at, true);
          label.textContent = this.label(event);
          item.append(timestamp, label);
          item.onclick = () => { this.seek(event.at); this.closePicker(); button.focus(); this.preview.hidden = true; };
          this.picker.append(item);
        }
        this.picker.hidden = false;
        this.place(this.picker, middle);
        this.picker.firstElementChild.focus({ preventScroll: true });
      };
      this.track.append(button);
    }
  }
}
