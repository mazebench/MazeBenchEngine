from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from games.shared import GridWorld, Sprite

MAZE_DIR = Path(__file__).resolve().parent


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


class Player(MazeSprite):
    token = "p"

    def __init__(self, x: int, y: int, *, name: str = "player") -> None:
        super().__init__(x, y, name=name)


class PythonPlayer(Player):
    def __init__(self, x: int, y: int) -> None:
        super().__init__(x, y, name="python_player")

    def choose_move(self, world: "MazeWorld") -> tuple[int, int]:
        del world
        return (0, 0)


class MazeWorld(GridWorld):
    object_classes: dict[str, type[MazeSprite]] = {
        "wall": Wall,
        "player": PythonPlayer,
        "exit": Exit,
        "ice": Ice,
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
                    object_name = self.object_name_for_token(token)
                    if object_name is None:
                        continue

                    sprite = self.build_sprite(object_name, x, y)
                    self.add_sprite(sprite)

        return rows

    def object_name_for_token(self, token: str) -> str | None:
        for object_name, config in self.parser.get("objects", {}).items():
            if config.get("token") == token:
                return object_name
        return None

    def build_sprite(self, object_name: str, x: int, y: int) -> MazeSprite:
        sprite_class = self.object_classes.get(object_name, MazeSprite)
        return sprite_class(x, y)

    def add_sprite(self, sprite: MazeSprite) -> MazeSprite:
        super().add_sprite(sprite)
        self.tiles.setdefault(sprite.position, []).append(sprite)
        return sprite

    def tile_has_name(self, x: int, y: int, name: str) -> bool:
        return any(sprite.name == name for sprite in self.tiles.get((x, y), []))

    def update_sprite_position(self, sprite: Sprite, old_position: tuple[int, int]) -> None:
        old_tile = self.tiles.get(old_position, [])
        if sprite in old_tile:
            old_tile.remove(sprite)
        if not old_tile and old_position in self.tiles:
            del self.tiles[old_position]
        self.tiles.setdefault(sprite.position, []).append(sprite)

        dx = sprite.x - old_position[0]
        dy = sprite.y - old_position[1]

        if (dx, dy) != (0, 0) and self.tile_has_name(sprite.x, sprite.y, "ice"):
            sprite.try_move(dx, dy)

    def can_move_to(self, x: int, y: int, sprite: Sprite | None = None) -> bool:
        if not self.in_bounds(x, y):
            return False

        for occupant in self.tiles.get((x, y), []):
            if occupant is sprite:
                continue
            if getattr(occupant, "solid", False):
                return False

        return True

    def find_player(self) -> PythonPlayer | None:
        for sprite in self.sprites:
            if isinstance(sprite, PythonPlayer):
                return sprite
        return None
