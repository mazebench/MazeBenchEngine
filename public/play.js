(function () {
  const playData = window.__PLAY_DATA__;
  const canvas = document.getElementById("maze-canvas");

  if (!playData || !canvas) {
    return;
  }

  const state = {
    width: playData.width,
    height: playData.height,
    terrain: playData.terrain,
    actors: playData.actors.map((actor) => ({ ...actor }))
  };

  const imageUrls = new Set();
  state.terrain.forEach((row) => {
    row.forEach((cell) => {
      if (cell.imageUrl) {
        imageUrls.add(cell.imageUrl);
      }
    });
  });
  state.actors.forEach((actor) => {
    if (actor.imageUrl) {
      imageUrls.add(actor.imageUrl);
    }
  });

  const imageCache = new Map();
  const ctx = canvas.getContext("2d");
  const boardRect = {
    width: state.width * 64,
    height: state.height * 64
  };

  function posKey(x, y) {
    return `${x},${y}`;
  }

  function isInsideBoard(x, y) {
    return x >= 0 && x < state.width && y >= 0 && y < state.height;
  }

  function terrainAt(x, y) {
    return state.terrain[y]?.[x] || { type: "empty", label: "Empty", imageUrl: null };
  }

  function isWall(x, y) {
    return terrainAt(x, y).type === "wall";
  }

  function setupCanvas() {
    const dpr = window.devicePixelRatio || 1;
    canvas.width = boardRect.width * dpr;
    canvas.height = boardRect.height * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    canvas.style.aspectRatio = `${state.width} / ${state.height}`;
  }

  function preloadImages() {
    return Promise.all(
      Array.from(imageUrls).map((url) => {
        return new Promise((resolve) => {
          const image = new Image();
          image.onload = function () {
            imageCache.set(url, image);
            resolve();
          };
          image.onerror = function () {
            imageCache.set(url, null);
            resolve();
          };
          image.src = url;
        });
      })
    );
  }

  function roundRectPath(x, y, width, height, radii) {
    ctx.beginPath();
    ctx.moveTo(x + radii.tl, y);
    ctx.lineTo(x + width - radii.tr, y);
    ctx.quadraticCurveTo(x + width, y, x + width, y + radii.tr);
    ctx.lineTo(x + width, y + height - radii.br);
    ctx.quadraticCurveTo(x + width, y + height, x + width - radii.br, y + height);
    ctx.lineTo(x + radii.bl, y + height);
    ctx.quadraticCurveTo(x, y + height, x, y + height - radii.bl);
    ctx.lineTo(x, y + radii.tl);
    ctx.quadraticCurveTo(x, y, x + radii.tl, y);
    ctx.closePath();
  }

  function paintFloorTile(x, y, cell) {
    const tileSize = 64;
    const left = x * tileSize;
    const top = y * tileSize;
    const image = cell.imageUrl ? imageCache.get(cell.imageUrl) : null;

    if (image) {
      ctx.drawImage(image, left, top, tileSize, tileSize);
      return;
    }

    ctx.fillStyle = "#cdb18d";
    ctx.fillRect(left, top, tileSize, tileSize);

    ctx.strokeStyle = "rgba(126, 94, 58, 0.22)";
    ctx.lineWidth = 1;
    ctx.strokeRect(left + 0.5, top + 0.5, tileSize - 1, tileSize - 1);
  }

  function paintWallTile(x, y, cell) {
    const tileSize = 64;
    const left = x * tileSize;
    const top = y * tileSize;
    const image = cell.imageUrl ? imageCache.get(cell.imageUrl) : null;

    if (image) {
      ctx.drawImage(image, left, top, tileSize, tileSize);
      return;
    }

    const radius = tileSize * 0.18;
    const radii = {
      tl: !isWall(x, y - 1) && !isWall(x - 1, y) ? radius : 0,
      tr: !isWall(x, y - 1) && !isWall(x + 1, y) ? radius : 0,
      br: !isWall(x, y + 1) && !isWall(x + 1, y) ? radius : 0,
      bl: !isWall(x, y + 1) && !isWall(x - 1, y) ? radius : 0
    };

    roundRectPath(left, top, tileSize, tileSize, radii);
    ctx.fillStyle = "#262b34";
    ctx.fill();

    if (y < state.height - 1 && !isWall(x, y + 1)) {
      ctx.fillStyle = "rgba(255, 255, 255, 0.06)";
      roundRectPath(left + 1.5, top + tileSize * 0.78, tileSize - 3, tileSize * 0.18, {
        tl: 0,
        tr: 0,
        br: Math.max(0, radii.br - 1.5),
        bl: Math.max(0, radii.bl - 1.5)
      });
      ctx.fill();
    }
  }

  function paintExit(x, y, cell) {
    paintFloorTile(x, y, cell);

    const tileSize = 64;
    const left = x * tileSize + tileSize / 2;
    const top = y * tileSize + tileSize / 2;
    const image = cell.imageUrl ? imageCache.get(cell.imageUrl) : null;

    if (image) {
      ctx.drawImage(image, x * tileSize, y * tileSize, tileSize, tileSize);
      return;
    }

    ctx.fillStyle = "#8d412d";
    ctx.beginPath();
    ctx.arc(left, top, tileSize * 0.18, 0, Math.PI * 2);
    ctx.fill();

    ctx.fillStyle = "#c96d4e";
    ctx.beginPath();
    ctx.arc(left, top, tileSize * 0.12, 0, Math.PI * 2);
    ctx.fill();
  }

  function paintTerrain() {
    for (let y = 0; y < state.height; y += 1) {
      for (let x = 0; x < state.width; x += 1) {
        const cell = terrainAt(x, y);

        if (cell.type === "wall") {
          continue;
        }

        if (cell.type === "exit") {
          paintExit(x, y, cell);
          continue;
        }

        paintFloorTile(x, y, cell);
      }
    }

    for (let y = 0; y < state.height; y += 1) {
      for (let x = 0; x < state.width; x += 1) {
        const cell = terrainAt(x, y);
        if (cell.type === "wall") {
          paintWallTile(x, y, cell);
        }
      }
    }
  }

  function paintActor(actor) {
    const tileSize = 64;
    const left = actor.x * tileSize;
    const top = actor.y * tileSize;
    const image = actor.imageUrl ? imageCache.get(actor.imageUrl) : null;

    if (image) {
      ctx.drawImage(image, left, top, tileSize, tileSize);
      return;
    }

    if (actor.type === "player") {
      ctx.fillStyle = "#2d6637";
      ctx.beginPath();
      ctx.arc(left + tileSize / 2, top + tileSize / 2, tileSize * 0.26, 0, Math.PI * 2);
      ctx.fill();

      ctx.fillStyle = "#6ba562";
      ctx.beginPath();
      ctx.arc(left + tileSize / 2, top + tileSize / 2, tileSize * 0.21, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  function render() {
    ctx.clearRect(0, 0, boardRect.width, boardRect.height);
    paintTerrain();
    state.actors.forEach(paintActor);
  }

  function canMoveInto(x, y, occupied) {
    if (!isInsideBoard(x, y)) {
      return false;
    }

    if (isWall(x, y)) {
      return false;
    }

    return !occupied.has(posKey(x, y));
  }

  function sortActorsForMove(dx, dy) {
    return function (left, right) {
      if (dx > 0) {
        return right.x - left.x || left.y - right.y;
      }
      if (dx < 0) {
        return left.x - right.x || left.y - right.y;
      }
      if (dy > 0) {
        return right.y - left.y || left.x - right.x;
      }
      return left.y - right.y || left.x - right.x;
    };
  }

  function movePlayers(dx, dy) {
    const players = state.actors.filter((actor) => actor.type === "player");
    const occupied = new Set(state.actors.map((actor) => posKey(actor.x, actor.y)));
    const orderedPlayers = players.slice().sort(sortActorsForMove(dx, dy));
    let changed = false;

    orderedPlayers.forEach((player) => {
      occupied.delete(posKey(player.x, player.y));

      const nextX = player.x + dx;
      const nextY = player.y + dy;

      if (canMoveInto(nextX, nextY, occupied)) {
        player.x = nextX;
        player.y = nextY;
        changed = true;
      }

      occupied.add(posKey(player.x, player.y));
    });

    if (changed) {
      render();
    }
  }

  function handleKeydown(event) {
    const moves = {
      ArrowUp: [0, -1],
      ArrowDown: [0, 1],
      ArrowLeft: [-1, 0],
      ArrowRight: [1, 0]
    };

    if (!moves[event.key]) {
      return;
    }

    event.preventDefault();
    const [dx, dy] = moves[event.key];
    movePlayers(dx, dy);
  }

  function preventScroll(event) {
    event.preventDefault();
  }

  setupCanvas();
  preloadImages().finally(render);
  window.addEventListener("keydown", handleKeydown);
  window.addEventListener("wheel", preventScroll, { passive: false });
  window.addEventListener("resize", function () {
    setupCanvas();
    render();
  });
})();
