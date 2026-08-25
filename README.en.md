# dsh-codex-ultra-mode

[![npm version](https://img.shields.io/npm/v/dsh-codex-ultra-mode.svg)](https://www.npmjs.com/package/dsh-codex-ultra-mode)
[![license](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)

An Ultra-like dynamic multi-agent mode for DeepSeek Harness. `/ultra <goal>` lets the root model create focused continuable subagents, follow them up, wait on cursor-based lifecycle events, reconcile their findings, and deliver one integrated result.

This is an independent behavioral reimplementation based only on publicly documented orchestration semantics. It contains no OpenAI code and does not claim to reproduce private Codex prompts, routing algorithms, training, or model capabilities.

## Highlights

- Scoped `spawn_agent`, `followup_task`, and event-driven `wait_agent` tools.
- Reuses DSH-native `send_message`, `interrupt_agent`, `list_agents`, and child `report`.
- Recursive, model-directed delegation instead of an upfront task DAG.
- Tree-wide defaults: three active subagents, depth three, twelve total.
- Monotonic, bounded cursor updates; the mirror keeps 512 events by default and truncates mirrored text to 2,000 characters without deleting the original DSH session messages.
- Bounded completion barrier: after its step budget, exact tracked child branches and their descendant forests are released and disclosed rather than spinning forever.
- Single-writer default blocks standard DSH mutation tools; add third-party mutators to `childDenyTools`. This is a collaboration guardrail, not a universal sandbox.
- Native `subagent` and `subagent_fork` spawning is denied inside Ultra; tracked continuable work always uses `spawn_agent`.
- No extra tools or system-prompt cost before `/ultra` activation.

## Install and use

Requires DeepSeek Harness `0.1.1-rc.2`. Install the published npm package:

```bash
dsh plugin --profile web add dsh-codex-ultra-mode@0.1.0
```

If `dsh` is not on `PATH`:

```bash
npx @deepseek-ai/dsh@0.1.1-rc.2 plugin --profile web add dsh-codex-ultra-mode@0.1.0
```

Validate the composed profile and restart DSH Web:

```bash
dsh --profile web --dump-config
dsh web
```

For source development:

```bash
git clone https://github.com/null5069/dsh-codex-ultra-mode.git
cd dsh-codex-ultra-mode
npm install --ignore-scripts
npm test
dsh plugin --profile web add link:"$PWD"
```

Restart DSH Web, then run:

```text
/ultra audit this codebase for authentication flaws, implement the important fixes, and run regression tests
```

The plugin targets the DSH `0.1.1-rc.2` public runtime. Ultra topology and cursors are process-local; restart or HMR drains tracked Ultra branches and requires `/ultra` reactivation, although DSH still retains its underlying child sessions. Exact drain discards unclaimed pending inbox work for those branches, and a settlement that arrives after the bounded drain wait may wake the root as a late diagnostic. See the Chinese README for the full configuration, safety model, and known semantic differences from Codex Ultra.

Agent Teams and Ultra can be installed in the same profile, but currently use them in separate sessions. Ultra does not count, wait for, or drain Agent Teams members, so do not mix `/ultra` and `/agent-teams` inside one task.
