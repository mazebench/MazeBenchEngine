# Benchmark versions

Version labels use the source repository generation, as requested:

| Run origin | Label |
| --- | --- |
| Created in MazeBenchBenchmarking | `v1.1` |
| Prior run created in an earlier repository | `v1.0` |

This applies to every harness and game. Importing an old run into this repository
keeps it at v1.0; publishing a native run to the website keeps it at v1.1. The
current location of an exported or imported file does not change its origin.
Engine changes, world edits, and live room revisions do not add badge qualifiers
or change these generation labels.

Local run cards, run details, heatmap comparison selectors, and the right side
of public leaderboard rows display the same concise label. Model names stay
separate.

## Catalogue

* 42 native local runs: v1.1.
* 232 prior comparison imports: v1.0.
* 67 published leaderboard rows: 25 native v1.1 and 42 prior v1.0.

`docs/run-version-catalogue.json` contains native local records. The website
repository uses `docs/benchmark-version-catalogue.json` for published records.

## Automatic assignment

`repositoryRunVersion` records `benchmark_release` and marks the classification
as `repository-generation`. The local run API and native publication importers
assign v1.1 automatically. Legacy imports assign v1.0 automatically, including
records without historical hashes. Exported snapshots retain their labels.

Recorded engine/world fingerprints remain available as supporting provenance;
they do not determine the displayed generation. No signed runtime, checkpoint,
score, heatmap, or model history is changed to add a label. A future versioning
policy should be an explicit change rather than an automatic bump from an edit.
