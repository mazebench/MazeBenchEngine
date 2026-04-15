from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any


class GridWorld:
    def __init__(
        self,
        dimensions: tuple[int, int] = (0, 0),
        parser: dict[str, Any] | None = None,
        raw_level: str = "",
    ) -> None:
        self.width, self.height = dimensions
        self.parser = parser or {}
        self.raw_level = raw_level
        self.sprites: list[Sprite] = []

    @property
    def dimensions(self) -> tuple[int, int]:
        return (self.width, self.height)

    def rows_from_level(self) -> list[list[str]]:
        if not self.raw_level:
            return []

        raw_rows = [row for row in self.raw_level.splitlines() if row]
        separator = self.parser.get("rules", {}).get("separator", "")

        if isinstance(separator, str) and separator:
            return [row.split(separator) for row in raw_rows]

        return [list(row) for row in raw_rows]

    def load_level(self, raw_level: str) -> list[list[str]]:
        self.raw_level = raw_level
        rows = self.rows_from_level()
        self.width = max((len(row) for row in rows), default=0)
        self.height = len(rows)
        return rows

    def add_sprite(self, sprite: "Sprite") -> "Sprite":
        sprite.world = self
        self.sprites.append(sprite)
        return sprite

    def remove_sprite(self, sprite: "Sprite") -> None:
        if sprite in self.sprites:
            self.sprites.remove(sprite)
            sprite.world = None

    def update_sprite_position(
        self,
        sprite: "Sprite",
        old_position: tuple[int, int],
    ) -> None:
        del sprite, old_position

    def in_bounds(self, x: int, y: int) -> bool:
        return 0 <= x < self.width and 0 <= y < self.height

    def can_move_to(self, x: int, y: int, sprite: "Sprite" | None = None) -> bool:
        del sprite
        return self.in_bounds(x, y)

    def sprite_at(self, x: int, y: int) -> "Sprite" | None:
        for sprite in reversed(self.sprites):
            if sprite.x == x and sprite.y == y:
                return sprite
        return None


@dataclass
class Sprite:
    image: str
    x: int
    y: int
    name: str = "sprite"
    world: GridWorld | None = field(default=None, init=False, repr=False)

    @property
    def position(self) -> tuple[int, int]:
        return (self.x, self.y)

    def move(self, dx: int, dy: int) -> None:
        if not self.try_move(dx, dy):
            raise ValueError(f"{self.name} cannot move to {(self.x + dx, self.y + dy)}")

    def try_move(self, dx: int, dy: int) -> bool:
        target_x = self.x + dx
        target_y = self.y + dy

        if self.world is not None and not self.world.can_move_to(target_x, target_y, self):
            return False

        old_position = self.position
        self.x = target_x
        self.y = target_y

        if self.world is not None:
            self.world.update_sprite_position(self, old_position)

        return True
