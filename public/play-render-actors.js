(function () {
  const modules = window.PlayModules || (window.PlayModules = {});

  modules.registerRenderActorFunctions = function registerRenderActorFunctions(app) {
    const {
      state,
      TILE_SIZE,
      FLOATING_FLOOR_SHADOW_INSET,
      FLOATING_FLOOR_SHADOW_HEIGHT,
      GEM_DRAW_WIDTH,
      GEM_SHADOW_WIDTH,
      GEM_SHADOW_HEIGHT,
      sceneCtx,
      weightlessGroupCanvas,
      weightlessGroupCtx,
      imageCache
    } = app;
    const {
      terrainAt,
      gateLiftAt,
      playerLiftAt,
      orangeWallLiftAt,
      isWeightlessBoxAt,
      weightlessGroupRenderState,
      weightlessGroupMembers,
      floatingFloorHoverOffset,
      isCollectibleActor,
      isPlayerActor,
      actorRenderElevation
    } = app;
    const {
      roundRectPath,
      paintWallTile,
      paintRaisedPlayerGateTile,
      paintRaisedPlayerLiftTile,
      paintRaisedOrangeWallTile,
      queueElevatedSideBleedCoverItems
    } = app.renderTerrain;

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
          paintWeightlessBoxTile(
            member,
            groupState.offsetX,
            groupState.offsetY - (groupState.surfaceLift ?? 0)
          );
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
      const drawTop =
        minY * TILE_SIZE -
        faceHeight +
        groupState.offsetY -
        (groupState.surfaceLift ?? 0);

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
          const orangeWallLift = cell.type === "orange_wall" ? orangeWallLiftAt(x, y, now) : 0;

          if (
            cell.type !== "wall" &&
            gateLift <= 0.001 &&
            playerLift <= 0.001 &&
            orangeWallLift <= 0.001
          ) {
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

              if (cell.type === "orange_wall") {
                paintRaisedOrangeWallTile(x, y, cell, orangeWallLift);
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
        paintWeightlessBoxTile(
          actor,
          groupState.offsetX,
          groupState.offsetY - (groupState.surfaceLift ?? 0)
        );
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

    app.renderActors = {
      paintWeightlessBoxTile,
      paintRaisedPlayer,
      paintFloatingFloor,
      animatedWeightlessGroupMembers,
      paintWeightlessGroup,
      actorDepthRow,
      paintDepthSortedScene,
      buildDrawItems,
      paintActor
    };
  };
})();
