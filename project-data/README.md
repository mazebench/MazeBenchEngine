# VoxelBench project data

The local editor automatically reads and writes `project.json` plus the files
under `tests/`. The manifest contains physics roles, block definitions, suite
hierarchical tags, searches, and the ordered test index. Each test belongs to
exactly one top-level tag group and any number of subtags inside that group.
Tests without an authored subtag live in the group's reserved `Default`
subtag; deeper membership remains visible from every ancestor. Every test owns one compact
file containing a palette, its full Start frame, and lossless add/remove deltas
for subsequent ticks and Expected. Static floor and terrain are therefore not
repeated in every frame.

`npm run migrate:project-data` converts the legacy monolithic
`voxelbench-project.json` after verifying every test, frame, and voxel. The web
importer still accepts old monolithic exports, while new browser backups and
exports use the same self-contained compact bundle representation.

`npm run migrate:tag-groups` is the idempotent schema-15 migration that adds
each group's reserved `Default` subtag and constrains every test's direct
subtags to its single parent group.

Browser storage is retained only as a fallback and as a one-time migration
source when the repo-backed project file does not exist yet.
