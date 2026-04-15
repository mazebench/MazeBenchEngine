from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from games.shared import GridWorld, Sprite

MAZE_DIR = Path(__file__).resolve().parent


def config_tokens(config: dict[str, Any]) -> list[str]:
    token = config.get("token")
    if isinstance(token, str) and token:
        return [token]

    tokens = config.get("tokens")
    if isinstance(tokens, list):
        return [token for token in tokens if isinstance(token, str) and token]

    return []


class MazeSprite(Sprite):
    token = "?"
    solid = False

    def __init__(self, x: int, y: int, *, image: str | None = None, name: str | None = None) -> None:
        super().__init__(
            image=image or self.token,
            x=x,
            y=y,
            name=name or self.__class__.__name__.lower(),
        )


class Wall(MazeSprite):
    token = "#"
    solid = True

    def __init__(self, x: int, y: int) -> None:
        super().__init__(x, y, name="wall")


class Floor(MazeSprite):
    token = "."

    def __init__(self, x: int, y: int) -> None:
        super().__init__(x, y, name="floor")


class Exit(MazeSprite):
    token = "e"

    def __init__(self, x: int, y: int) -> None:
        super().__init__(x, y, name="exit")


class Ice(MazeSprite):
    token = "i"

    def __init__(self, x: int, y: int) -> None:
        super().__init__(x, y, name="ice")


class Hole(MazeSprite):
    token = "h"

    def __init__(self, x: int, y: int) -> None:
        super().__init__(x, y, name="hole")


class Box(MazeSprite):
    token = "b"
    solid = True

    def __init__(self, x: int, y: int) -> None:
        super().__init__(x, y, name="box")


class WeightlessBox(MazeSprite):
    token = "M"
    solid = True

    def __init__(self, x: int, y: int, *, group_key: str) -> None:
        self.group_key = group_key
        super().__init__(x, y, name="weightless_box")


class Player(MazeSprite):
    token = "p"

    def __init__(self, x: int, y: int, *, name: str = "player") -> None:
        super().__init__(x, y, name=name)

    def try_move(self, dx: int, dy: int, *, allow_push: bool = True) -> bool:
        if allow_push and isinstance(self.world, MazeWorld):
            pushable = self.world.pushable_at(self.x + dx, self.y + dy)
            if pushable is not None:
                snapshot = self.world.snapshot_state()
                push_budget = self.world.contiguous_player_count(self, dx, dy)
                if self.world.try_push_actor(pushable, dx, dy, push_budget) is None:
                    self.world.restore_state(snapshot)
                    return False

        return super().try_move(dx, dy, allow_push=allow_push)


class PythonPlayer(Player):
    def __init__(self, x: int, y: int) -> None:
        super().__init__(x, y, name="python_player")

    def choose_move(self, world: "MazeWorld") -> tuple[int, int]:
        del world
        return (0, 0)


class CirclePlayer(Player):
    token = "cp"

    def __init__(self, x: int, y: int) -> None:
        super().__init__(x, y, name="circle_player")


class MazeWorld(GridWorld):
    object_classes: dict[str, type[MazeSprite]] = {
        "wall": Wall,
        "player": PythonPlayer,
        "circle_player": CirclePlayer,
        "box": Box,
        "weightless_box": WeightlessBox,
        "exit": Exit,
        "ice": Ice,
        "hole": Hole,
        "floor": Floor,
    }

    def __init__(self, parser: dict[str, Any] | None = None, raw_level: str = "") -> None:
        super().__init__(parser=parser or {}, raw_level=raw_level)
        self.tiles: dict[tuple[int, int], list[MazeSprite]] = {}
        if raw_level:
            self.parse_level(raw_level)

    @classmethod
    def from_disk(cls, level_name: str = "level1.txt") -> "MazeWorld":
        parser = json.loads((MAZE_DIR / "level_parsing.json").read_text(encoding="utf8"))
        raw_level = (MAZE_DIR / "levels" / level_name).read_text(encoding="utf8")
        return cls(parser=parser, raw_level=raw_level)

    def register_object_class(self, name: str, object_class: type[MazeSprite]) -> None:
        self.object_classes = {**self.object_classes, name: object_class}

    def parse_level(self, raw_level: str | None = None) -> list[list[str]]:
        if raw_level is not None:
            self.raw_level = raw_level

        self.sprites.clear()
        self.tiles.clear()

        rows = self.load_level(self.raw_level)
        for y, row in enumerate(rows):
            for x, cell in enumerate(row):
                for token in self.tokens_from_cell(cell):
                    definition = self.object_definition_for_token(token)
                    if definition is None:
                        continue

                    sprite = self.build_sprite(definition["name"], x, y, token=definition["token"])
                    self.add_sprite(sprite)

        return rows

    def object_definition_for_token(self, token: str) -> dict[str, str] | None:
        for object_name, config in self.parser.get("objects", {}).items():
            if token in config_tokens(config):
                return {"name": object_name, "token": token}
        return None

    def build_sprite(self, object_name: str, x: int, y: int, *, token: str | None = None) -> MazeSprite:
        if object_name == "weightless_box":
            return WeightlessBox(x, y, group_key=token or WeightlessBox.token)

        sprite_class = self.object_classes.get(object_name, MazeSprite)
        return sprite_class(x, y)

    def add_sprite(self, sprite: MazeSprite) -> MazeSprite:
        super().add_sprite(sprite)
        self.tiles.setdefault(sprite.position, []).append(sprite)
        return sprite

    def remove_sprite(self, sprite: MazeSprite) -> None:
        tile = self.tiles.get(sprite.position, [])

        if sprite in tile:
            tile.remove(sprite)

        if not tile and sprite.position in self.tiles:
            del self.tiles[sprite.position]

        super().remove_sprite(sprite)

    def tile_has_name(self, x: int, y: int, name: str) -> bool:
        return any(sprite.name == name for sprite in self.tiles.get((x, y), []))

    def pushable_at(self, x: int, y: int) -> Box | WeightlessBox | None:
        for sprite in self.tiles.get((x, y), []):
            if isinstance(sprite, (Box, WeightlessBox)):
                return sprite
        return None

    def player_at(self, x: int, y: int) -> Player | None:
        for sprite in self.tiles.get((x, y), []):
            if isinstance(sprite, Player):
                return sprite
        return None

    def contiguous_player_count(self, player: Player, dx: int, dy: int) -> int:
        count = 1
        check_x = player.x
        check_y = player.y

        while True:
            check_x -= dx
            check_y -= dy

            if self.player_at(check_x, check_y) is None:
                break

            count += 1

        return count

    def weightless_group_members(self, group_key: str) -> list[WeightlessBox]:
        return [
            sprite
            for sprite in self.sprites
            if isinstance(sprite, WeightlessBox) and sprite.group_key == group_key
        ]

    def push_entity_key(self, sprite: Box | WeightlessBox) -> tuple[str, str | int]:
        if isinstance(sprite, WeightlessBox):
            return ("weightless", sprite.group_key)

        return ("box", id(sprite))

    def push_weight(self, sprite: Box | WeightlessBox) -> int:
        return 1 if isinstance(sprite, Box) else 0

    def push_actor_members(self, sprite: Box | WeightlessBox) -> list[Box | WeightlessBox]:
        if isinstance(sprite, WeightlessBox):
            return self.weightless_group_members(sprite.group_key)

        return [sprite]

    def snapshot_state(self) -> list[tuple[Sprite, tuple[int, int]]]:
        return [(sprite, sprite.position) for sprite in self.sprites]

    def restore_state(self, snapshot: list[tuple[Sprite, tuple[int, int]]]) -> None:
        self.sprites.clear()
        self.tiles.clear()

        for sprite, position in snapshot:
            sprite.x, sprite.y = position
            self.add_sprite(sprite)

    def can_move_weightless_group(self, members: list[WeightlessBox], dx: int, dy: int) -> bool:
        for member in members:
            target_x = member.x + dx
            target_y = member.y + dy

            if not self.in_bounds(target_x, target_y):
                return False

            for occupant in self.tiles.get((target_x, target_y), []):
                if occupant in members:
                    continue
                if getattr(occupant, "solid", False):
                    return False

        return True

    def sync_sprite_tile(self, sprite: Sprite, old_position: tuple[int, int]) -> None:
        old_tile = self.tiles.get(old_position, [])
        if sprite in old_tile:
            old_tile.remove(sprite)
        if not old_tile and old_position in self.tiles:
            del self.tiles[old_position]
        self.tiles.setdefault(sprite.position, []).append(sprite)

    def try_move_weightless_group(self, group_key: str, dx: int, dy: int) -> bool:
        members = self.weightless_group_members(group_key)

        if not members:
            return False

        moved = False

        while self.can_move_weightless_group(members, dx, dy):
            old_positions = [(member, member.position) for member in members]

            for member in members:
                member.x += dx
                member.y += dy

            for member, old_position in old_positions:
                self.sync_sprite_tile(member, old_position)

            moved = True

            if all(self.tile_has_name(member.x, member.y, "hole") for member in members):
                break

            if not all(
                self.tile_has_name(member.x, member.y, "ice")
                or self.tile_has_name(member.x, member.y, "hole")
                for member in members
            ):
                break

        if moved and all(self.tile_has_name(member.x, member.y, "hole") for member in members):
            for member in list(members):
                self.remove_sprite(member)

        return moved

    def try_push_actor(
        self,
        sprite: Box | WeightlessBox,
        dx: int,
        dy: int,
        budget: int,
        handled: set[tuple[str, str | int]] | None = None,
    ) -> int | None:
        if handled is None:
            handled = set()

        entity_key = self.push_entity_key(sprite)

        if entity_key in handled:
            return budget

        cost = self.push_weight(sprite)

        if budget < cost:
            return None

        remaining_budget = budget - cost
        members = self.push_actor_members(sprite)
        member_ids = {id(member) for member in members}
        blockers: list[Box | WeightlessBox] = []
        blocker_keys: set[tuple[str, str | int]] = set()

        for member in members:
            target_x = member.x + dx
            target_y = member.y + dy

            if not self.in_bounds(target_x, target_y):
                return None

            for occupant in self.tiles.get((target_x, target_y), []):
                if id(occupant) in member_ids:
                    continue

                if not isinstance(occupant, (Box, WeightlessBox)):
                    if getattr(occupant, "solid", False):
                        return None
                    continue

                blocker_key = self.push_entity_key(occupant)

                if blocker_key not in blocker_keys:
                    blockers.append(occupant)
                    blocker_keys.add(blocker_key)

        for blocker in blockers:
            result = self.try_push_actor(blocker, dx, dy, remaining_budget, handled)

            if result is None:
                return None

            remaining_budget = result

        moved = (
            self.try_move_weightless_group(sprite.group_key, dx, dy)
            if isinstance(sprite, WeightlessBox)
            else sprite.try_move(dx, dy, allow_push=False)
        )

        if not moved:
            return None

        handled.add(entity_key)
        return remaining_budget

    def update_sprite_position(self, sprite: Sprite, old_position: tuple[int, int]) -> None:
        self.sync_sprite_tile(sprite, old_position)

        if isinstance(sprite, WeightlessBox):
            return

        if self.tile_has_name(sprite.x, sprite.y, "hole"):
            self.remove_sprite(sprite)
            return

        dx = sprite.x - old_position[0]
        dy = sprite.y - old_position[1]

        if (dx, dy) != (0, 0) and self.tile_has_name(sprite.x, sprite.y, "ice"):
            sprite.try_move(dx, dy, allow_push=False)

    def can_move_to(self, x: int, y: int, sprite: Sprite | None = None) -> bool:
        if not self.in_bounds(x, y):
            return False

        for occupant in self.tiles.get((x, y), []):
            if occupant is sprite:
                continue
            if getattr(occupant, "solid", False):
                return False

        return True

    def find_player(self) -> Player | None:
        for sprite in self.sprites:
            if isinstance(sprite, Player):
                return sprite
        return None
