const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.join(__dirname, "..");
const pages = fs.readFileSync(path.join(root, "server", "pages.js"), "utf8");
const runScript = fs.readFileSync(path.join(root, "public", "agent-run.js"), "utf8");
const siteTheme = fs.readFileSync(path.join(root, "public", "local-site.css"), "utf8");

assert.match(pages, /id="run-feed-search" type="search"/);
assert.match(pages, /id="run-feed-export"[^>]+title="Export every move and its reasoning as JSON"/);
assert.equal((pages.match(/\$\{movesSection\}/g) || []).length, 2);
assert.match(runScript, /function feedSearchTerms\(query\)/);
assert.match(runScript, /return terms\.every\(\(term\) => text\.includes\(term\)\)/);
assert.match(runScript, /function formatReasoning\(reasoning, terms\)/);
assert.match(runScript, /<mark>\$\{escapeText\(part\)\}<\/mark>/);
assert.match(runScript, /export_scope: "all_moves"/);
assert.match(runScript, /new Blob\(\[.*JSON\.stringify\(payload, null, 2\)/s);
assert.match(runScript, /reasoning: state\.reasoning\.get\(turn\) \|\| null/);
assert.match(runScript, /data-feed-expand=/);
assert.match(runScript, /function isMultiAgentRun\(\)/);
assert.match(runScript, /const agentBadge = multiAgentRun && activeAgents/);
assert.match(siteTheme, /\.run-feed-toolbar \{/);
assert.match(siteTheme, /\.agent-feed__reasoning\.is-collapsible:not\(\.is-expanded\) p \{/);
assert.match(siteTheme, /\.agent-feed mark \{/);
assert.doesNotMatch(siteTheme, /box-shadow: inset 3px 0 0/);

console.log("agent-run-feed-source: OK — move logs are searchable, exportable, and clean in single-agent mode.");
