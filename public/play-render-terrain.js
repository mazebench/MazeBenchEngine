(function () {
  const modules = window.PlayModules || (window.PlayModules = {});

  modules.registerRenderTerrainFunctions = function registerRenderTerrainFunctions(app) {
    const {
      state,
      TILE_SIZE,
      PLAYER_LIFT_ARROW_URL,
      sceneCtx,
      imageCache
    } = app;
    const {
      clamp,
      groundSurfaceCell,
      isGroundCell,
      terrainAt,
      isHole,
      isPlayerGate,
      isPlayerLift,
      isOrangeWall,
      gateLiftAt,
      playerLiftAt,
      orangeWallLiftAt,
      isTerrainWall,
      isTerrainWallAcrossHorizontalWorldEdge,
      elevatedSideBleedCoverFamily,
      weightlessGroupRenderState,
      floatingFloorHoverOffset
    } = app;

    function roundRectPath(context, x, y, width, height, radii) {
      context.beginPath();
      context.moveTo(x + radii.tl, y);
      context.lineTo(x + width - radii.tr, y);
      context.quadraticCurveTo(x + width, y, x + width, y + radii.tr);
      context.lineTo(x + width, y + height - radii.br);
      context.quadraticCurveTo(x + width, y + height, x + width - radii.br, y + height);
      context.lineTo(x + radii.bl, y + height);
      context.quadraticCurveTo(x, y + height, x, y + height - radii.bl);
      context.lineTo(x, y + radii.tl);
      context.quadraticCurveTo(x, y, x + radii.tl, y);
      context.closePath();
    }

    function paintPlayerLiftArrow(context, left, top, rotation = 0) {
      const arrowImage = imageCache.get(PLAYER_LIFT_ARROW_URL);
      const centerX = left + TILE_SIZE * 0.5;
      const centerY = top + TILE_SIZE * 0.52;

      context.save();
      context.translate(centerX, centerY);
      context.rotate(rotation);

      if (arrowImage) {
        const drawHeight = TILE_SIZE * 0.44;
        const drawWidth = drawHeight * (arrowImage.width / arrowImage.height);
        context.drawImage(arrowImage, -drawWidth / 2, -drawHeight / 2, drawWidth, drawHeight);
        context.restore();
        return;
      }

      context.fillStyle = "#111111";
      context.beginPath();
      context.moveTo(0, -TILE_SIZE * 0.19);
      context.lineTo(TILE_SIZE * 0.14, TILE_SIZE * 0.06);
      context.lineTo(TILE_SIZE * 0.05, TILE_SIZE * 0.06);
      context.lineTo(TILE_SIZE * 0.05, TILE_SIZE * 0.19);
      context.lineTo(-TILE_SIZE * 0.05, TILE_SIZE * 0.19);
      context.lineTo(-TILE_SIZE * 0.05, TILE_SIZE * 0.06);
      context.lineTo(-TILE_SIZE * 0.14, TILE_SIZE * 0.06);
      context.closePath();
      context.fill();
      context.restore();
    }

    function elevatedBleedCoverColor(family) {
      if (family === "terrain:wall") {
        return "#23262c";
      }

      if (family === "terrain:player_gate") {
        return "#c75652";
      }

      if (family === "terrain:player_lift") {
        return "#8a63d2";
      }

      if (family === "terrain:orange_wall") {
        return "#b85f16";
      }

      if (family === "actor:player") {
        return "#4d8b52";
      }

      if (family === "actor:floating_floor") {
        return "#d6bd94";
      }

      if (family?.startsWith("actor:weightless_box:")) {
        return "#315991";
      }

      return null;
    }

    function paintElevatedSideBleedCover(
      context,
      x,
      y,
      dx,
      sideX,
      coverStartY,
      coverEndY,
      gateState = app.liveRaisedPlayerGates,
      transform = null
    ) {
      const family = elevatedSideBleedCoverFamily(x, y, dx, gateState);
      const coverColor = elevatedBleedCoverColor(family);

      if (!coverColor || coverEndY <= coverStartY) {
        return;
      }

      const coverWidth = 5;
      const coverPaddingY = 1;
      const coverOffsetY = 4;
      let rectLeft = sideX - coverWidth / 2;
      let rectTop = coverStartY - coverPaddingY + coverOffsetY;
      let rectWidth = coverWidth;
      let rectHeight = coverEndY - coverStartY + coverPaddingY * 2;

      if (transform) {
        const scale = transform.scale ?? 1;

        if (scale < 0.999) {
          return;
        }

        rectLeft = transform.centerX + (rectLeft - transform.centerX) * scale;
        rectTop = transform.centerY + (transform.sink ?? 0) + (rectTop - transform.centerY) * scale;
      }

      context.save();
      context.fillStyle = coverColor;
      context.fillRect(rectLeft, rectTop, rectWidth, rectHeight);
      context.restore();
    }

    function elevatedBleedCoverTieBreaker(family) {
      if (family === "actor:player") {
        return 2.5;
      }

      if (family === "actor:floating_floor" || family?.startsWith("actor:weightless_box:")) {
        return 1.5;
      }

      return 0.5;
    }

    function elevatedBleedCoverHeight(family, x, y, now, faceHeight) {
      const lowerY = y + 1;

      if (family === "terrain:player_gate") {
        return faceHeight * gateLiftAt(x, lowerY, now);
      }

      if (family === "terrain:player_lift") {
        return faceHeight * playerLiftAt(x, lowerY, now);
      }

      if (family === "terrain:orange_wall") {
        return faceHeight * orangeWallLiftAt(x, lowerY, now);
      }

      if (family === "actor:floating_floor") {
        const lowerFloor = state.actors.find(
          (actor) => !actor.removed && actor.type === "floating_floor" && actor.x === x && actor.y === lowerY
        );

        return lowerFloor ? Math.max(0, floatingFloorHoverOffset(lowerFloor, now)) : 0;
      }

      return faceHeight;
    }

    function actorMatchesElevatedBleedCoverFamily(actor, family) {
      if (!actor || actor.removed) {
        return false;
      }

      if (family === "actor:player") {
        return actor.type === "player";
      }

      if (family === "actor:floating_floor") {
        return actor.type === "floating_floor";
      }

      if (family?.startsWith("actor:weightless_box:")) {
        const groupId = family.slice("actor:weightless_box:".length);
        return actor.type === "weightless_box" && (actor.groupId ?? "__ungrouped__") === groupId;
      }

      return false;
    }

    function actorAtElevatedBleedCoverPosition(family, position) {
      return state.actors.find(
        (candidate) =>
          candidate.x === position.x &&
          candidate.y === position.y &&
          actorMatchesElevatedBleedCoverFamily(candidate, family)
      );
    }

    function elevatedBleedCoverActorPlacement(family, x, y, positions) {
      if (!family?.startsWith("actor:")) {
        return {
          offset: { x: 0, y: 0 },
          depthOffset: 0,
          transform: null
        };
      }

      if (family.startsWith("actor:weightless_box:")) {
        const groupId = family.slice("actor:weightless_box:".length);
        const groupState = weightlessGroupRenderState(groupId);
        const surfaceLift = groupState.surfaceLift ?? 0;
        const liftedOffsetY = groupState.offsetY - surfaceLift;

        return {
          offset: { x: groupState.offsetX, y: liftedOffsetY },
          depthOffset: (groupState.offsetY + groupState.sink) / TILE_SIZE,
          transform: {
            centerX: groupState.centerX,
            centerY: groupState.centerY,
            scale: groupState.scale,
            sink: groupState.sink
          }
        };
      }

      let offsetX = 0;
      let offsetY = 0;
      let count = 0;

      positions.forEach((position) => {
        const actor = actorAtElevatedBleedCoverPosition(family, position);

        if (!actor) {
          return;
        }

        offsetX += ((actor.renderX ?? actor.x) - actor.x) * TILE_SIZE;
        offsetY += ((actor.renderY ?? actor.y) - actor.y) * TILE_SIZE;
        count += 1;
      });

      if (count === 0) {
        return {
          offset: { x: 0, y: 0 },
          depthOffset: 0,
          transform: null
        };
      }

      const lowerActor =
        actorAtElevatedBleedCoverPosition(family, { x, y: y + 1 }) ||
        actorAtElevatedBleedCoverPosition(family, positions[0]);
      const offset = {
        x: offsetX / count,
        y: offsetY / count
      };

      if (!lowerActor) {
        return {
          offset,
          depthOffset: offset.y / TILE_SIZE,
          transform: null
        };
      }

      const lowerOffsetX = ((lowerActor.renderX ?? lowerActor.x) - lowerActor.x) * TILE_SIZE;
      const lowerOffsetY = ((lowerActor.renderY ?? lowerActor.y) - lowerActor.y) * TILE_SIZE;
      const scale = lowerActor.renderScale ?? 1;
      const sink = lowerActor.renderSink ?? 0;

      return {
        offset,
        depthOffset: (offset.y + sink) / TILE_SIZE,
        transform: {
          centerX: lowerActor.x * TILE_SIZE + lowerOffsetX + TILE_SIZE / 2,
          centerY: lowerActor.y * TILE_SIZE + lowerOffsetY + TILE_SIZE,
          scale,
          sink
        }
      };
    }

    function queueElevatedSideBleedCoverItems(drawItems, now = performance.now()) {
      const faceHeight = Math.round(TILE_SIZE * 0.26);

      for (let y = 0; y < state.height - 1; y += 1) {
        for (let x = 0; x < state.width; x += 1) {
          [-1, 1].forEach((dx) => {
            const positions = [
              { x: x + dx, y },
              { x, y: y + 1 },
              { x: x + dx, y: y + 1 }
            ];
            const family = elevatedSideBleedCoverFamily(x, y, dx);

            if (!elevatedBleedCoverColor(family)) {
              return;
            }

            const sideX = (x + (dx > 0 ? 1 : 0)) * TILE_SIZE;
            const coverEndY = (y + 1) * TILE_SIZE;
            const coverHeight = elevatedBleedCoverHeight(family, x, y, now, faceHeight);
            const coverStartY = coverEndY - coverHeight;
            const placement = elevatedBleedCoverActorPlacement(family, x, y, positions);

            if (coverHeight <= 0.001) {
              return;
            }

            drawItems.push({
              depth: y + 2 + placement.depthOffset,
              tieBreaker: elevatedBleedCoverTieBreaker(family),
              order: drawItems.length,
              paint: function () {
                paintElevatedSideBleedCover(
                  sceneCtx,
                  x,
                  y,
                  dx,
                  sideX + placement.offset.x,
                  coverStartY + placement.offset.y,
                  coverEndY + placement.offset.y,
                  app.liveRaisedPlayerGates,
                  placement.transform
                );
              }
            });
          });
        }
      }
    }

    function paintFloorTile(x, y, cell) {
      const left = x * TILE_SIZE;
      const top = y * TILE_SIZE;
      const image = cell.imageUrl ? imageCache.get(cell.imageUrl) : null;

      if (image) {
        sceneCtx.drawImage(image, left, top, TILE_SIZE, TILE_SIZE);
        return;
      }

      if (cell.type === "hole") {
        sceneCtx.fillStyle = "#050608";
        sceneCtx.fillRect(left, top, TILE_SIZE, TILE_SIZE);
        return;
      }

      if (cell.type === "player_gate") {
        sceneCtx.fillStyle = "#c75652";
        sceneCtx.fillRect(left, top, TILE_SIZE, TILE_SIZE);
        sceneCtx.strokeStyle = "rgba(0, 0, 0, 0.18)";
        sceneCtx.lineWidth = 1.5;
        sceneCtx.strokeRect(left + 0.75, top + 0.75, TILE_SIZE - 1.5, TILE_SIZE - 1.5);
        return;
      }

      if (cell.type === "player_lift") {
        sceneCtx.fillStyle = "#8a63d2";
        sceneCtx.fillRect(left, top, TILE_SIZE, TILE_SIZE);
        sceneCtx.strokeStyle = "rgba(0, 0, 0, 0.2)";
        sceneCtx.lineWidth = 1.5;
        sceneCtx.strokeRect(left + 0.75, top + 0.75, TILE_SIZE - 1.5, TILE_SIZE - 1.5);
        paintPlayerLiftArrow(sceneCtx, left, top, 0);
        return;
      }

      if (cell.type === "orange_wall") {
        sceneCtx.fillStyle = "#b85f16";
        sceneCtx.fillRect(left, top, TILE_SIZE, TILE_SIZE);
        sceneCtx.strokeStyle = "rgba(0, 0, 0, 0.24)";
        sceneCtx.lineWidth = 1.5;
        sceneCtx.beginPath();

        if (!isOrangeWall(x, y - 1)) {
          sceneCtx.moveTo(left + 0.75, top + 0.75);
          sceneCtx.lineTo(left + TILE_SIZE - 0.75, top + 0.75);
        }

        if (!isOrangeWall(x + 1, y)) {
          sceneCtx.moveTo(left + TILE_SIZE - 0.75, top + 0.75);
          sceneCtx.lineTo(left + TILE_SIZE - 0.75, top + TILE_SIZE - 0.75);
        }

        if (!isOrangeWall(x, y + 1)) {
          sceneCtx.moveTo(left + TILE_SIZE - 0.75, top + TILE_SIZE - 0.75);
          sceneCtx.lineTo(left + 0.75, top + TILE_SIZE - 0.75);
        }

        if (!isOrangeWall(x - 1, y)) {
          sceneCtx.moveTo(left + 0.75, top + TILE_SIZE - 0.75);
          sceneCtx.lineTo(left + 0.75, top + 0.75);
        }

        sceneCtx.stroke();
        return;
      }

      if (cell.type === "orange_button") {
        const buttonWidth = TILE_SIZE * 0.42;
        const buttonHeight = TILE_SIZE * 0.3;
        const buttonLeft = left + (TILE_SIZE - buttonWidth) / 2;
        const buttonTop = top + TILE_SIZE * 0.38;
        const buttonLift = Math.max(2, TILE_SIZE * 0.055);
        const radius = TILE_SIZE * 0.07;
        const radii = { tl: radius, tr: radius, br: radius, bl: radius };

        sceneCtx.fillStyle = "#d6bd94";
        sceneCtx.fillRect(left, top, TILE_SIZE, TILE_SIZE);
        sceneCtx.strokeStyle = "rgba(0, 0, 0, 0.12)";
        sceneCtx.lineWidth = 1.5;
        sceneCtx.strokeRect(left + 0.75, top + 0.75, TILE_SIZE - 1.5, TILE_SIZE - 1.5);

        roundRectPath(sceneCtx, buttonLeft, buttonTop + buttonLift, buttonWidth, buttonHeight, radii);
        sceneCtx.fillStyle = "#b85f16";
        sceneCtx.fill();

        roundRectPath(sceneCtx, buttonLeft, buttonTop, buttonWidth, buttonHeight, radii);
        sceneCtx.fillStyle = "#f59e0b";
        sceneCtx.fill();
        sceneCtx.lineWidth = 2;
        sceneCtx.strokeStyle = "#000000";
        sceneCtx.stroke();
        return;
      }

      if (cell.type === "ice") {
        const centerX = left + TILE_SIZE * 0.5;
        const centerY = top + TILE_SIZE * 0.5;
        const shineHalfWidth = TILE_SIZE * 0.27;
        const shineHalfHeight = TILE_SIZE * 0.12;

        sceneCtx.fillStyle = "#a9d6f4";
        sceneCtx.fillRect(left, top, TILE_SIZE, TILE_SIZE);
        sceneCtx.strokeStyle = "rgba(110, 170, 212, 0.6)";
        sceneCtx.lineWidth = 1.5;
        sceneCtx.strokeRect(left + 0.75, top + 0.75, TILE_SIZE - 1.5, TILE_SIZE - 1.5);
        sceneCtx.strokeStyle = "rgba(255, 255, 255, 0.7)";
        sceneCtx.lineWidth = 3.5;
        sceneCtx.lineCap = "round";
        sceneCtx.beginPath();
        sceneCtx.moveTo(centerX - shineHalfWidth, centerY + shineHalfHeight);
        sceneCtx.lineTo(centerX + shineHalfWidth, centerY - shineHalfHeight);
        sceneCtx.stroke();
        sceneCtx.lineCap = "butt";
        return;
      }

      sceneCtx.fillStyle = "#d6bd94";
      sceneCtx.fillRect(left, top, TILE_SIZE, TILE_SIZE);
      sceneCtx.strokeStyle = "rgba(0, 0, 0, 0.12)";
      sceneCtx.lineWidth = 1.5;
      sceneCtx.strokeRect(left + 0.75, top + 0.75, TILE_SIZE - 1.5, TILE_SIZE - 1.5);
    }

    function groundFaceColor(cell) {
      const groundCell = groundSurfaceCell(cell);

      if (groundCell.type === "ice") {
        return "#7fb6db";
      }

      if (groundCell.type === "player_gate") {
        return "#a84d46";
      }

      if (groundCell.type === "player_lift") {
        return "#6f4eb4";
      }

      if (groundCell.type === "orange_wall" || groundCell.type === "orange_button") {
        return "#f59e0b";
      }

      return "#b89c73";
    }

    function paintGroundDropFace(x, y, cell) {
      if (
        y >= state.height - 1 ||
        !isGroundCell(cell) ||
        !isHole(x, y + 1) ||
        (cell.type === "player_lift" && cell.raised === true)
      ) {
        return;
      }

      const groundCell = groundSurfaceCell(cell);
      const left = x * TILE_SIZE;
      const faceTop = (y + 1) * TILE_SIZE;
      const faceHeight = Math.round(TILE_SIZE * 0.24);
      const borderWidth = 3;
      const leftNeighborHasFace =
        x > 0 && isGroundCell(terrainAt(x - 1, y)) && isHole(x - 1, y + 1);
      const rightNeighborHasFace =
        x < state.width - 1 && isGroundCell(terrainAt(x + 1, y)) && isHole(x + 1, y + 1);

      sceneCtx.fillStyle = groundFaceColor(groundCell);
      sceneCtx.fillRect(left, faceTop, TILE_SIZE, faceHeight);
      sceneCtx.lineWidth = borderWidth;
      sceneCtx.strokeStyle = "#000000";
      sceneCtx.beginPath();
      sceneCtx.moveTo(left, faceTop + borderWidth / 2);
      sceneCtx.lineTo(left + TILE_SIZE, faceTop + borderWidth / 2);
      sceneCtx.stroke();
      sceneCtx.fillStyle = "#000000";

      if (!leftNeighborHasFace) {
        sceneCtx.fillRect(left, faceTop, borderWidth, faceHeight);
      }

      if (!rightNeighborHasFace) {
        sceneCtx.fillRect(left + TILE_SIZE - borderWidth, faceTop, borderWidth, faceHeight);
      }
    }

    function paintWallTile(x, y, cell) {
      const left = x * TILE_SIZE;
      const top = y * TILE_SIZE;
      const right = left + TILE_SIZE;
      const bottom = top + TILE_SIZE;
      const image = cell.imageUrl ? imageCache.get(cell.imageUrl) : null;
      const openTop = !isTerrainWall(x, y - 1);
      const openRight = !isTerrainWallAcrossHorizontalWorldEdge(x + 1, y);
      const openBottom = !isTerrainWall(x, y + 1);
      const openLeft = !isTerrainWallAcrossHorizontalWorldEdge(x - 1, y);

      paintFloorTile(x, y, groundSurfaceCell(cell));

      if (image) {
        sceneCtx.drawImage(image, left, top, TILE_SIZE, TILE_SIZE);
        return;
      }

      const faceHeight = Math.round(TILE_SIZE * 0.26);
      const liftHeight = openTop ? faceHeight : 0;
      const wallTop = top - liftHeight;
      const wallHeight = TILE_SIZE + liftHeight;
      const radius = TILE_SIZE * 0.18;
      const radii = {
        tl: openTop && openLeft ? radius : 0,
        tr: openTop && openRight ? radius : 0,
        br: 0,
        bl: 0
      };
      const rightSideVisibleEnd =
        openRight &&
        !openBottom &&
        x < state.width - 1 &&
        y < state.height - 1 &&
        isTerrainWall(x + 1, y + 1) &&
        !isTerrainWall(x + 1, y)
          ? bottom - faceHeight
          : bottom - radii.br;
      const leftSideVisibleEnd =
        openLeft &&
        !openBottom &&
        x > 0 &&
        y < state.height - 1 &&
        isTerrainWall(x - 1, y + 1) &&
        !isTerrainWall(x - 1, y)
          ? bottom - faceHeight
          : bottom - radii.bl;
      const rightSideEnd = rightSideVisibleEnd;
      const leftSideEnd = leftSideVisibleEnd;

      if (x === 0 && y === 0) {
        radii.tl = 0;
      }
      if (x === state.width - 1 && y === 0) {
        radii.tr = 0;
      }
      if (x === state.width - 1 && y === state.height - 1) {
        radii.br = 0;
      }
      if (x === 0 && y === state.height - 1) {
        radii.bl = 0;
      }

      roundRectPath(sceneCtx, left, wallTop, TILE_SIZE, wallHeight, radii);
      sceneCtx.save();
      sceneCtx.clip();
      sceneCtx.fillStyle = "#23262c";
      sceneCtx.fillRect(left, wallTop, TILE_SIZE, wallHeight);

      if (y < state.height - 1 && !isTerrainWall(x, y + 1)) {
        const shineTop = bottom - faceHeight;
        const shineBorderWidth = 3;
        const leftNeighborHasShine =
          isTerrainWallAcrossHorizontalWorldEdge(x - 1, y) &&
          !isTerrainWallAcrossHorizontalWorldEdge(x - 1, y + 1);
        const rightNeighborHasShine =
          isTerrainWallAcrossHorizontalWorldEdge(x + 1, y) &&
          !isTerrainWallAcrossHorizontalWorldEdge(x + 1, y + 1);
        sceneCtx.fillStyle = "#4f5560";
        sceneCtx.fillRect(left, shineTop, TILE_SIZE, faceHeight);
        sceneCtx.lineWidth = shineBorderWidth;
        sceneCtx.strokeStyle = "#000000";
        sceneCtx.beginPath();
        sceneCtx.moveTo(left, shineTop + shineBorderWidth / 2);
        sceneCtx.lineTo(right, shineTop + shineBorderWidth / 2);
        sceneCtx.stroke();
        sceneCtx.fillStyle = "#000000";
        if (!openLeft && !leftNeighborHasShine) {
          sceneCtx.fillRect(left, shineTop, shineBorderWidth, faceHeight);
        }
        if (!openRight && !rightNeighborHasShine) {
          sceneCtx.fillRect(right - shineBorderWidth, shineTop, shineBorderWidth, faceHeight);
        }
      }
      sceneCtx.restore();

      sceneCtx.lineWidth = 3;
      sceneCtx.strokeStyle = "#000000";
      sceneCtx.beginPath();

      if (openTop) {
        sceneCtx.moveTo(left + radii.tl, wallTop);
        sceneCtx.lineTo(right - radii.tr, wallTop);
      }

      if (openRight) {
        sceneCtx.moveTo(right, wallTop + radii.tr);
        sceneCtx.lineTo(right, rightSideEnd);
      }

      if (openBottom) {
        sceneCtx.moveTo(right - radii.br, bottom);
        sceneCtx.lineTo(left + radii.bl, bottom);
      }

      if (openLeft) {
        sceneCtx.moveTo(left, leftSideEnd);
        sceneCtx.lineTo(left, wallTop + radii.tl);
      }

      if (radii.tl > 0) {
        sceneCtx.moveTo(left + radii.tl, wallTop);
        sceneCtx.quadraticCurveTo(left, wallTop, left, wallTop + radii.tl);
      }

      if (radii.tr > 0) {
        sceneCtx.moveTo(right - radii.tr, wallTop);
        sceneCtx.quadraticCurveTo(right, wallTop, right, wallTop + radii.tr);
      }

      if (radii.br > 0) {
        sceneCtx.moveTo(right, bottom - radii.br);
        sceneCtx.quadraticCurveTo(right, bottom, right - radii.br, bottom);
      }

      if (radii.bl > 0) {
        sceneCtx.moveTo(left + radii.bl, bottom);
        sceneCtx.quadraticCurveTo(left, bottom, left, bottom - radii.bl);
      }

      sceneCtx.stroke();
    }

    function paintRaisedPlayerGateTile(x, y, cell, lift = 1) {
      if (lift <= 0.001) {
        return;
      }

      void cell;

      const left = x * TILE_SIZE;
      const top = y * TILE_SIZE;
      const right = left + TILE_SIZE;
      const bottom = top + TILE_SIZE;
      const faceHeight = Math.round(TILE_SIZE * 0.26);
      const liftHeight = faceHeight;
      const travel = liftHeight * lift;
      const platformTop = top - travel;
      const platformBottom = bottom - travel;
      const borderAlpha = clamp(lift, 0, 1);
      const borderColor = `rgba(0, 0, 0, ${borderAlpha})`;
      const radius = TILE_SIZE * 0.18;
      const radii = {
        tl: radius,
        tr: radius,
        br: 0,
        bl: 0
      };
      const rightSideEnd = bottom;
      const leftSideEnd = bottom;

      if (x === 0 && y === 0) {
        radii.tl = 0;
      }
      if (x === state.width - 1 && y === 0) {
        radii.tr = 0;
      }

      roundRectPath(sceneCtx, left, platformTop, TILE_SIZE, TILE_SIZE + travel, radii);
      sceneCtx.save();
      sceneCtx.clip();
      sceneCtx.fillStyle = "#c75652";
      sceneCtx.fillRect(left, platformTop, TILE_SIZE, TILE_SIZE + travel);

      if (travel > 0.001) {
        sceneCtx.fillStyle = "#d86c63";
        sceneCtx.fillRect(left, platformBottom, TILE_SIZE, Math.min(faceHeight, travel));
      }
      sceneCtx.restore();

      sceneCtx.lineWidth = 3;
      sceneCtx.strokeStyle = borderColor;
      sceneCtx.beginPath();
      sceneCtx.moveTo(left + radii.tl, platformTop);
      sceneCtx.lineTo(right - radii.tr, platformTop);
      sceneCtx.moveTo(right, platformTop + radii.tr);
      sceneCtx.lineTo(right, rightSideEnd);
      sceneCtx.moveTo(right, bottom);
      sceneCtx.lineTo(left, bottom);
      sceneCtx.moveTo(left, leftSideEnd);
      sceneCtx.lineTo(left, platformTop + radii.tl);
      sceneCtx.moveTo(left + radii.tl, platformTop);
      sceneCtx.quadraticCurveTo(left, platformTop, left, platformTop + radii.tl);
      sceneCtx.moveTo(right - radii.tr, platformTop);
      sceneCtx.quadraticCurveTo(right, platformTop, right, platformTop + radii.tr);

      if (travel > 0.001) {
        sceneCtx.moveTo(left, platformBottom);
        sceneCtx.lineTo(right, platformBottom);
      }

      sceneCtx.stroke();
    }

    function paintRaisedPlayerLiftTile(x, y, cell, lift = 1) {
      if (lift <= 0.001) {
        return;
      }

      void cell;

      const left = x * TILE_SIZE;
      const top = y * TILE_SIZE;
      const right = left + TILE_SIZE;
      const bottom = top + TILE_SIZE;
      const faceHeight = Math.round(TILE_SIZE * 0.26);
      const liftHeight = faceHeight;
      const travel = liftHeight * lift;
      const platformTop = top - travel;
      const platformBottom = bottom - travel;
      const borderAlpha = clamp(lift, 0, 1);
      const borderColor = `rgba(0, 0, 0, ${borderAlpha})`;
      const radius = TILE_SIZE * 0.18;
      const radii = {
        tl: radius,
        tr: radius,
        br: 0,
        bl: 0
      };
      const rightSideEnd = bottom;
      const leftSideEnd = bottom;

      if (x === 0 && y === 0) {
        radii.tl = 0;
      }
      if (x === state.width - 1 && y === 0) {
        radii.tr = 0;
      }

      roundRectPath(sceneCtx, left, platformTop, TILE_SIZE, TILE_SIZE + travel, radii);
      sceneCtx.save();
      sceneCtx.clip();
      sceneCtx.fillStyle = "#8a63d2";
      sceneCtx.fillRect(left, platformTop, TILE_SIZE, TILE_SIZE + travel);
      paintPlayerLiftArrow(sceneCtx, left, platformTop, Math.PI * clamp(lift, 0, 1));

      if (travel > 0.001) {
        sceneCtx.fillStyle = "#6f4eb4";
        sceneCtx.fillRect(left, platformBottom, TILE_SIZE, Math.min(faceHeight, travel));
      }
      sceneCtx.restore();

      sceneCtx.lineWidth = 3;
      sceneCtx.strokeStyle = borderColor;
      sceneCtx.beginPath();
      sceneCtx.moveTo(left + radii.tl, platformTop);
      sceneCtx.lineTo(right - radii.tr, platformTop);
      sceneCtx.moveTo(right, platformTop + radii.tr);
      sceneCtx.lineTo(right, rightSideEnd);
      sceneCtx.moveTo(right, bottom);
      sceneCtx.lineTo(left, bottom);
      sceneCtx.moveTo(left, leftSideEnd);
      sceneCtx.lineTo(left, platformTop + radii.tl);
      sceneCtx.moveTo(left + radii.tl, platformTop);
      sceneCtx.quadraticCurveTo(left, platformTop, left, platformTop + radii.tl);
      sceneCtx.moveTo(right - radii.tr, platformTop);
      sceneCtx.quadraticCurveTo(right, platformTop, right, platformTop + radii.tr);

      if (travel > 0.001) {
        sceneCtx.moveTo(left, platformBottom);
        sceneCtx.lineTo(right, platformBottom);
      }

      sceneCtx.stroke();
    }

    function paintRaisedOrangeWallTile(x, y, cell, lift = 1) {
      if (lift <= 0.001) {
        return;
      }

      void cell;

      const left = x * TILE_SIZE;
      const top = y * TILE_SIZE;
      const right = left + TILE_SIZE;
      const bottom = top + TILE_SIZE;
      const faceHeight = Math.round(TILE_SIZE * 0.26);
      const liftHeight = faceHeight;
      const travel = liftHeight * lift;
      const openTop = !isOrangeWall(x, y - 1);
      const openRight = !isOrangeWall(x + 1, y);
      const openBottom = !isOrangeWall(x, y + 1);
      const openLeft = !isOrangeWall(x - 1, y);
      const topTravel = openTop ? travel : 0;
      const platformTop = top - topTravel;
      const platformBottom = bottom - travel;
      const borderAlpha = clamp(lift, 0, 1);
      const borderColor = `rgba(0, 0, 0, ${borderAlpha})`;
      const radius = TILE_SIZE * 0.18;
      const radii = {
        tl: openTop && openLeft ? radius : 0,
        tr: openTop && openRight ? radius : 0,
        br: 0,
        bl: 0
      };
      const rightSideVisibleEnd =
        openRight &&
        !openBottom &&
        x < state.width - 1 &&
        y < state.height - 1 &&
        isOrangeWall(x + 1, y + 1) &&
        !isOrangeWall(x + 1, y)
          ? bottom - travel
          : bottom - radii.br;
      const leftSideVisibleEnd =
        openLeft &&
        !openBottom &&
        x > 0 &&
        y < state.height - 1 &&
        isOrangeWall(x - 1, y + 1) &&
        !isOrangeWall(x - 1, y)
          ? bottom - travel
          : bottom - radii.bl;
      const rightSideEnd = rightSideVisibleEnd;
      const leftSideEnd = leftSideVisibleEnd;

      if (x === 0 && y === 0) {
        radii.tl = 0;
      }
      if (x === state.width - 1 && y === 0) {
        radii.tr = 0;
      }

      roundRectPath(sceneCtx, left, platformTop, TILE_SIZE, TILE_SIZE + topTravel, radii);
      sceneCtx.save();
      sceneCtx.clip();
      sceneCtx.fillStyle = "#b85f16";
      sceneCtx.fillRect(left, platformTop, TILE_SIZE, TILE_SIZE + topTravel);

      if (travel > 0.001 && openBottom) {
        const shineBorderWidth = 3;
        const leftNeighborHasShine =
          isOrangeWall(x - 1, y) && !isOrangeWall(x - 1, y + 1);
        const rightNeighborHasShine =
          isOrangeWall(x + 1, y) && !isOrangeWall(x + 1, y + 1);

        sceneCtx.fillStyle = "#f59e0b";
        sceneCtx.fillRect(left, platformBottom, TILE_SIZE, Math.min(faceHeight, travel));
        sceneCtx.lineWidth = shineBorderWidth;
        sceneCtx.strokeStyle = "#000000";
        sceneCtx.beginPath();
        sceneCtx.moveTo(left, platformBottom + shineBorderWidth / 2);
        sceneCtx.lineTo(right, platformBottom + shineBorderWidth / 2);
        sceneCtx.stroke();
        sceneCtx.fillStyle = "#000000";

        if (!openLeft && !leftNeighborHasShine) {
          sceneCtx.fillRect(left, platformBottom, shineBorderWidth, Math.min(faceHeight, travel));
        }

        if (!openRight && !rightNeighborHasShine) {
          sceneCtx.fillRect(right - shineBorderWidth, platformBottom, shineBorderWidth, Math.min(faceHeight, travel));
        }
      }
      sceneCtx.restore();

      sceneCtx.lineWidth = 3;
      sceneCtx.strokeStyle = borderColor;
      sceneCtx.beginPath();

      if (openTop) {
        sceneCtx.moveTo(left + radii.tl, platformTop);
        sceneCtx.lineTo(right - radii.tr, platformTop);
      }

      if (openRight) {
        sceneCtx.moveTo(right, platformTop + radii.tr);
        sceneCtx.lineTo(right, rightSideEnd);
      }

      if (openBottom) {
        sceneCtx.moveTo(right - radii.br, bottom);
        sceneCtx.lineTo(left + radii.bl, bottom);
      }

      if (openLeft) {
        sceneCtx.moveTo(left, leftSideEnd);
        sceneCtx.lineTo(left, platformTop + radii.tl);
      }

      if (radii.tl > 0) {
        sceneCtx.moveTo(left + radii.tl, platformTop);
        sceneCtx.quadraticCurveTo(left, platformTop, left, platformTop + radii.tl);
      }

      if (radii.tr > 0) {
        sceneCtx.moveTo(right - radii.tr, platformTop);
        sceneCtx.quadraticCurveTo(right, platformTop, right, platformTop + radii.tr);
      }

      if (travel > 0.001 && openBottom) {
        sceneCtx.moveTo(left, platformBottom);
        sceneCtx.lineTo(right, platformBottom);
      }

      sceneCtx.stroke();
    }

    function paintExit(x, y, cell) {
      paintFloorTile(x, y, cell);

      const left = x * TILE_SIZE + TILE_SIZE / 2;
      const top = y * TILE_SIZE + TILE_SIZE / 2;
      const image = cell.imageUrl ? imageCache.get(cell.imageUrl) : null;

      if (image) {
        sceneCtx.drawImage(image, x * TILE_SIZE, y * TILE_SIZE, TILE_SIZE, TILE_SIZE);
        return;
      }

      sceneCtx.fillStyle = "#ff7b72";
      sceneCtx.beginPath();
      sceneCtx.arc(left, top, TILE_SIZE * 0.18, 0, Math.PI * 2);
      sceneCtx.fill();
      sceneCtx.lineWidth = 3;
      sceneCtx.strokeStyle = "#000000";
      sceneCtx.stroke();
    }

    function paintGround(now = performance.now()) {
      for (let y = 0; y < state.height; y += 1) {
        for (let x = 0; x < state.width; x += 1) {
          const cell = terrainAt(x, y);
          const gateLift = cell.type === "player_gate" ? gateLiftAt(x, y, now) : 0;
          const playerLift = cell.type === "player_lift" ? playerLiftAt(x, y, now) : 0;
          const orangeWallLift = cell.type === "orange_wall" ? orangeWallLiftAt(x, y, now) : 0;

          if (cell.type === "wall") {
            continue;
          }

          if (cell.type === "player_gate" && gateLift > 0.001) {
            continue;
          }

          if (cell.type === "player_lift" && playerLift > 0.001) {
            continue;
          }

          if (cell.type === "orange_wall" && orangeWallLift > 0.001) {
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
          if (
            (isPlayerGate(x, y) && gateLiftAt(x, y, now) > 0.001) ||
            (isPlayerLift(x, y) && playerLiftAt(x, y, now) > 0.001) ||
            (isOrangeWall(x, y) && orangeWallLiftAt(x, y, now) > 0.001)
          ) {
            continue;
          }

          paintGroundDropFace(x, y, terrainAt(x, y));
        }
      }
    }

    function paintWalls() {
      for (let y = 0; y < state.height; y += 1) {
        for (let x = 0; x < state.width; x += 1) {
          const cell = terrainAt(x, y);
          if (cell.type === "wall") {
            paintWallTile(x, y, cell);
          }
        }
      }
    }

    app.renderTerrain = {
      roundRectPath,
      paintPlayerLiftArrow,
      elevatedBleedCoverColor,
      paintElevatedSideBleedCover,
      queueElevatedSideBleedCoverItems,
      paintFloorTile,
      groundFaceColor,
      paintGroundDropFace,
      paintWallTile,
      paintRaisedPlayerGateTile,
      paintRaisedPlayerLiftTile,
      paintRaisedOrangeWallTile,
      paintExit,
      paintGround,
      paintWalls
    };
  };
})();
