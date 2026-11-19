import { appendFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

// Claude Code clamps this to the selected model's supported maximum.
// https://code.claude.com/docs/en/env-vars#model-configuration
export const CLAUDE_MAX_OUTPUT_TOKENS = 128000;
const installed = Symbol.for('mazebench.claude-output-limit-v1');

// Apply an operator-requested process setting without modifying a run's
// immutable provider, conversation, checkpoint, model, or tool configuration.
export function installClaudeOutputLimit(owner) {
  if (owner[installed] || typeof owner.runClaudeTurn !== 'function') return;
  const run = owner.runClaudeTurn;
  owner.runClaudeTurn = async function (options) {
    if (options.metadata?.provider !== 'claude-code') return run.call(this, options);
    let environment = options.environment;
    if (!environment) {
      const policy = Object.keys(options.frozen.provider_runtime || {}).find(file =>
        /^benchmarking\/providers(?:-v\d+)?\/claude-policy\.mjs$/.test(file));
      if (!policy) throw new Error('Missing pinned Claude environment policy.');
      const { claudeEnvironment } = await import(pathToFileURL(path.join(options.projectRoot, policy)).href);
      environment = claudeEnvironment();
    }
    const value = String(CLAUDE_MAX_OUTPUT_TOKENS);
    await appendFile(path.join(options.directory, 'claude-runtime-settings.jsonl'), JSON.stringify({
      at: new Date().toISOString(), policy: 'claude-output-limit-v1',
      model: options.metadata.model, session_id: options.metadata.claude_session_id,
      environment: { CLAUDE_CODE_MAX_OUTPUT_TOKENS: value },
      reason: 'Operator requested the maximum supported output limit.'
    }) + '\n', { mode: 0o600 });
    return run.call(this, { ...options,
      environment: { ...environment, CLAUDE_CODE_MAX_OUTPUT_TOKENS: value } });
  };
  Object.defineProperty(owner, installed, { value: true });
}
