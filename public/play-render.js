(function () {
  const modules = window.PlayModules || (window.PlayModules = {});

  modules.registerRenderFunctions = function registerRenderFunctions(app) {
    const {
      state,
      TILE_SIZE,
      PLAYER_LIFT_ARROW_URL,
      FLOATING_FLOOR_SHADOW_INSET,
      FLOATING_FLOOR_SHADOW_HEIGHT,
      GEM_DRAW_WIDTH,
      GEM_SHADOW_WIDTH,
      GEM_SHADOW_HEIGHT,
      sceneCanvas,
      sceneCtx,
      viewCanvas,
      viewCtx,
      weightlessGroupCanvas,
      weightlessGroupCtx,
      imageCache,
      boardRect,
      viewportRect,
      canvas,
      gl,
      fallbackCtx
    } = app;
    const {
      clamp,
      groundSurfaceCell,
      isGroundCell,
      terrainAt,
      isHole,
      isPlayerGate,
      isPlayerLift,
      gateLiftAt,
      playerLiftAt,
      isTerrainWall,
      isTerrainWallAcrossHorizontalWorldEdge,
      elevatedSideBleedCoverFamily,
      isWeightlessBoxAt,
      weightlessGroupRenderState,
      weightlessGroupMembers,
      floatingFloorHoverOffset,
      isCollectibleActor,
      isPlayerActor,
      actorRenderElevation,
      easeInOutQuad,
      usesScrollingViewport,
      syncCameraTarget,
      advanceCamera
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

        return {
          offset: { x: groupState.offsetX, y: groupState.offsetY },
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

          if (cell.type === "wall") {
            continue;
          }

          if (cell.type === "player_gate" && gateLift > 0.001) {
            continue;
          }

          if (cell.type === "player_lift" && playerLift > 0.001) {
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
            (isPlayerLift(x, y) && playerLiftAt(x, y, now) > 0.001)
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

    function paintWeightlessBoxTile(actor, offsetX = 0, offsetY = 0, context = sceneCtx) {
      const left = actor.x * TILE_SIZE + offsetX;
      const top = actor.y * TILE_SIZE + offsetY;
      const right = left + TILE_SIZE;
      const bottom = top + TILE_SIZE;
      const openTop = !isWeightlessBoxAt(actor.groupId, actor.x, actor.y - 1);
      const openRight = !isWeightlessBoxAt(actor.groupId, actor.x + 1, actor.y);
      const openBottom = !isWeightlessBoxAt(actor.groupId, actor.x, actor.y + 1);
      const openLeft = !isWeightlessBoxAt(actor.groupId, actor.x - 1, actor.y);
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
        actor.x < state.width - 1 &&
        actor.y < state.height - 1 &&
        !openBottom &&
        isWeightlessBoxAt(actor.groupId, actor.x + 1, actor.y + 1) &&
        !isWeightlessBoxAt(actor.groupId, actor.x + 1, actor.y)
          ? bottom - faceHeight
          : bottom - radii.br;
      const leftSideVisibleEnd =
        openLeft &&
        actor.x > 0 &&
        actor.y < state.height - 1 &&
        !openBottom &&
        isWeightlessBoxAt(actor.groupId, actor.x - 1, actor.y + 1) &&
        !isWeightlessBoxAt(actor.groupId, actor.x - 1, actor.y)
          ? bottom - faceHeight
          : bottom - radii.bl;
      const rightSideEnd = rightSideVisibleEnd;
      const leftSideEnd = leftSideVisibleEnd;

      roundRectPath(context, left, wallTop, TILE_SIZE, wallHeight, radii);
      context.save();
      context.clip();
      context.fillStyle = "#315991";
      context.fillRect(left, wallTop, TILE_SIZE, wallHeight);

      if (openBottom) {
        const shineTop = bottom - faceHeight;
        const shineBorderWidth = 3;
        const leftNeighborHasShine =
          actor.x > 0 &&
          isWeightlessBoxAt(actor.groupId, actor.x - 1, actor.y) &&
          !isWeightlessBoxAt(actor.groupId, actor.x - 1, actor.y + 1);
        const rightNeighborHasShine =
          actor.x < state.width - 1 &&
          isWeightlessBoxAt(actor.groupId, actor.x + 1, actor.y) &&
          !isWeightlessBoxAt(actor.groupId, actor.x + 1, actor.y + 1);
        context.fillStyle = "#79abeb";
        context.fillRect(left, shineTop, TILE_SIZE, faceHeight);
        context.lineWidth = shineBorderWidth;
        context.strokeStyle = "#000000";
        context.beginPath();
        context.moveTo(left, shineTop + shineBorderWidth / 2);
        context.lineTo(right, shineTop + shineBorderWidth / 2);
        context.stroke();
        context.fillStyle = "#000000";
        if (!openLeft && !leftNeighborHasShine) {
          context.fillRect(left, shineTop, shineBorderWidth, faceHeight);
        }
        if (!openRight && !rightNeighborHasShine) {
          context.fillRect(right - shineBorderWidth, shineTop, shineBorderWidth, faceHeight);
        }
      }
      context.restore();

      function traceOutline() {
        context.beginPath();

        if (openTop) {
          context.moveTo(left + radii.tl, wallTop);
          context.lineTo(right - radii.tr, wallTop);
        }

        if (openRight) {
          context.moveTo(right, wallTop + radii.tr);
          context.lineTo(right, rightSideEnd);
        }

        if (openBottom) {
          context.moveTo(right - radii.br, bottom);
          context.lineTo(left + radii.bl, bottom);
        }

        if (openLeft) {
          context.moveTo(left, leftSideEnd);
          context.lineTo(left, wallTop + radii.tl);
        }

        if (radii.tl > 0) {
          context.moveTo(left + radii.tl, wallTop);
          context.quadraticCurveTo(left, wallTop, left, wallTop + radii.tl);
        }

        if (radii.tr > 0) {
          context.moveTo(right - radii.tr, wallTop);
          context.quadraticCurveTo(right, wallTop, right, wallTop + radii.tr);
        }

        if (radii.br > 0) {
          context.moveTo(right, bottom - radii.br);
          context.quadraticCurveTo(right, bottom, right - radii.br, bottom);
        }

        if (radii.bl > 0) {
          context.moveTo(left + radii.bl, bottom);
          context.quadraticCurveTo(left, bottom, left, bottom - radii.bl);
        }
      }

      context.lineWidth = 3;
      context.strokeStyle = "#315991";
      traceOutline();
      context.stroke();
      context.strokeStyle = "#000000";
      traceOutline();
      context.stroke();
    }

    function paintRaisedPlayer(actor, context = sceneCtx) {
      const scale = actor.renderScale ?? 1;
      const alpha = actor.renderAlpha ?? 1;

      if (scale <= 0.001 || alpha <= 0.001) {
        return;
      }

      const sink = actor.renderSink ?? 0;
      const surfaceLift = Math.round(TILE_SIZE * 0.26 * actorRenderElevation(actor));
      const left = actor.renderX * TILE_SIZE;
      const top = actor.renderY * TILE_SIZE - surfaceLift;
      const bottom = top + TILE_SIZE;
      const faceHeight = Math.round(TILE_SIZE * 0.26);
      const liftHeight = faceHeight;
      const blockTop = top - liftHeight;
      const blockHeight = TILE_SIZE + liftHeight;
      const radius = TILE_SIZE * 0.18;
      const radii = {
        tl: radius,
        tr: radius,
        br: 0,
        bl: 0
      };
      const rightSideEnd = bottom;
      const leftSideEnd = bottom;

      context.save();
      context.translate(left + TILE_SIZE / 2, bottom + sink);
      context.scale(scale, scale);
      context.translate(-(left + TILE_SIZE / 2), -bottom);

      roundRectPath(context, left, blockTop, TILE_SIZE, blockHeight, radii);
      context.save();
      context.clip();
      context.fillStyle = "#4d8b52";
      context.fillRect(left, blockTop, TILE_SIZE, blockHeight);

      const shineTop = bottom - faceHeight;
      const shineBorderWidth = 3;
      context.fillStyle = "#86cb7d";
      context.fillRect(left, shineTop, TILE_SIZE, faceHeight);
      context.lineWidth = shineBorderWidth;
      context.strokeStyle = "#000000";
      context.beginPath();
      context.moveTo(left, shineTop + shineBorderWidth / 2);
      context.lineTo(left + TILE_SIZE, shineTop + shineBorderWidth / 2);
      context.stroke();
      context.restore();

      function tracePlayerOutline() {
        context.beginPath();
        context.moveTo(left + radii.tl, blockTop);
        context.lineTo(left + TILE_SIZE - radii.tr, blockTop);
        context.moveTo(left + TILE_SIZE, blockTop + radii.tr);
        context.lineTo(left + TILE_SIZE, rightSideEnd);
        context.moveTo(left + TILE_SIZE, bottom);
        context.lineTo(left, bottom);
        context.moveTo(left, leftSideEnd);
        context.lineTo(left, blockTop + radii.tl);
        if (radii.tl > 0) {
          context.moveTo(left + radii.tl, blockTop);
          context.quadraticCurveTo(left, blockTop, left, blockTop + radii.tl);
        }
        if (radii.tr > 0) {
          context.moveTo(left + TILE_SIZE - radii.tr, blockTop);
          context.quadraticCurveTo(
            left + TILE_SIZE,
            blockTop,
            left + TILE_SIZE,
            blockTop + radii.tr
          );
        }
      }

      context.lineWidth = 3;
      context.strokeStyle = "#4d8b52";
      tracePlayerOutline();
      context.stroke();
      context.strokeStyle = "#000000";
      tracePlayerOutline();
      context.stroke();
      context.restore();
    }

    function paintFloatingFloor(actor, context = sceneCtx, now = performance.now()) {
      const scale = actor.renderScale ?? 1;
      const alpha = actor.renderAlpha ?? 1;

      if (scale <= 0.001 || alpha <= 0.001) {
        return;
      }

      const sink = actor.renderSink ?? 0;
      const left = actor.renderX * TILE_SIZE;
      const top = actor.renderY * TILE_SIZE;
      const right = left + TILE_SIZE;
      const bottom = top + TILE_SIZE;
      const hover = Math.max(0, floatingFloorHoverOffset(actor, now));
      const platformTop = top - hover + sink;
      const platformBottom = bottom - hover + sink;
      const radius = Math.min(7, TILE_SIZE * 0.11);
      const rightSideEnd = bottom + sink;
      const leftSideEnd = bottom + sink;

      context.save();
      context.translate(left + TILE_SIZE / 2, bottom + sink);
      context.scale(scale, scale);
      context.translate(-(left + TILE_SIZE / 2), -(bottom + sink));

      roundRectPath(
        context,
        left + FLOATING_FLOOR_SHADOW_INSET,
        bottom - FLOATING_FLOOR_SHADOW_HEIGHT * 0.5 + sink,
        TILE_SIZE - FLOATING_FLOOR_SHADOW_INSET * 2,
        FLOATING_FLOOR_SHADOW_HEIGHT,
        {
          tl: FLOATING_FLOOR_SHADOW_HEIGHT * 0.5,
          tr: FLOATING_FLOOR_SHADOW_HEIGHT * 0.5,
          br: FLOATING_FLOOR_SHADOW_HEIGHT * 0.5,
          bl: FLOATING_FLOOR_SHADOW_HEIGHT * 0.5
        }
      );
      context.fillStyle = "rgba(0, 0, 0, 0.18)";
      context.fill();

      roundRectPath(context, left, platformTop, TILE_SIZE, TILE_SIZE + hover, {
        tl: radius,
        tr: radius,
        br: 0,
        bl: 0
      });
      context.save();
      context.clip();
      context.fillStyle = "#d6bd94";
      context.fillRect(left, platformTop, TILE_SIZE, TILE_SIZE + hover);
      context.strokeStyle = "rgba(0, 0, 0, 0.12)";
      context.lineWidth = 1.5;
      context.strokeRect(left + 0.75, platformTop + 0.75, TILE_SIZE - 1.5, TILE_SIZE - 1.5);

      if (hover > 0.001) {
        context.fillStyle = "#b89c73";
        context.fillRect(left, platformBottom, TILE_SIZE, hover);
      }
      context.restore();

      context.lineWidth = 3;
      context.strokeStyle = "#000000";
      context.beginPath();
      context.moveTo(left + radius, platformTop);
      context.lineTo(right - radius, platformTop);
      context.moveTo(right, platformTop + radius);
      context.lineTo(right, rightSideEnd);
      context.moveTo(right, bottom + sink);
      context.lineTo(left, bottom + sink);
      context.moveTo(left, leftSideEnd);
      context.lineTo(left, platformTop + radius);
      context.moveTo(left + radius, platformTop);
      context.quadraticCurveTo(left, platformTop, left, platformTop + radius);
      context.moveTo(right - radius, platformTop);
      context.quadraticCurveTo(right, platformTop, right, platformTop + radius);

      if (hover > 0.001) {
        context.moveTo(left, platformBottom);
        context.lineTo(right, platformBottom);
      }

      context.stroke();
      context.restore();
    }

    function animatedWeightlessGroupMembers(groupId) {
      return weightlessGroupMembers(groupId, { includeRemoved: true }).filter(
        (member) => !member.removed || member.renderScale > 0.001
      );
    }

    function paintWeightlessGroup(groupId) {
      const groupState = weightlessGroupRenderState(groupId);

      if (groupState.scale <= 0.001) {
        return;
      }

      const members = animatedWeightlessGroupMembers(groupId).sort((left, right) => {
        if (left.y !== right.y) {
          return left.y - right.y;
        }

        return left.x - right.x;
      });

      if (members.length === 0) {
        return;
      }

      if (!weightlessGroupCtx) {
        members.forEach((member) => {
          paintWeightlessBoxTile(member, groupState.offsetX, groupState.offsetY);
        });
        return;
      }

      const faceHeight = Math.round(TILE_SIZE * 0.26);
      const minX = Math.min(...members.map((member) => member.x));
      const maxX = Math.max(...members.map((member) => member.x));
      const minY = Math.min(...members.map((member) => member.y));
      const maxY = Math.max(...members.map((member) => member.y));
      const bitmapWidth = (maxX - minX + 1) * TILE_SIZE;
      const bitmapHeight = (maxY - minY + 1) * TILE_SIZE + faceHeight;
      const tileOffsetX = -minX * TILE_SIZE;
      const tileOffsetY = faceHeight - minY * TILE_SIZE;
      const drawLeft = minX * TILE_SIZE + groupState.offsetX;
      const drawTop = minY * TILE_SIZE - faceHeight + groupState.offsetY;

      if (
        weightlessGroupCanvas.width !== bitmapWidth ||
        weightlessGroupCanvas.height !== bitmapHeight
      ) {
        weightlessGroupCanvas.width = bitmapWidth;
        weightlessGroupCanvas.height = bitmapHeight;
      }

      weightlessGroupCtx.setTransform(1, 0, 0, 1, 0, 0);
      weightlessGroupCtx.clearRect(0, 0, bitmapWidth, bitmapHeight);
      weightlessGroupCtx.imageSmoothingEnabled = false;
      members.forEach((member) => {
        paintWeightlessBoxTile(member, tileOffsetX, tileOffsetY, weightlessGroupCtx);
      });

      sceneCtx.save();
      if (groupState.sink > 0.001) {
        sceneCtx.beginPath();
        members.forEach((member) => {
          sceneCtx.rect(member.x * TILE_SIZE, member.y * TILE_SIZE, TILE_SIZE, TILE_SIZE);
        });
        sceneCtx.clip();
      }
      sceneCtx.translate(groupState.centerX, groupState.centerY + groupState.sink);
      sceneCtx.scale(groupState.scale, groupState.scale);
      sceneCtx.translate(-groupState.centerX, -groupState.centerY);
      sceneCtx.imageSmoothingEnabled = false;
      sceneCtx.drawImage(weightlessGroupCanvas, drawLeft, drawTop);
      sceneCtx.restore();
    }

    function actorDepthRow(actor) {
      const renderY = actor.renderY ?? actor.y;

      if (!isPlayerActor(actor)) {
        return renderY;
      }

      if (actorRenderElevation(actor) <= 0.001) {
        return renderY;
      }

      return Math.ceil(renderY);
    }

    function buildDrawItems(now = performance.now()) {
      const drawItems = [];
      const animatedWeightlessGroups = new Set();

      for (let y = 0; y < state.height; y += 1) {
        for (let x = 0; x < state.width; x += 1) {
          const cell = terrainAt(x, y);
          const gateLift = cell.type === "player_gate" ? gateLiftAt(x, y, now) : 0;
          const playerLift = cell.type === "player_lift" ? playerLiftAt(x, y, now) : 0;

          if (cell.type !== "wall" && gateLift <= 0.001 && playerLift <= 0.001) {
            continue;
          }

          drawItems.push({
            depth: y + 1,
            tieBreaker: 0,
            order: drawItems.length,
            paint: function () {
              if (cell.type === "player_gate") {
                paintRaisedPlayerGateTile(x, y, cell, gateLift);
                return;
              }

              if (cell.type === "player_lift") {
                paintRaisedPlayerLiftTile(x, y, cell, playerLift);
                return;
              }

              paintWallTile(x, y, cell);
            }
          });
        }
      }

      state.actors.forEach((actor, index) => {
        if (actor.removed) {
          return;
        }

        if (actor.type === "weightless_box") {
          const groupState = weightlessGroupRenderState(actor.groupId);
          const isGroupedAnimation =
            Math.abs((groupState.scale ?? 1) - 1) > 0.001 || Math.abs(groupState.sink ?? 0) > 0.001;

          if (isGroupedAnimation) {
            if (animatedWeightlessGroups.has(actor.groupId)) {
              return;
            }

            animatedWeightlessGroups.add(actor.groupId);
            const members = animatedWeightlessGroupMembers(actor.groupId);

            if (members.length === 0) {
              return;
            }

            drawItems.push({
              depth:
                (actor.renderInHole ? 0 : 1) + Math.max(...members.map((member) => member.renderY)),
              tieBreaker: actor.renderInHole ? -1 : 1,
              order: index,
              paint: function () {
                paintWeightlessGroup(actor.groupId);
              }
            });
            return;
          }
        }

        const depthRow = actorDepthRow(actor);
        drawItems.push({
          depth: depthRow + (actor.renderInHole ? 0 : 1),
          tieBreaker: actor.renderInHole ? -1 : isCollectibleActor(actor) ? 0 : isPlayerActor(actor) ? 2 : 1,
          order: index,
          paint: function () {
            paintActor(actor, now);
          }
        });
      });

      queueElevatedSideBleedCoverItems(drawItems, now);

      drawItems.sort((left, right) => {
        if (left.depth !== right.depth) {
          return left.depth - right.depth;
        }

        if (left.tieBreaker !== right.tieBreaker) {
          return left.tieBreaker - right.tieBreaker;
        }

        return left.order - right.order;
      });

      return drawItems;
    }

    function paintDepthSortedScene(now = performance.now(), itemFilter = null) {
      const drawItems = buildDrawItems(now);

      drawItems.forEach((item) => {
        if (typeof itemFilter === "function" && !itemFilter(item)) {
          return;
        }

        item.paint();
      });

      return drawItems;
    }

    function paintActor(actor, now = performance.now()) {
      if (actor.removed) {
        return;
      }

      const scale = actor.renderScale ?? 1;
      const alpha = actor.renderAlpha ?? 1;

      if (scale <= 0.001 || alpha <= 0.001) {
        return;
      }

      const sink = actor.renderSink ?? 0;
      const surfaceLift = Math.round(TILE_SIZE * 0.26 * actorRenderElevation(actor));
      const left = actor.renderX * TILE_SIZE;
      const top = actor.renderY * TILE_SIZE - surfaceLift;
      const image = actor.imageUrl ? imageCache.get(actor.imageUrl) : null;
      const clipToHole = sink > 0.001;

      if (clipToHole) {
        sceneCtx.save();
        sceneCtx.beginPath();
        sceneCtx.rect(left, top, TILE_SIZE, TILE_SIZE);
        sceneCtx.clip();
      }

      if (actor.type === "weightless_box") {
        const groupState = weightlessGroupRenderState(actor.groupId);
        paintWeightlessBoxTile(actor, groupState.offsetX, groupState.offsetY);
        if (clipToHole) {
          sceneCtx.restore();
        }
        return;
      }

      if (actor.type === "floating_floor") {
        paintFloatingFloor(actor, sceneCtx, now);
        if (clipToHole) {
          sceneCtx.restore();
        }
        return;
      }

      if (actor.type === "gem") {
        const hover = Math.max(0, floatingFloorHoverOffset(actor, now));
        const drawWidth = GEM_DRAW_WIDTH * scale;
        const drawHeight = image ? drawWidth * (image.height / image.width) : drawWidth;
        const drawLeft = left + (TILE_SIZE - drawWidth) / 2;
        const drawTop = top + TILE_SIZE * 0.66 - drawHeight + sink - hover;
        const shadowWidth = GEM_SHADOW_WIDTH * scale;
        const shadowHeight = GEM_SHADOW_HEIGHT * scale;

        sceneCtx.fillStyle = "#000000";
        sceneCtx.beginPath();
        sceneCtx.ellipse(
          left + TILE_SIZE / 2,
          top + TILE_SIZE * 0.76 + sink,
          shadowWidth / 2,
          shadowHeight / 2,
          0,
          0,
          Math.PI * 2
        );
        sceneCtx.globalAlpha = alpha * 0.3;
        sceneCtx.fill();
        sceneCtx.globalAlpha = alpha;

        if (image) {
          sceneCtx.drawImage(image, drawLeft, drawTop, drawWidth, drawHeight);
        } else {
          sceneCtx.fillStyle = "#6cd7ff";
          sceneCtx.beginPath();
          sceneCtx.moveTo(left + TILE_SIZE / 2, drawTop);
          sceneCtx.lineTo(drawLeft + drawWidth, drawTop + drawHeight * 0.45);
          sceneCtx.lineTo(left + TILE_SIZE / 2, drawTop + drawHeight);
          sceneCtx.lineTo(drawLeft, drawTop + drawHeight * 0.45);
          sceneCtx.closePath();
          sceneCtx.fill();
        }

        sceneCtx.globalAlpha = 1;

        if (clipToHole) {
          sceneCtx.restore();
        }
        return;
      }

      if (image) {
        if (actor.type === "box") {
          const drawWidth = TILE_SIZE * scale;
          const drawHeight = drawWidth * (image.height / image.width);
          const drawLeft = left + (TILE_SIZE - drawWidth) / 2;
          const drawTop = top + TILE_SIZE - drawHeight + sink;

          sceneCtx.drawImage(image, drawLeft, drawTop, drawWidth, drawHeight);
          if (clipToHole) {
            sceneCtx.restore();
          }
          return;
        }

        const drawWidth = TILE_SIZE * scale;
        const drawHeight = TILE_SIZE * scale;
        const drawLeft = left + (TILE_SIZE - drawWidth) / 2;
        const drawTop = top + (TILE_SIZE - drawHeight) / 2 + sink;

        sceneCtx.drawImage(image, drawLeft, drawTop, drawWidth, drawHeight);
        if (clipToHole) {
          sceneCtx.restore();
        }
        return;
      }

      if (actor.type === "circle_player") {
        sceneCtx.fillStyle = "#5aa95c";
        sceneCtx.beginPath();
        sceneCtx.arc(
          left + TILE_SIZE / 2,
          top + TILE_SIZE / 2 + sink,
          TILE_SIZE * 0.338 * scale,
          0,
          Math.PI * 2
        );
        sceneCtx.fill();
        sceneCtx.lineWidth = 3;
        sceneCtx.strokeStyle = "#000000";
        sceneCtx.stroke();
        if (clipToHole) {
          sceneCtx.restore();
        }
        return;
      }

      if (actor.type === "player") {
        paintRaisedPlayer(actor);
        if (clipToHole) {
          sceneCtx.restore();
        }
        return;
      }

      if (actor.type === "box") {
        sceneCtx.save();
        sceneCtx.translate(left + TILE_SIZE / 2, top + TILE_SIZE + sink);
        sceneCtx.scale(scale, scale);
        sceneCtx.translate(-(left + TILE_SIZE / 2), -(top + TILE_SIZE));
        const inset = TILE_SIZE * 0.19;
        const boxLeft = left + inset;
        const boxTop = top + inset;
        const boxSize = TILE_SIZE - inset * 2;
        const boxBottom = boxTop + boxSize;
        const lipHeight = Math.max(6, Math.round(TILE_SIZE * 0.12));
        const radius = Math.min(8, TILE_SIZE * 0.12);

        roundRectPath(sceneCtx, boxLeft, boxTop, boxSize, boxSize, {
          tl: radius,
          tr: radius,
          br: radius * 0.75,
          bl: radius * 0.75
        });
        sceneCtx.fillStyle = "#2a2d33";
        sceneCtx.fill();
        sceneCtx.lineWidth = 3;
        sceneCtx.strokeStyle = "#000000";
        sceneCtx.stroke();

        sceneCtx.fillStyle = "#5b616d";
        sceneCtx.fillRect(boxLeft, boxBottom - lipHeight, boxSize, lipHeight);
        sceneCtx.beginPath();
        sceneCtx.moveTo(boxLeft, boxBottom - lipHeight);
        sceneCtx.lineTo(boxLeft + boxSize, boxBottom - lipHeight);
        sceneCtx.lineWidth = 3;
        sceneCtx.strokeStyle = "#000000";
        sceneCtx.stroke();
        sceneCtx.restore();
      }

      if (clipToHole) {
        sceneCtx.restore();
      }
    }

    function getEffectSettings() {
      const fuzzy = state.effects.fuzzyEnabled ? app.FUZZY_AMOUNT : 0;
      const fuzzyMix = clamp(fuzzy / app.FUZZY_AMOUNT, 0, 1);

      return {
        bleed: clamp(0.78 * fuzzyMix, 0, 1),
        bloom: clamp(0.38 * fuzzyMix, 0, 1),
        softness: clamp(0.74 * fuzzyMix, 0, 1),
        scanlines: clamp(0.16 * fuzzyMix, 0, 1),
        mask: clamp(0.03 * fuzzyMix, 0, 1),
        ghosting: clamp(0.03 * fuzzyMix, 0, 1),
        noise: fuzzy,
        vignetteStrength: fuzzyMix
      };
    }

    function drawViewportFromScene(
      context,
      sourceCanvas,
      sourceBoardRect,
      sourceViewportRect,
      cameraX,
      cameraY,
      offsetX = 0,
      offsetY = 0
    ) {
      if (!context || !sourceCanvas || !sourceBoardRect || !sourceViewportRect) {
        return;
      }

      const drawOffsetX = Math.round(offsetX);
      const drawOffsetY = Math.round(offsetY);

      if (
        sourceViewportRect.width === sourceBoardRect.width &&
        sourceViewportRect.height === sourceBoardRect.height
      ) {
        context.drawImage(sourceCanvas, drawOffsetX, drawOffsetY);
        return;
      }

      const roundedCameraX = Math.round(cameraX);
      const roundedCameraY = Math.round(cameraY);
      const sourceX = Math.max(0, roundedCameraX);
      const sourceY = Math.max(0, roundedCameraY);
      const destX = drawOffsetX + Math.max(0, -roundedCameraX);
      const destY = drawOffsetY + Math.max(0, -roundedCameraY);
      const drawWidth = Math.max(
        0,
        Math.min(sourceBoardRect.width - sourceX, sourceViewportRect.width - Math.max(0, -roundedCameraX))
      );
      const drawHeight = Math.max(
        0,
        Math.min(sourceBoardRect.height - sourceY, sourceViewportRect.height - Math.max(0, -roundedCameraY))
      );

      if (drawWidth <= 0 || drawHeight <= 0) {
        return;
      }

      context.drawImage(
        sourceCanvas,
        sourceX,
        sourceY,
        drawWidth,
        drawHeight,
        destX,
        destY,
        drawWidth,
        drawHeight
      );
    }

    function composeViewportSource() {
      if (!viewCtx) {
        return sceneCanvas;
      }

      viewCtx.clearRect(0, 0, viewportRect.width, viewportRect.height);
      viewCtx.fillStyle = "#d6bd94";
      viewCtx.fillRect(0, 0, viewportRect.width, viewportRect.height);
      drawViewportFromScene(
        viewCtx,
        sceneCanvas,
        boardRect,
        viewportRect,
        app.cameraX,
        app.cameraY
      );
      return viewCanvas;
    }

    function drawScene(now = performance.now()) {
      sceneCtx.clearRect(0, 0, boardRect.width, boardRect.height);
      paintGround(now);
      paintDepthSortedScene(now);
    }

    function cloneCanvas(sourceCanvas, width = sourceCanvas.width, height = sourceCanvas.height) {
      const snapshot = document.createElement("canvas");
      snapshot.width = width;
      snapshot.height = height;
      const snapshotCtx = snapshot.getContext("2d");

      if (!snapshotCtx) {
        return snapshot;
      }

      snapshotCtx.imageSmoothingEnabled = false;
      snapshotCtx.drawImage(sourceCanvas, 0, 0, width, height);
      return snapshot;
    }

    function viewportPositionForActorAtCamera(
      actor,
      cameraX,
      cameraY,
      sourceViewportRect = viewportRect,
      sourceBoardRect = boardRect
    ) {
      const surfaceLift = Math.round(TILE_SIZE * 0.26 * actorRenderElevation(actor));
      const left = actor.renderX * TILE_SIZE;
      const top = actor.renderY * TILE_SIZE - surfaceLift;

      if (
        sourceViewportRect.width === sourceBoardRect.width &&
        sourceViewportRect.height === sourceBoardRect.height
      ) {
        return { left, top };
      }

      return {
        left: left - Math.round(cameraX),
        top: top - Math.round(cameraY)
      };
    }

    function viewportPositionForActor(actor) {
      return viewportPositionForActorAtCamera(actor, app.cameraX, app.cameraY);
    }

    function paintTransitionPlayer(actor, left, top) {
      const elevation = actor.renderElevation ?? actor.elevation ?? 0;
      const surfaceLift = Math.round(TILE_SIZE * 0.26 * elevation);
      const overlayActor = {
        ...actor,
        renderX: left / TILE_SIZE,
        renderY: (top + surfaceLift) / TILE_SIZE,
        renderElevation: elevation,
        renderScale: actor.renderScale ?? 1,
        renderAlpha: actor.renderAlpha ?? 1,
        renderSink: 0,
        renderInHole: false,
        removed: false
      };

      if (overlayActor.type === "player") {
        paintRaisedPlayer(overlayActor, viewCtx);
        return;
      }

      if (overlayActor.type === "circle_player") {
        viewCtx.fillStyle = "#5aa95c";
        viewCtx.beginPath();
        viewCtx.arc(
          left + TILE_SIZE / 2,
          top + TILE_SIZE / 2,
          TILE_SIZE * 0.338 * (overlayActor.renderScale ?? 1),
          0,
          Math.PI * 2
        );
        viewCtx.fill();
        viewCtx.lineWidth = 3;
        viewCtx.strokeStyle = "#000000";
        viewCtx.stroke();
      }
    }

    function captureViewportSnapshot(options = {}, now = performance.now()) {
      const skipActorsPredicate =
        typeof options.skipActorsPredicate === "function" ? options.skipActorsPredicate : null;
      app.liveRaisedPlayerGates = app.gateRenderOverride || app.computeRaisedPlayerGateSet();
      app.syncGateAnimationTargets(now);
      app.syncPlayerLiftAnimationTargets(now);
      const hiddenActors = [];

      if (skipActorsPredicate) {
        state.actors.forEach((actor) => {
          if (!skipActorsPredicate(actor)) {
            return;
          }

          hiddenActors.push({
            actor,
            removed: actor.removed
          });
          actor.removed = true;
        });
      }

      drawScene(now);
      const snapshot = cloneCanvas(composeViewportSource(), viewportRect.width, viewportRect.height);
      hiddenActors.forEach(({ actor, removed }) => {
        actor.removed = removed;
      });
      return snapshot;
    }

    function captureSceneSnapshot(options = {}, now = performance.now()) {
      const skipActorsPredicate =
        typeof options.skipActorsPredicate === "function" ? options.skipActorsPredicate : null;
      app.liveRaisedPlayerGates = app.gateRenderOverride || app.computeRaisedPlayerGateSet();
      app.syncGateAnimationTargets(now);
      app.syncPlayerLiftAnimationTargets(now);
      const hiddenActors = [];

      if (skipActorsPredicate) {
        state.actors.forEach((actor) => {
          if (!skipActorsPredicate(actor)) {
            return;
          }

          hiddenActors.push({
            actor,
            removed: actor.removed
          });
          actor.removed = true;
        });
      }

      drawScene(now);
      const snapshot = cloneCanvas(sceneCanvas, boardRect.width, boardRect.height);
      hiddenActors.forEach(({ actor, removed }) => {
        actor.removed = removed;
      });
      return snapshot;
    }

    function captureForegroundOccluderSnapshot(options = {}, now = performance.now()) {
      const skipActorsPredicate =
        typeof options.skipActorsPredicate === "function" ? options.skipActorsPredicate : null;
      const occludingActor = options.occludingActor || null;
      const hiddenActors = [];

      if (!occludingActor) {
        return null;
      }

      const occluderDepth = actorDepthRow(occludingActor) + (occludingActor.renderInHole ? 0 : 1);
      const occluderTieBreaker =
        occludingActor.renderInHole
          ? -1
          : isCollectibleActor(occludingActor)
            ? 0
            : isPlayerActor(occludingActor)
              ? 2
              : 1;

      app.liveRaisedPlayerGates = app.gateRenderOverride || app.computeRaisedPlayerGateSet();
      app.syncGateAnimationTargets(now);
      app.syncPlayerLiftAnimationTargets(now);

      if (skipActorsPredicate) {
        state.actors.forEach((actor) => {
          if (!skipActorsPredicate(actor)) {
            return;
          }

          hiddenActors.push({
            actor,
            removed: actor.removed
          });
          actor.removed = true;
        });
      }

      sceneCtx.clearRect(0, 0, boardRect.width, boardRect.height);
      paintDepthSortedScene(now, function (item) {
        return (
          item.depth > occluderDepth ||
          (item.depth === occluderDepth && item.tieBreaker > occluderTieBreaker)
        );
      });
      const snapshot = cloneCanvas(sceneCanvas, boardRect.width, boardRect.height);
      hiddenActors.forEach(({ actor, removed }) => {
        actor.removed = removed;
      });
      return snapshot;
    }

    function startLevelTransitionLoop() {
      if (app.levelTransitionFrameId !== null) {
        return;
      }

      function step() {
        app.levelTransitionFrameId = null;
        app.render();
      }

      app.levelTransitionFrameId = window.requestAnimationFrame(step);
    }

    function startLevelTransition(
      fromCanvas,
      toCanvas,
      dx,
      dy,
      player = null,
      fromScene = null,
      fromForeground = null,
      options = {}
    ) {
      app.levelTransition = {
        fromCanvas,
        fromScene,
        fromForeground,
        toCanvas,
        dx,
        dy,
        player,
        startMs: performance.now(),
        durationMs: app.LEVEL_TRANSITION_DURATION_MS,
        onComplete: typeof options.onComplete === "function" ? options.onComplete : null
      };
      app.isTransitioningLevel = true;
      startLevelTransitionLoop();
      app.render();
    }

    function composeLevelTransitionSource(now = performance.now()) {
      const transition = app.levelTransition;

      if (!transition) {
        return null;
      }

      const progress = clamp((now - transition.startMs) / transition.durationMs, 0, 1);
      const eased = easeInOutQuad(progress);
      const worldShiftX = -transition.dx;
      const worldShiftY = -transition.dy;
      const overlap = 0;
      const oldX = worldShiftX * eased * viewportRect.width;
      const oldY = worldShiftY * eased * viewportRect.height;
      const newX = oldX - worldShiftX * (viewportRect.width - overlap);
      const newY = oldY - worldShiftY * (viewportRect.height - overlap);
      let outgoingCameraX = transition.fromScene?.cameraX ?? 0;
      let outgoingCameraY = transition.fromScene?.cameraY ?? 0;
      const incomingCanvas = captureViewportSnapshot({
        skipActorsPredicate: (actor) => isPlayerActor(actor)
      }, now);
      const incomingForegroundCanvas =
        transition.player?.targetActor
          ? captureForegroundOccluderSnapshot(
              {
                occludingActor: transition.player.targetActor,
                skipActorsPredicate: (actor) => isPlayerActor(actor)
              },
              now
            )
          : null;

      viewCtx.clearRect(0, 0, viewportRect.width, viewportRect.height);
      viewCtx.fillStyle = "#d6bd94";
      viewCtx.fillRect(0, 0, viewportRect.width, viewportRect.height);

      if (transition.fromScene?.canvas) {
        if (transition.dx !== 0) {
          outgoingCameraY = app.cameraY;
        }

        if (transition.dy !== 0) {
          outgoingCameraX = app.cameraX;
        }

        drawViewportFromScene(
          viewCtx,
          transition.fromScene.canvas,
          transition.fromScene.boardRect,
          transition.fromScene.viewportRect,
          outgoingCameraX,
          outgoingCameraY,
          oldX,
          oldY
        );
      } else {
        viewCtx.drawImage(transition.fromCanvas, Math.round(oldX), Math.round(oldY));
      }

      viewCtx.drawImage(incomingCanvas || transition.toCanvas, Math.round(newX), Math.round(newY));

      if (transition.player) {
        let sourcePosition = transition.player.from;

        if (transition.player.sourceActor && transition.fromScene) {
          sourcePosition = viewportPositionForActorAtCamera(
            transition.player.sourceActor,
            outgoingCameraX,
            outgoingCameraY,
            transition.fromScene.viewportRect,
            transition.fromScene.boardRect
          );
        }

        const targetActor =
          transition.player.targetActor && !transition.player.targetActor.removed
            ? transition.player.targetActor
            : null;
        const overlayActor = targetActor || transition.player.actor || transition.player.sourceActor;
        const targetPosition = targetActor ? viewportPositionForActor(targetActor) : transition.player.to;
        const overlayLeft =
          sourcePosition.left +
          oldX +
          (targetPosition.left + newX - (sourcePosition.left + oldX)) * eased;
        const overlayTop =
          sourcePosition.top +
          oldY +
          (targetPosition.top + newY - (sourcePosition.top + oldY)) * eased;
        paintTransitionPlayer(overlayActor, overlayLeft, overlayTop);
      }

      if (transition.fromForeground?.canvas) {
        drawViewportFromScene(
          viewCtx,
          transition.fromForeground.canvas,
          transition.fromForeground.boardRect,
          transition.fromForeground.viewportRect,
          outgoingCameraX,
          outgoingCameraY,
          oldX,
          oldY
        );
      }

      if (incomingForegroundCanvas) {
        drawViewportFromScene(
          viewCtx,
          incomingForegroundCanvas,
          boardRect,
          viewportRect,
          app.cameraX,
          app.cameraY,
          newX,
          newY
        );
      }

      return {
        sourceCanvas: viewCanvas,
        active: progress < 1
      };
    }

    function renderWithShader(sourceCanvas, settings) {
      const renderer = app.renderer;

      if (!gl || !renderer || (typeof gl.isContextLost === "function" && gl.isContextLost())) {
        return false;
      }

      gl.viewport(0, 0, canvas.width, canvas.height);
      gl.clearColor(0.839, 0.741, 0.58, 1);
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.useProgram(renderer.program);
      gl.bindBuffer(gl.ARRAY_BUFFER, renderer.positionBuffer);
      gl.enableVertexAttribArray(renderer.attribs.position);
      gl.vertexAttribPointer(renderer.attribs.position, 2, gl.FLOAT, false, 0, 0);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, renderer.texture);
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, sourceCanvas);
      gl.uniform1i(renderer.uniforms.texture, 0);
      gl.uniform2f(renderer.uniforms.logicalResolution, sourceCanvas.width, sourceCanvas.height);
      gl.uniform1f(renderer.uniforms.bleed, settings.bleed);
      gl.uniform1f(renderer.uniforms.bloom, settings.bloom);
      gl.uniform1f(renderer.uniforms.softness, settings.softness);
      gl.uniform1f(renderer.uniforms.scanlines, settings.scanlines);
      gl.uniform1f(renderer.uniforms.mask, settings.mask);
      gl.uniform1f(renderer.uniforms.ghosting, settings.ghosting);
      gl.uniform1f(renderer.uniforms.noise, settings.noise);
      gl.uniform1f(renderer.uniforms.vignetteStrength, settings.vignetteStrength);
      gl.uniform1f(renderer.uniforms.noisePhase, state.effects.noisePhase);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
      return true;
    }

    function renderFallback(sourceCanvas) {
      if (!fallbackCtx) {
        return;
      }

      fallbackCtx.clearRect(0, 0, viewportRect.width, viewportRect.height);
      fallbackCtx.imageSmoothingEnabled = false;
      fallbackCtx.drawImage(sourceCanvas, 0, 0, viewportRect.width, viewportRect.height);
    }

    function render() {
      const now = performance.now();
      syncCameraTarget();
      const isCameraActive = advanceCamera(now);
      const activeLevelTransition = composeLevelTransitionSource(now);

      if (activeLevelTransition) {
        const settings = getEffectSettings();

        if (!renderWithShader(activeLevelTransition.sourceCanvas, settings)) {
          renderFallback(activeLevelTransition.sourceCanvas);
        }

        if (activeLevelTransition.active) {
          startLevelTransitionLoop();
          return;
        }

        const onComplete = app.levelTransition?.onComplete;
        app.levelTransition = null;
        app.isTransitioningLevel = false;

        if (onComplete && onComplete() === false) {
          return;
        }

        if (app.queuedAction) {
          const nextAction = app.queuedAction;
          app.queuedAction = null;
          window.setTimeout(() => {
            app.runAction?.(nextAction);
          }, 0);
        }
      }

      app.liveRaisedPlayerGates = app.gateRenderOverride || app.computeRaisedPlayerGateSet();
      app.syncGateAnimationTargets(now);
      app.syncPlayerLiftAnimationTargets(now);
      drawScene(now);
      const settings = getEffectSettings();
      const sourceCanvas = composeViewportSource();

      if (!renderWithShader(sourceCanvas, settings)) {
        renderFallback(sourceCanvas);
      }

      if (isCameraActive && !app.isAnimating) {
        app.startCameraFollowLoop();
      }
    }

    Object.assign(app, {
      roundRectPath,
      paintFloorTile,
      groundFaceColor,
      paintPlayerLiftArrow,
      paintGroundDropFace,
      paintWallTile,
      paintRaisedPlayerGateTile,
      paintRaisedPlayerLiftTile,
      paintExit,
      paintGround,
      paintWalls,
      paintWeightlessBoxTile,
      paintRaisedPlayer,
      paintFloatingFloor,
      animatedWeightlessGroupMembers,
      paintWeightlessGroup,
      actorDepthRow,
      paintDepthSortedScene,
      buildDrawItems,
      paintActor,
      getEffectSettings,
      drawScene,
      cloneCanvas,
      captureViewportSnapshot,
      viewportPositionForActorAtCamera,
      viewportPositionForActor,
      captureForegroundOccluderSnapshot,
      paintTransitionPlayer,
      elevatedBleedCoverColor,
      paintElevatedSideBleedCover,
      queueElevatedSideBleedCoverItems,
      drawViewportFromScene,
      startLevelTransitionLoop,
      startLevelTransition,
      composeLevelTransitionSource,
      composeViewportSource,
      captureSceneSnapshot,
      renderWithShader,
      renderFallback,
      render
    });
  };
})();
