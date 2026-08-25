# Changelog

## 0.1.0 — 2026-08-25

- Add deterministic `/ultra <goal>` activation.
- Add scoped `spawn_agent`, `followup_task`, and cursor-based `wait_agent` tools.
- Reuse DSH-native `send_message`, `interrupt_agent`, `list_agents`, and child `report`.
- Add tree-wide concurrency, depth, and total-agent limits.
- Add a bounded event-driven completion barrier with exact branch-forest drain and a hard closing gate.
- Add first-step activation, run epochs, cold-resume failure handling, exact unload cleanup, and atomic cold-wake reservations.
- Deny native one-shot/detached subagent tools inside Ultra and add configurable third-party mutation-tool denial.
