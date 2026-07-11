(function (global) {
  "use strict";

  const DIRECTIONS = [
    { id: "up", short: "N", label: "U", dx: 0, dy: -1 },
    { id: "right", short: "E", label: "R", dx: 1, dy: 0 },
    { id: "down", short: "S", label: "D", dx: 0, dy: 1 },
    { id: "left", short: "W", label: "L", dx: -1, dy: 0 }
  ];

  function normalizeLevelId(value) {
    const match = String(value || "").match(/^(?:level_)?([A-Z])x([A-Z])$/);
    return match ? "level_" + match[1] + "x" + match[2] : "";
  }

  function levelCoordinates(levelId) {
    const match = normalizeLevelId(levelId).match(/^level_([A-Z])x([A-Z])$/);
    return match ? { column: match[1].charCodeAt(0) - 65, row: match[2].charCodeAt(0) - 65 } : null;
  }

  function countCellGems(cells) {
    let count = 0;
    for (const row of cells || []) {
      for (const cell of row || []) {
        count += String(cell || "").split(/[+\s]+/).filter((token) => token === "G").length;
      }
    }
    return count;
  }

  function clone(value) {
    return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
  }

  function oppositeDirection(directionId) {
    return directionId === "up" ? "down" :
      directionId === "down" ? "up" :
        directionId === "left" ? "right" : "left";
  }

  function createController(options = {}) {
    const levels = Array.isArray(options.levels) ? options.levels : [];
    const rooms = new Map();
    for (const level of levels) {
      const id = normalizeLevelId(level?.id || level?.levelId);
      if (!id) continue;
      rooms.set(id, {
        id,
        label: level.label || id.replace("level_", ""),
        width: Math.max(1, Number(level.width) || level.cells?.[0]?.length || 16),
        height: Math.max(1, Number(level.height) || level.cells?.length || 16),
        totalGems: Number.isFinite(Number(level.total_gems))
          ? Number(level.total_gems)
          : countCellGems(level.cells),
        visited: false,
        currentEntry: "start",
        entries: new Set(),
        analyzedSignatures: new Set(),
        failedExitTargets: new Set(),
        attemptedTransitions: new Set(),
        trail: new Set(),
        analysis: null,
        analyses: new Map(),
        currentRecipe: null
      });
    }

    let running = false;
    let stopped = false;
    let completed = false;
    let dockTerminal = false;
    let loopVersion = 0;
    let lastLevelId = "";
    let lastCollectedCount = -1;
    let worker = null;
    let workerJobId = 0;
    let activeWorkerJob = null;
    let trailTimer = 0;
    let root = null;
    let statusElement = null;
    let barElement = null;
    let trackElement = null;
    let pathElement = null;
    let elapsedElement = null;
    let dockStartedAt = 0;
    let dockTickTimer = 0;
    let pauseButton = null;
    let findGemButton = null;
    let findLocationButton = null;
    let selectingLocation = false;
    let locationTapStart = null;
    let forceStartEntry = false;
    let pendingEntryRecipe = null;

    function app() {
      return typeof options.appProvider === "function" ? options.appProvider() : options.app;
    }

    function currentLevelId() {
      return normalizeLevelId(app()?.currentLevelId || options.startLevelId) || normalizeLevelId(options.startLevelId);
    }

    function collectedGemIds() {
      return app()?.collectedGemIds instanceof Set ? app().collectedGemIds : new Set();
    }

    function collectedCount() {
      return collectedGemIds().size;
    }

    function collectedInRoom(levelId) {
      const prefix = normalizeLevelId(levelId) + ":";
      let count = 0;
      for (const id of collectedGemIds()) {
        if (String(id).startsWith(prefix)) count += 1;
      }
      return count;
    }

    function totalGems() {
      return Array.from(rooms.values()).reduce((sum, room) => sum + room.totalGems, 0);
    }

    function roomRemaining(room) {
      return Math.max(0, room.totalGems - collectedInRoom(room.id));
    }

    function roomNeighbor(roomId, direction) {
      const point = levelCoordinates(roomId);
      if (!point) return "";
      const column = point.column + direction.dx;
      const row = point.row + direction.dy;
      if (column < 0 || row < 0 || column > 25 || row > 25) return "";
      const id = "level_" + String.fromCharCode(65 + column) + "x" + String.fromCharCode(65 + row);
      return rooms.has(id) ? id : "";
    }

    function mainPlayer() {
      return (app()?.state?.actors || []).find((actor) =>
        !actor?.removed && (actor.type === "player" || actor.type === "circle_player")
      ) || null;
    }

    function observeRoomTransition(levelId = currentLevelId()) {
      const normalized = normalizeLevelId(levelId);
      if (!normalized || normalized === lastLevelId) return;
      const room = rooms.get(normalized);
      if (!room) return;
      let entry = "start";
      if (!forceStartEntry && lastLevelId) {
        const before = levelCoordinates(lastLevelId);
        const after = levelCoordinates(normalized);
        const dx = after && before ? after.column - before.column : 0;
        const dy = after && before ? after.row - before.row : 0;
        const exit = DIRECTIONS.find((direction) => direction.dx === dx && direction.dy === dy);
        if (exit) entry = oppositeDirection(exit.id);
      }
      room.visited = true;
      room.currentEntry = entry;
      room.entries.add(entry);
      room.analysis = null;
      room.currentRecipe = pendingEntryRecipe || { root: room.id, steps: [] };
      forceStartEntry = false;
      pendingEntryRecipe = null;
      lastLevelId = normalized;
    }

    function recordTrail() {
      observeRoomTransition();
      const room = rooms.get(currentLevelId());
      const player = mainPlayer();
      if (!room || !player) return;
      room.visited = true;
      room.trail.add(Math.round(Number(player.x) || 0) + "," + Math.round(Number(player.y) || 0));
      renderMap();
      syncAssistButtons();
      checkCompletion();
    }

    function currentPlayData() {
      const runtime = app();
      if (!runtime?.state) return null;
      const actors = typeof runtime.cloneActorStateList === "function"
        ? runtime.cloneActorStateList(runtime.state.actors)
        : clone(runtime.state.actors || []);
      return {
        actors: (actors || []).filter((actor) => !actor.removed),
        gameId: "maze",
        height: runtime.state.height,
        levelId: runtime.currentLevelId,
        terrain: typeof runtime.cloneTerrainState === "function"
          ? runtime.cloneTerrainState(runtime.state.terrain)
          : clone(runtime.state.terrain),
        width: runtime.state.width
      };
    }

    function analysisSignature(room, playData) {
      const stateText = JSON.stringify({ actors: playData.actors, terrain: playData.terrain });
      let hash = 2166136261;
      for (let index = 0; index < stateText.length; index += 1) {
        hash ^= stateText.charCodeAt(index);
        hash = Math.imul(hash, 16777619);
      }
      return room.currentEntry + "@" + collectedCount() + "@" + (hash >>> 0).toString(36);
    }

    function resetWorker() {
      worker?.terminate();
      worker = null;
      if (activeWorkerJob) {
        activeWorkerJob.resolve(null);
        activeWorkerJob = null;
      }
    }

    function ensureWorker() {
      if (worker) return worker;
      worker = new Worker(options.workerUrl || "/world-solver-worker.js");
      worker.onmessage = (event) => {
        const message = event.data || {};
        if (!activeWorkerJob || message.id !== activeWorkerJob.id) return;
        if (message.type === "progress") {
          const phase = message.phase === "gems" ? "gem routes" : "reachable space";
          const expanded = Number(message.expanded || 0);
          const progress = message.phase === "gems"
            ? 22
            : Math.min(92, 35 + 57 * (1 - Math.exp(-expanded / 45000)));
          renderDockProgress(progress);
          setStatus(
            "Scanning " + activeWorkerJob.roomLabel + " · " + phase +
            " · " + expanded.toLocaleString() + " states"
          );
          return;
        }
        const job = activeWorkerJob;
        activeWorkerJob = null;
        job.resolve(message.type === "done" ? message.result || null : null);
      };
      worker.onerror = () => resetWorker();
      return worker;
    }

    function analyzeInWorker(room, playData, gemTargets, positionTargets) {
      if (!playData || stopped) return Promise.resolve(null);
      if (activeWorkerJob) resetWorker();
      const id = ++workerJobId;
      return new Promise((resolve) => {
        activeWorkerJob = { id, roomLabel: room.label, resolve };
        ensureWorker().postMessage({
          type: "analyze_room",
          id,
          playData,
          gemTargets,
          positionTargets,
          maxExpandedStates: options.maxExpandedStates || Number.MAX_SAFE_INTEGER
        });
      });
    }

    async function waitForIdle(version, timeoutMs = 7000) {
      const started = performance.now();
      while (version === loopVersion && performance.now() - started < timeoutMs) {
        const runtime = app();
        if (
          runtime &&
          !runtime.isAnimating &&
          !runtime.isPlanningWorldAction &&
          !runtime.isTransitioningLevel &&
          !runtime.levelTransition &&
          !runtime.queuedAction
        ) return true;
        await new Promise((resolve) => setTimeout(resolve, 45));
      }
      return false;
    }

    async function executePath(path, version) {
      for (const label of String(path || "")) {
        if (!running || stopped || version !== loopVersion) return false;
        const moved = await options.moveDirection?.(label);
        if (moved === false) return false;
        await waitForIdle(version);
        recordTrail();
      }
      return true;
    }

    function maxRoomElevation(playData) {
      let maximum = 0;
      for (const row of playData?.terrain || []) {
        for (const cell of row || []) {
          maximum = Math.max(maximum, Number(cell?.elevation || 0));
          for (const layer of cell?.layers || []) maximum = Math.max(maximum, Number(layer?.elevation || 0));
        }
      }
      for (const actor of playData?.actors || []) maximum = Math.max(maximum, Number(actor?.elevation || 0));
      return Math.max(0, Math.min(16, Math.floor(maximum)));
    }

    function analysisTargets(room, playData) {
      const gemTargets = (playData.actors || [])
        .filter((actor) => actor?.type === "gem" && !actor.removed)
        .map((actor, index) => ({
          ...clone(actor),
          id: "gem:" + index + ":" + actor.x + "," + actor.y + "," + Number(actor.elevation || 0),
          kind: "gem"
        }));
      const positionTargets = [];
      const maxElevation = maxRoomElevation(playData);
      for (let elevation = 0; elevation <= maxElevation; elevation += 1) {
        for (let y = 0; y < playData.height; y += 1) {
          for (let x = 0; x < playData.width; x += 1) {
            positionTargets.push({ id: "cell:" + x + "," + y + "," + elevation, kind: "cell", x, y, elevation });
          }
        }
      }
      for (const direction of DIRECTIONS) {
        const neighbor = roomNeighbor(room.id, direction);
        if (!neighbor) continue;
        const length = direction.dx === 0 ? playData.width : playData.height;
        for (let value = 0; value < length; value += 1) {
          for (let elevation = 0; elevation <= maxElevation; elevation += 1) {
            const x = direction.dx < 0 ? 0 : direction.dx > 0 ? playData.width - 1 : value;
            const y = direction.dy < 0 ? 0 : direction.dy > 0 ? playData.height - 1 : value;
            positionTargets.push({
              id: "exit:" + direction.id + ":" + x + "," + y + "," + elevation,
              kind: "exit",
              direction: direction.id,
              directionLabel: direction.label,
              directionShort: direction.short,
              neighbor,
              x,
              y,
              elevation
            });
          }
        }
      }
      return { gemTargets, positionTargets };
    }

    async function analyzeRoom(room, version) {
      const playData = currentPlayData();
      if (!playData) return null;
      const signature = analysisSignature(room, playData);
      const cached = room.analyses.get(signature);
      if (cached) {
        beginDockRun(room.label + " · saved search");
        room.analysis = cached;
        renderDockProgress(100);
        renderMap();
        setStatus(analysisSummary(room, cached));
        await new Promise((resolve) => window.setTimeout(resolve, 320));
        return cached;
      }
      const targets = analysisTargets(room, playData);
      room.analysis = { phase: "running", signature, reachableCells: [], reachableExits: [], gemResults: [] };
      renderMap();
      beginDockRun(room.label + " · exhaustive search");
      setStatus("Scanning every reachable state in " + room.label + "…");
      const result = await analyzeInWorker(room, playData, targets.gemTargets, targets.positionTargets);
      if (!running || version !== loopVersion || !result) return null;
      const reachablePositions = result.positionResult?.reachable || [];
      room.analysis = {
        phase: "done",
        signature,
        entry: room.currentEntry,
        collected: collectedCount(),
        recipe: clone(room.currentRecipe || { root: room.id, steps: [] }),
        exhaustive: result.exhaustive === true,
        expanded:
          Number(result.positionResult?.expanded || 0) +
          (result.gemResults || []).reduce((sum, entry) => sum + Number(entry.expanded || 0), 0),
        gemResults: result.gemResults || [],
        reachableCells: reachablePositions.filter((target) => target.kind === "cell"),
        reachableExits: reachablePositions.filter((target) => target.kind === "exit")
      };
      if (room.analysis.exhaustive) {
        room.analyzedSignatures.add(signature);
        room.analyses.set(signature, room.analysis);
      }
      renderDockProgress(100);
      renderMap();
      setStatus(analysisSummary(room, room.analysis));
      await new Promise((resolve) => window.setTimeout(resolve, 420));
      return room.analysis;
    }

    function analysisSummary(room, analysis) {
      const reachableGems = analysis.gemResults.filter((result) => result.status === "solved").length;
      const exits = new Map();
      for (const target of analysis.reachableExits) {
        exits.set(target.directionShort, (exits.get(target.directionShort) || 0) + 1);
      }
      const exitText = Array.from(exits.entries()).map(([side, count]) => side + " " + count).join(" · ") || "none";
      return room.label + " · " + Number(analysis.expanded || 0).toLocaleString() + " states · " +
        analysis.reachableCells.length + " positions · " + reachableGems + "/" +
        analysis.gemResults.length + " gems · exits " + exitText;
    }

    function transitionAttemptKey(room, analysis, target) {
      return analysis.signature + ">" + target.id;
    }

    function chooseExitRoute(room, analysis) {
      return analysis.reachableExits
        .filter((target) => {
          const key = transitionAttemptKey(room, analysis, target);
          return !room.failedExitTargets.has(key) && !room.attemptedTransitions.has(key);
        })
        .sort((left, right) => {
          const leftRoom = rooms.get(left.neighbor);
          const rightRoom = rooms.get(right.neighbor);
          const leftPriority = leftRoom?.visited ? 1 : 0;
          const rightPriority = rightRoom?.visited ? 1 : 0;
          return leftPriority - rightPriority || left.moves - right.moves;
        })[0] || null;
    }

    async function followAnalysis(room, analysis, version) {
      const gemRoute = analysis.gemResults
        .filter((result) => result.status === "solved")
        .sort((left, right) => left.moves - right.moves)[0];
      if (gemRoute) {
        if (pathElement) pathElement.textContent = gemRoute.path || "(empty)";
        setStatus("Gem route found in " + room.label + " · " + gemRoute.moves + " moves");
        return (await executePath(gemRoute.path, version)) ? "changed" : "stopped";
      }

      const exit = chooseExitRoute(room, analysis);
      if (!exit) return "exhausted";
      const key = transitionAttemptKey(room, analysis, exit);
      const direction = DIRECTIONS.find((entry) => entry.id === exit.direction);
      room.attemptedTransitions.add(key);
      setStatus(
        "Opening " + exit.directionShort + " edge to " +
        String(exit.neighbor).replace("level_", "") + " · " + exit.moves + " moves"
      );
      if (pathElement) pathElement.textContent = exit.path + (direction?.label || "");
      if (!(await executePath(exit.path, version))) return "stopped";
      const before = currentLevelId();
      pendingEntryRecipe = {
        root: analysis.recipe?.root || room.id,
        steps: [
          ...(analysis.recipe?.steps || []),
          { from: room.id, path: exit.path, directionLabel: direction?.label, to: exit.neighbor }
        ]
      };
      await options.moveDirection?.(direction?.label);
      await waitForIdle(version, 12000);
      recordTrail();
      if (currentLevelId() !== before) return "changed";
      pendingEntryRecipe = null;
      room.failedExitTargets.add(key);
      room.analysis = null;
      return "retry";
    }

    async function jumpToRoom(levelId, version) {
      if (currentLevelId() === levelId) {
        const alternate = Array.from(rooms.values()).find((room) => room.visited && room.id !== levelId);
        if (!alternate) {
          forceStartEntry = false;
          pendingEntryRecipe = null;
          return true;
        }
        forceStartEntry = true;
        pendingEntryRecipe = { root: alternate.id, steps: [] };
        await options.gotoLevel?.(alternate.id);
        await waitForIdle(version, 12000);
        recordTrail();
      }
      forceStartEntry = true;
      pendingEntryRecipe = { root: levelId, steps: [] };
      const result = await options.gotoLevel?.(levelId);
      await waitForIdle(version, 12000);
      recordTrail();
      return result !== false && currentLevelId() === levelId;
    }

    async function restoreAnalysis(room, analysis, version) {
      const recipe = analysis.recipe || { root: room.id, steps: [] };
      setStatus("Restoring a saved frontier in " + room.label + "…");
      if (!(await jumpToRoom(recipe.root, version))) return false;
      for (const step of recipe.steps || []) {
        if (currentLevelId() !== step.from) return false;
        if (!(await executePath(step.path, version))) return false;
        pendingEntryRecipe = {
          root: recipe.root,
          steps: (recipe.steps || []).slice(0, (recipe.steps || []).indexOf(step) + 1)
        };
        await options.moveDirection?.(step.directionLabel);
        await waitForIdle(version, 12000);
        recordTrail();
        if (currentLevelId() !== step.to) return false;
      }
      room.analysis = analysis;
      return currentLevelId() === room.id;
    }

    async function visitStoredFrontier(currentRoom, version) {
      const candidates = [];
      for (const room of rooms.values()) {
        for (const analysis of room.analyses.values()) {
          if (analysis.collected !== collectedCount()) continue;
          const exit = chooseExitRoute(room, analysis);
          if (!exit) continue;
          candidates.push({ room, analysis, exit, priority: rooms.get(exit.neighbor)?.visited ? 1 : 0 });
        }
      }
      candidates.sort((left, right) => left.priority - right.priority || left.exit.moves - right.exit.moves);
      const target = candidates[0];
      if (!target || (target.room === currentRoom && target.analysis === currentRoom.analysis)) return false;
      return restoreAnalysis(target.room, target.analysis, version);
    }

    async function visitUnanalyzedStartRoom(currentRoom, version) {
      if (typeof options.gotoLevel !== "function") return false;
      const target = Array.from(rooms.values()).find((room) =>
        room.id !== currentRoom.id &&
        room.visited &&
        !Array.from(room.analyses.values()).some(
          (analysis) => analysis.entry === "start" && analysis.collected === collectedCount()
        )
      );
      if (!target) return false;
      setStatus("Checking " + target.label + " from its start position…");
      return jumpToRoom(target.id, version);
    }

    async function plannerLoop(version) {
      await waitForIdle(version, 12000);
      while (running && !stopped && version === loopVersion) {
        recordTrail();
        const room = rooms.get(currentLevelId());
        if (!room) {
          pause("This room is not part of the world map.");
          return;
        }
        const visitedCount = Array.from(rooms.values()).filter((entry) => entry.visited).length;
        if (collectedCount() >= totalGems() && totalGems() > 0 && visitedCount === rooms.size) {
          await finish();
          return;
        }
        const analysis = await analyzeRoom(room, version);
        if (!analysis || !running || version !== loopVersion) return;
        if (!analysis.exhaustive) {
          pause("The room search stopped before exhaustion. Resume to retry it.");
          return;
        }
        const outcome = await followAnalysis(room, analysis, version);
        if (outcome === "changed" || outcome === "retry") continue;
        if (outcome === "stopped") return;
        if (await visitStoredFrontier(room, version)) continue;
        if (await visitUnanalyzedStartRoom(room, version)) continue;

        const missingRooms = Array.from(rooms.values()).filter((entry) => !entry.visited).length;
        const missingGems = Math.max(0, totalGems() - collectedCount());
        declareImpossible(
          "Exhaustive search complete · " +
          missingRooms + " unreachable room" + (missingRooms === 1 ? "" : "s") + " · " +
          missingGems + " unreachable gem" + (missingGems === 1 ? "" : "s")
        );
        return;
      }
    }

    function setStatus(message) {
      if (statusElement) statusElement.textContent = message || "";
      options.onStatus?.(message || "");
    }

    function renderMap() {
      const visitedCount = Array.from(rooms.values()).filter((room) => room.visited).length;
      if (collectedCount() !== lastCollectedCount) {
        lastCollectedCount = collectedCount();
        options.onProgress?.({
          collectedGems: collectedCount(),
          totalGems: totalGems(),
          visitedRooms: visitedCount,
          totalRooms: rooms.size
        });
      }
    }

    function liveRoomGems() {
      return (app()?.state?.actors || [])
        .filter((actor) => actor?.type === "gem" && !actor.removed)
        .map((actor, index) => ({
          ...clone(actor),
          id: "gem:" + index + ":" + actor.x + "," + actor.y + "," + Number(actor.elevation || 0),
          kind: "gem"
        }));
    }

    function syncAssistButtons() {
      if (findGemButton) findGemButton.disabled = running || stopped || completed || liveRoomGems().length === 0;
      if (findLocationButton) {
        findLocationButton.disabled = running || stopped || completed;
        findLocationButton.setAttribute("aria-pressed", selectingLocation ? "true" : "false");
      }
    }

    function clearLocationHover() {
      app()?.threeRenderer?.setEditorHoverTarget?.(null);
    }

    function checkCompletion() {
      if (completed || stopped) return false;
      const gemTotal = totalGems();
      if (gemTotal > 0 && collectedCount() >= gemTotal) {
        finish();
        return true;
      }
      return false;
    }

    function formatElapsed(ms) {
      const seconds = Math.max(0, ms) / 1000;
      if (seconds < 60) return seconds.toFixed(1) + "s";
      return Math.floor(seconds / 60) + "m " + String(Math.floor(seconds % 60)).padStart(2, "0") + "s";
    }

    function updateDockElapsed() {
      if (elapsedElement) elapsedElement.textContent = formatElapsed(performance.now() - dockStartedAt);
    }

    function beginDockRun(label) {
      dockTerminal = false;
      selectingLocation = false;
      clearLocationHover();
      root?.classList.remove("is-failed");
      if (pathElement) pathElement.textContent = "";
      renderDockProgress(0);
      setStatus((label ? label + " · " : "") + "starting search...");
      if (pauseButton) {
        pauseButton.hidden = false;
        pauseButton.disabled = false;
        pauseButton.textContent = "Cancel";
      }
      syncAssistButtons();
      dockStartedAt = performance.now();
      window.clearInterval(dockTickTimer);
      updateDockElapsed();
      dockTickTimer = window.setInterval(updateDockElapsed, 100);
    }

    function setDockIdle(message, options = {}) {
      running = false;
      window.clearInterval(dockTickTimer);
      if (!options.preserveResult) {
        renderDockProgress(0);
        if (pathElement) pathElement.textContent = "";
        if (elapsedElement) elapsedElement.textContent = "0.0s";
      } else {
        updateDockElapsed();
      }
      if (pauseButton) pauseButton.hidden = true;
      setStatus(message || "Choose what the solver should find.");
      syncAssistButtons();
    }

    async function runTargetSearch(gemTargets, label, reachedLabel) {
      if (running || stopped || completed) return false;
      const room = rooms.get(currentLevelId());
      const playData = currentPlayData();
      if (!room || !playData || !Array.isArray(gemTargets) || gemTargets.length === 0) {
        setDockIdle("Nothing to search for in this room.");
        return false;
      }

      running = true;
      const version = ++loopVersion;
      beginDockRun(label);
      const result = await analyzeInWorker(room, playData, gemTargets, []);
      if (!running || stopped || completed || version !== loopVersion) return false;
      if (!result) {
        root?.classList.add("is-failed");
        setDockIdle("The search stopped unexpectedly. Try again.", { preserveResult: true });
        return false;
      }

      const routes = (result.gemResults || []).filter((entry) => entry.status === "solved");
      routes.sort((left, right) => Number(left.moves || 0) - Number(right.moves || 0));
      const route = routes[0];
      const expanded = (result.gemResults || []).reduce(
        (sum, entry) => sum + Number(entry.expanded || 0),
        0
      );
      renderDockProgress(100);

      if (!route) {
        root?.classList.add("is-failed");
        setDockIdle(
          label + " · no route found after " + expanded.toLocaleString() + " states.",
          { preserveResult: true }
        );
        return false;
      }

      if (pathElement) pathElement.textContent = route.path || "(already there)";
      setStatus(label + " · " + route.moves + " move" + (route.moves === 1 ? "" : "s") + ".");
      const followed = await executePath(route.path, version);
      if (!running || stopped || completed || version !== loopVersion) return false;
      setDockIdle(
        followed ? (reachedLabel || "Target reached.") : "The route was interrupted.",
        { preserveResult: true }
      );
      checkCompletion();
      return followed;
    }

    function findGem() {
      const gems = liveRoomGems();
      if (gems.length === 0) {
        setDockIdle("No gems remain in this room.");
        return false;
      }
      return runTargetSearch(gems, "Finding nearest gem", "Gem reached.");
    }

    function toggleFindLocation() {
      if (running || stopped || completed) return;
      selectingLocation = !selectingLocation;
      locationTapStart = null;
      clearLocationHover();
      root?.classList.remove("is-failed");
      if (selectingLocation) {
        setDockIdle("Tap a tile in the level.");
      } else {
        setDockIdle("Choose what the solver should find.");
      }
    }

    function locationEventIsUi(event) {
      return Boolean(event.target?.closest?.(
        ".solver-dock,button,input,select,textarea,a,[role='dialog'],[aria-modal='true'],.modal,.overlay,.world-map-overlay"
      ));
    }

    function handleLocationPointerDown(event) {
      if (!selectingLocation || event.button !== 0 || locationEventIsUi(event)) return;
      locationTapStart = { x: event.clientX, y: event.clientY };
    }

    function locationTargetFromPointerEvent(event) {
      const runtime = app();
      const renderer = runtime?.threeRenderer;
      const pick = renderer?.pickEditorFace?.(
        event.clientX,
        event.clientY,
        runtime?.canvas
      );
      const x = Number(pick?.sourceX);
      const y = Number(pick?.sourceY);
      const elevation = Math.max(0, Math.floor(Number(
        pick?.sourceElevation ?? pick?.sourceLayer ?? pick?.elevation ?? 0
      ) || 0));
      const width = Number(runtime?.state?.width || 0);
      const height = Number(runtime?.state?.height || 0);
      if (
        !pick || pick.kind === "levelSwitch" || !Number.isInteger(x) || !Number.isInteger(y) ||
        x < 0 || y < 0 || x >= width || y >= height
      ) return null;
      return { elevation, pick, x, y };
    }

    function handleLocationPointerMove(event) {
      if (!selectingLocation) return;
      if (locationEventIsUi(event)) {
        clearLocationHover();
        return;
      }
      const target = locationTargetFromPointerEvent(event);
      app()?.threeRenderer?.setEditorHoverTarget?.(
        target ? { ...target.pick, dx: 0, dy: 0, face: "top" } : null
      );
    }

    function handleLocationPointerUp(event) {
      if (!selectingLocation || !locationTapStart) return;
      const start = locationTapStart;
      locationTapStart = null;
      if (locationEventIsUi(event) || Math.hypot(event.clientX - start.x, event.clientY - start.y) > 12) return;

      const target = locationTargetFromPointerEvent(event);
      if (!target) {
        clearLocationHover();
        setStatus("That is not a tile in the current room. Tap another tile.");
        return;
      }

      selectingLocation = false;
      clearLocationHover();
      syncAssistButtons();
      const syntheticGem = {
        id: "location:" + target.x + "," + target.y + "," + target.elevation,
        type: "gem",
        kind: "gem",
        x: target.x,
        y: target.y,
        elevation: target.elevation,
        removed: false
      };
      runTargetSearch(
        [syntheticGem],
        "Finding " + target.x + ", " + target.y,
        "Location reached."
      );
    }

    function renderDockProgress(percent) {
      const safePercent = Math.max(0, Math.min(100, Number(percent) || 0));
      if (barElement) barElement.style.width = safePercent.toFixed(1) + "%";
      trackElement?.setAttribute("aria-valuenow", String(Math.round(safePercent)));
    }

    function installUi() {
      if (root) return;
      const style = document.createElement("style");
      style.textContent = [
        ".solver-dock{backdrop-filter:blur(8px);background:rgba(5,8,18,.94);border:1px solid rgba(var(--cyan-rgb,84,240,255),.45);border-radius:14px;box-shadow:0 14px 40px rgba(0,0,0,.55),0 0 22px rgba(var(--cyan-rgb,84,240,255),.16);color:var(--ink,#e7eaff);display:grid;gap:9px;left:50%;opacity:0;padding:12px 14px;position:fixed;top:calc(var(--mazebench-topbar-height,64px) + 10px);transform:translateX(-50%) translateY(-14px);transition:opacity 200ms ease,transform 220ms ease;width:min(94vw,540px);z-index:86}",
        ".solver-dock.is-open{opacity:1;transform:translateX(-50%) translateY(0)}.solver-dock__head{align-items:center;display:flex;gap:8px}.solver-dock__title{font-family:var(--font-display,inherit);font-size:13px;font-weight:800;letter-spacing:.08em;text-transform:uppercase}.solver-dock__badge{background:rgba(var(--amber-rgb,255,193,84),.12);border:1px solid rgba(var(--amber-rgb,255,193,84),.65);border-radius:999px;color:var(--amber,#ffc154);font:10px var(--font-mono,monospace);letter-spacing:.1em;padding:2px 8px;text-transform:uppercase}.solver-dock__elapsed{color:var(--muted,#9aa3c7);font:11px var(--font-mono,monospace);margin-left:auto}",
        ".solver-dock__cancel{background:rgba(8,11,26,.85);border:1px solid rgba(var(--magenta-rgb,255,84,170),.55);border-radius:9px;color:var(--ink,#e7eaff);cursor:pointer;font:inherit;font-size:12px;font-weight:600;min-height:0;padding:4px 12px}.solver-dock__cancel:hover:not(:disabled){background:rgba(var(--magenta-rgb,255,84,170),.12);border-color:rgba(var(--magenta-rgb,255,84,170),.9);box-shadow:0 0 14px rgba(var(--magenta-rgb,255,84,170),.3)}.solver-dock__cancel:disabled{opacity:.7}.solver-dock__cancel[hidden]{display:none}",
        ".solver-dock__track{background:rgba(124,143,255,.14);border:1px solid rgba(124,143,255,.3);border-radius:999px;height:10px;overflow:hidden}.solver-dock__bar{background:linear-gradient(90deg,rgba(var(--cyan-rgb,84,240,255),.9),rgba(var(--violet-rgb,124,143,255),.9));border-radius:999px;box-shadow:0 0 12px rgba(var(--cyan-rgb,84,240,255),.5);height:100%;transition:width 120ms linear;width:0}.solver-dock__text{color:var(--ink,#e7eaff);font:11px var(--font-mono,monospace);margin:0}.solver-dock__path{color:var(--cyan,#54f0ff);font:11px/1.5 var(--font-mono,monospace);letter-spacing:.1em;overflow-wrap:anywhere;user-select:all}.solver-dock__path:empty{display:none}.solver-dock.is-failed{border-color:rgba(var(--magenta-rgb,255,84,170),.48);box-shadow:0 14px 40px rgba(0,0,0,.55),0 0 22px rgba(var(--magenta-rgb,255,84,170),.12)}",
        ".solver-dock__actions{align-items:center;display:flex;gap:7px}.solver-dock__playback{background:rgba(var(--cyan-rgb,84,240,255),.14);border:1px solid rgba(var(--cyan-rgb,84,240,255),.7);border-radius:9px;color:var(--ink,#e7eaff);cursor:pointer;font:inherit;font-size:12px;font-weight:750;min-height:34px;padding:6px 12px;transition:background 160ms ease,border-color 160ms ease,box-shadow 160ms ease}.solver-dock__playback:hover:not(:disabled),.solver-dock__playback:focus-visible{border-color:rgba(var(--cyan-rgb,84,240,255),1);box-shadow:0 0 14px rgba(var(--cyan-rgb,84,240,255),.27);outline:none}.solver-dock__playback[aria-pressed='true']{background:rgba(var(--cyan-rgb,84,240,255),.28);border-color:rgba(var(--cyan-rgb,84,240,255),1);box-shadow:0 0 14px rgba(var(--cyan-rgb,84,240,255),.25)}.solver-dock__playback:disabled{cursor:default;opacity:.48}"
      ].join("\n");
      document.head.append(style);
      root = document.createElement("section");
      root.className = "solver-dock";
      root.setAttribute("aria-label", "World Solver run");
      root.innerHTML = '<div class="solver-dock__head"><span class="solver-dock__title">Solver</span><span class="solver-dock__badge">Experimental</span><span class="solver-dock__elapsed">0.0s</span><button class="solver-dock__cancel" type="button" data-world-solver-pause hidden>Cancel</button></div><div class="solver-dock__track" role="progressbar" aria-label="Solver search progress" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0"><div class="solver-dock__bar"></div></div><p class="solver-dock__text" aria-live="polite">Choose what the solver should find.</p><code class="solver-dock__path"></code><div class="solver-dock__actions"><button class="solver-dock__playback" type="button" data-world-solver-find-gem>Find Gem</button><button class="solver-dock__playback" type="button" aria-pressed="false" data-world-solver-find-location>Find Location</button></div>';
      document.body.append(root);
      statusElement = root.querySelector(".solver-dock__text");
      barElement = root.querySelector(".solver-dock__bar");
      trackElement = root.querySelector(".solver-dock__track");
      pathElement = root.querySelector(".solver-dock__path");
      elapsedElement = root.querySelector(".solver-dock__elapsed");
      pauseButton = root.querySelector("[data-world-solver-pause]");
      findGemButton = root.querySelector("[data-world-solver-find-gem]");
      findLocationButton = root.querySelector("[data-world-solver-find-location]");
      pauseButton.addEventListener("click", () => {
        if (running) pause("Solver canceled.");
        else if (dockTerminal) {
          root?.classList.remove("is-open");
          window.setTimeout(() => { if (root) root.hidden = true; }, 240);
        }
      });
      findGemButton.addEventListener("click", findGem);
      findLocationButton.addEventListener("click", toggleFindLocation);
      window.requestAnimationFrame(() => root?.classList.add("is-open"));
      renderMap();
      setDockIdle("Choose what the solver should find.");
    }

    function pause(message) {
      if (stopped || completed) return;
      running = false;
      selectingLocation = false;
      clearLocationHover();
      loopVersion += 1;
      resetWorker();
      window.clearInterval(dockTickTimer);
      setDockIdle(message || "Solver canceled.", { preserveResult: true });
    }

    function declareImpossible(message) {
      running = false;
      loopVersion += 1;
      resetWorker();
      dockTerminal = true;
      window.clearInterval(dockTickTimer);
      renderDockProgress(100);
      root?.classList.add("is-failed");
      if (pauseButton) {
        pauseButton.textContent = "Dismiss";
        pauseButton.hidden = false;
        pauseButton.disabled = false;
      }
      syncAssistButtons();
      setStatus(message || "Exhaustive search proved this world impossible.");
      options.onImpossible?.({ collectedGems: collectedCount(), totalGems: totalGems(), rooms });
    }

    function resume() {
      if (stopped || completed || running) return;
      setDockIdle("Choose Find Gem or Find Location.");
    }

    async function finish() {
      if (completed) return;
      completed = true;
      running = false;
      selectingLocation = false;
      clearLocationHover();
      loopVersion += 1;
      resetWorker();
      dockTerminal = true;
      window.clearInterval(dockTickTimer);
      renderDockProgress(100);
      if (pauseButton) {
        pauseButton.disabled = false;
        pauseButton.textContent = "Dismiss";
        pauseButton.hidden = false;
      }
      syncAssistButtons();
      setStatus("All gems collected. Ready to verify the complete replay.");
      renderMap();
      await options.onComplete?.({ collectedGems: collectedCount(), totalGems: totalGems(), rooms });
    }

    function stop() {
      if (stopped) return;
      stopped = true;
      running = false;
      selectingLocation = false;
      clearLocationHover();
      loopVersion += 1;
      resetWorker();
      window.clearInterval(trailTimer);
      window.clearInterval(dockTickTimer);
      document.removeEventListener("keydown", handleManualInput, true);
      document.removeEventListener("pointerdown", handleManualInput, true);
      document.removeEventListener("pointerdown", handleLocationPointerDown, true);
      document.removeEventListener("pointermove", handleLocationPointerMove, true);
      document.removeEventListener("pointerup", handleLocationPointerUp, true);
      root?.remove();
      options.onExit?.();
    }

    function handleManualInput(event) {
      if (!running || !event.isTrusted || event.target?.closest?.(".solver-dock")) return;
      const movementKey = ["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"].includes(event.key);
      const movementControl = event.target?.closest?.("[data-move]");
      if (movementKey || movementControl) pause("Solver canceled. Manual control is active.");
    }

    function start() {
      installUi();
      observeRoomTransition();
      recordTrail();
      document.addEventListener("keydown", handleManualInput, true);
      document.addEventListener("pointerdown", handleManualInput, true);
      document.addEventListener("pointerdown", handleLocationPointerDown, true);
      document.addEventListener("pointermove", handleLocationPointerMove, true);
      document.addEventListener("pointerup", handleLocationPointerUp, true);
      trailTimer = window.setInterval(recordTrail, 180);
      setDockIdle("Choose Find Gem or Find Location.");
      return controller;
    }

    const controller = { start, pause, resume, stop, findGem, toggleFindLocation, rooms, renderMap };
    return controller;
  }

  global.WorldSolver = { countCellGems, createController, levelCoordinates, normalizeLevelId };
})(typeof window !== "undefined" ? window : self);
