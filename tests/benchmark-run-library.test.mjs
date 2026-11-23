import assert from "node:assert/strict";
import test from "node:test";
import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { RunLibrary } from "../benchmarking/run-library.mjs";
import { createJournal, journalHead, resetJournalCaches } from "../benchmarking/storage/journal.mjs";
import { readCheckpointJson } from "../benchmarking/v1/checkpoint-json.mjs";
import { runCardValues, runPage, runCompany, selectRuns } from "../benchmarking/ui/run-library.mjs";

async function fixture(t) {
  const recordsRoot = await mkdtemp(path.join(os.tmpdir(), "mazebench-library-"));
  t.after(() => rm(recordsRoot, { recursive: true, force: true }));
  const supervisor = { recordsRoot, active: new Map(), initialize: async () => {}, runDirectory: id => path.join(recordsRoot, id) };
  async function add(index = 0, { incremental = true, status = "paused" } = {}) {
    const id = `run-2026-10-03T00-00-00-000Z-${index.toString(16).padStart(6, "0")}`;
    const directory = supervisor.runDirectory(id);
    await mkdir(path.join(directory, "sandbox-state"), { recursive: true });
    await writeFile(path.join(directory, "sandbox-state/integrity-key"), randomBytes(32));
    const metadata = { id, status, model: "fixture", provider: "codex", created_at: new Date(1790985600000 + index * 1000).toISOString(), capability_policy: { large: "x".repeat(10000) } };
    await writeFile(path.join(directory, "run.json"), JSON.stringify(metadata));
    const state = { actionCount: 0, actions: [] };
    const summary = { action_count: 0, gems_collected: 2, rooms_visited: 3, unique_cells: 4, actions: [], positions: [], novelty: [] };
    const writer = incremental ? await createJournal(directory, state, summary, {}) : null;
    if (!incremental) await writeFile(path.join(directory, "summary.json"), JSON.stringify(summary));
    async function move() {
      state.actionCount++; state.actions.push({ action: "up" });
      summary.action_count++; summary.actions.push({ action: "up" });
      await writer.commit(state, summary, {});
    }
    return { id, directory, metadata, state, summary, move };
  }
  return { supervisor, add };
}

test("library exposes quota reset metadata without sending raw provider diagnostics", async t => {
  const { supervisor, add } = await fixture(t);
  const run = await add(0, { status: "failed" });
  run.metadata.error = "API error 429 [request_id=private]: Subscription quota exhausted. Your usage window resets at 2026-10-12T23:21:10Z.";
  await writeFile(path.join(run.directory, "run.json"), JSON.stringify(run.metadata));
  const [value] = await new RunLibrary().list(supervisor);
  assert.deepEqual(value.rate_limit, { reset_at: "2026-10-12T23:21:10.000Z" });
  assert.equal(value.error, undefined);
  assert.equal(JSON.stringify(value).includes("request_id"), false);
});

test("streamed card progress counts actual reads, handles invalid records, and stops on disconnect", async t => {
  const { supervisor, add } = await fixture(t);
  const first = await add(0);
  await first.move();
  const second = await add(1);
  const broken = await add(2);
  await writeFile(path.join(broken.directory, "summary.json"), "invalid");
  const library = new RunLibrary();
  const events = [];
  for await (const event of library.stream([supervisor.recordsRoot, supervisor.recordsRoot])) events.push(event);
  assert.deepEqual(events.map(event => [event.type, event.loaded, event.total]), [
    ["start", 0, 3], ["record", 1, 3], ["record", 2, 3], ["record", 3, 3], ["done", 3, 3],
  ]);
  assert.deepEqual(events.filter(e => e.run).map(e => e.run.id).sort(), [first.id, second.id]);
  assert.equal(events.find(e => e.run?.id === first.id).run.action_count, 1);
  const controller = new AbortController();
  const partial = [];
  for await (const event of library.stream([supervisor.recordsRoot], controller.signal)) {
    partial.push(event);
    if (event.type === "record") controller.abort();
  }
  assert.equal(partial.length, 2);
  const empty = [];
  for await (const event of library.stream([path.join(supervisor.recordsRoot, "missing")])) empty.push(event);
  assert.deepEqual(empty.map(e => [e.type, e.total]), [["start", 0], ["done", 0]]);
});

test("library projects verified counters, caches unchanged summaries, and reflects commits and liveness", async t => {
  const { supervisor, add } = await fixture(t);
  const run = await add(0, { status: "running" });
  await run.move();
  const library = new RunLibrary({ markInterrupted: true });
  const first = await library.list(supervisor);
  assert.equal(first[0].status, "interrupted");
  assert.equal(first[0].recorded_status, "running");
  assert.equal(first[0].action_count, 1);
  assert.equal(first[0].gems_collected, 2);
  for (const name of ["actions", "positions", "novelty", "capability_policy"]) assert.equal(name in first[0], false);
  const cached = await library.summary(run.directory);
  assert.equal(await library.summary(run.directory), cached);
  supervisor.active.set(run.id, {});
  await run.move();
  const updated = (await library.list(supervisor))[0];
  assert.equal(updated.status, "running");
  assert.equal(updated.runner_active, true);
  assert.equal(updated.action_count, 2);
  assert.equal(updated.action_count, (await readCheckpointJson(run.directory, "summary.json")).action_count);
  assert.notEqual(await library.summary(run.directory), cached);
  assert.deepEqual(JSON.parse(await readFile(path.join(run.directory, "run.json"))), run.metadata);
});

test("legacy records, newly queued records, and deleted records remain usable", async t => {
  const { supervisor, add } = await fixture(t);
  const run = await add(0, { incremental: false });
  const queued = await add(1, { incremental: false, status: "queued" });
  await rm(path.join(queued.directory, "summary.json"));
  const library = new RunLibrary();
  assert.deepEqual((await library.list(supervisor)).map(run => run.id), [queued.id, run.id]);
  await writeFile(path.join(run.directory, "summary.json"), JSON.stringify({ ...run.summary, action_count: 25 }));
  assert.equal((await library.list(supervisor))[1].action_count, 25);
  await rm(run.directory, { recursive: true });
  assert.equal((await library.list(supervisor)).length, 1);
  assert.equal(library.cache.has(run.directory), false);
});

test("summary cache rejects changed heads, markers, keys, bases, truncated logs, and links", async t => {
  const { add } = await fixture(t);
  for (const [index, target] of ["checkpoint.json", "summary.json", "display.json", "game-state.json", "sandbox-state/integrity-key", "base-state.json", "base-summary.json", "entries.jsonl", "symlink"].entries()) {
    const run = await add(index);
    await run.move();
    const library = new RunLibrary();
    await library.summary(run.directory);
    const head = journalHead(run.directory);
    const relative = /^(base-|entries)/.test(target) ? `journal/${head.generation}/${target}` : target;
    if (target === "symlink") {
      await rm(path.join(run.directory, "summary.json"));
      await symlink(path.join(run.directory, "display.json"), path.join(run.directory, "summary.json"));
    } else await writeFile(path.join(run.directory, relative), "{}\n");
    await assert.rejects(() => library.summary(run.directory), target);
  }
});

test("large libraries detect old journal edits even after the verifier cache is evicted", async t => {
  const { supervisor, add } = await fixture(t);
  const library = new RunLibrary();
  const first = await add();
  await first.move(); await first.move();
  await library.summary(first.directory);
  for (let index = 1; index <= 30; index++) {
    const run = await add(index);
    await library.summary(run.directory);
  }
  assert.equal((await library.list(supervisor)).length, 31);
  resetJournalCaches();
  const log = path.join(first.directory, `journal/${journalHead(first.directory).generation}/entries.jsonl`);
  const contents = await readFile(log, "utf8");
  await writeFile(log, contents.replace('"up"', '"xx"'));
  await assert.rejects(() => library.summary(first.directory), /verification failed/);
  assert.equal((await library.list(supervisor)).length, 30);
});

test("overlapping library requests share one scan", async t => {
  const { supervisor, add } = await fixture(t);
  await add();
  let release, scans = 0;
  const gate = new Promise(resolve => { release = resolve; });
  supervisor.initialize = async () => { scans++; await gate; };
  const library = new RunLibrary();
  const first = library.list(supervisor), second = library.list(supervisor);
  release();
  assert.equal(await first, await second);
  assert.equal(scans, 1);
});

test("a thousand runs render at most 24 cards and page indices recover after deletion", () => {
  const runs = Array.from({ length: 1000 }, (_, id) => ({ id }));
  assert.equal(runPage(runs).runs.length, 24);
  assert.equal(runPage(runs).totalPages, 42);
  assert.equal(runPage(runs, 41).runs.length, 16);
  assert.equal(runPage(runs, 99).page, 41);
  assert.equal(runPage(runs.slice(0, 25), 41).page, 1);
  assert.equal(runPage(runs, -1).page, 0);
  assert.deepEqual(runPage([], 99), { page: 0, totalPages: 1, total: 0, runs: [] });
});

test("cards retain world-specific scores and use a fixed elapsed time for paused runs", () => {
  const run = { id: "fixture", created_at: "2026-10-03T00:00:00Z", paused_at: "2026-10-03T00:02:00Z", runner_active: false, status: "paused", effort: "high", action_count: 50, action_limit: 100, gems_collected: 8, rooms_visited: 4, unique_cells: 20 };
  const main = runCardValues(run, { now: Date.parse("2026-10-03T00:02:00Z") });
  assert.equal(main.progress, 50);
  assert.match(main.meta, /2m 0s$/);
  assert.deepEqual(main.metrics, [["Actions", "50/100"], ["Gems", "8"], ["Rooms", "4"]]);
  assert.equal(main.timestamp, "2 mins ago");
  const ice = runCardValues({ ...run, world: "ice-maze", levels_solved: 5, levels_total: 30, level_number: 6 });
  assert.deepEqual(ice.metrics.slice(1, 3), [["Levels solved", "5/30"], ["Level", "6"]]);
});

test("compact cards identify the model company independently of its runner", () => {
  const direct = runCardValues({ provider: "claude-code", model: "claude-sonnet-5-5", effort: "high", tools_enabled: false });
  const hosted = runCardValues({ provider: "prime-agent", model: "anthropic/claude-sonnet-5-5" });
  assert.equal(direct.logo, hosted.logo);
  assert.match(direct.logo, /\/assets\/model-logos\/claude-color\.svg$/);
  assert.equal(direct.tools, "Coding off");
  assert.equal(hosted.tools, "Coding on");
  assert.equal(direct.effort, "high");
  assert.equal(hosted.effort, "default");
  const nvidia = runCardValues({ provider: "prime-agent", model: "nvidia/nemotron-3.5-lightning" });
  assert.match(nvidia.logo, /\/assets\/model-logos\/nvidia-color\.svg$/);
  assert.equal(runCompany({ model: "nemotron-3.5-lightning" }), "NVIDIA");
  const unknown = runCardValues({ provider: "prime-agent", model: "unknown/new-model" });
  assert.equal(unknown.logo, null);
  assert.equal(unknown.company, "unknown");
});

test("company and model filters compose, and sorting groups models with newest runs first", () => {
  const runs = [
    { id: "sol", model: "gpt-6-sol", provider: "codex", created_at: "2026-10-03" },
    { id: "astra-old", model: "gpt-6-astra", provider: "codex", created_at: "2026-10-01" },
    { id: "claude", model: "claude-sonnet-5-5", provider: "claude-code", created_at: "2026-10-02" },
    { id: "astra-new", model: "gpt-6-astra", provider: "codex", created_at: "2026-10-02" },
    { id: "gemini", model: "gemini-3.8-flash", provider: "antigravity", created_at: "2026-10-01" },
    { id: "grok", model: "grok-4.7", provider: "grok-build", created_at: "2026-10-01" }
  ];
  const originalOrder = runs.map(run => run.id);
  assert.deepEqual(selectRuns(runs, { company: "OpenAI", model: "gpt-6-astra" }).map(run => run.id), ["astra-new", "astra-old"]);
  assert.equal(selectRuns(runs, { company: "Anthropic (Claude)" })[0].id, "claude");
  assert.deepEqual(selectRuns(runs, { sort: "company" }).map(run => run.id), ["claude", "gemini", "astra-new", "astra-old", "sol", "grok"]);
  assert.deepEqual(selectRuns(runs, { company: "OpenAI", sort: "model" }).map(run => run.id), ["astra-new", "astra-old", "sol"]);
  assert.equal(selectRuns(runs)[0].id, "sol");
  assert.equal(selectRuns(runs, { company: "OpenAI", model: "claude-sonnet-5-5" }).length, 0);
  assert.equal(runCompany({ model: "claude-sonnet-5-5" }), "Anthropic (Claude)");
  assert.deepEqual(runs.map(run => run.id), originalOrder);
});
