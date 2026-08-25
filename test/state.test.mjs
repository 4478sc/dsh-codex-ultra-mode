import test from "node:test";
import assert from "node:assert/strict";
import { resolveConfig } from "../lib/policy.js";
import { UltraRegistry } from "../lib/state.js";

function registry(overrides = {}) {
  return new UltraRegistry(resolveConfig({
    maxConcurrentSubagents: 3,
    maxDepth: 3,
    maxTotalSubagents: 12,
    ...overrides
  }));
}

test("builds a recursive named tree and enforces sibling names", () => {
  const state = registry();
  state.activateRoot("root");
  const a = state.provisionAgent({ id: "a", parentId: "root", name: "research", lastTask: "inspect" });
  state.commitAgent("a");
  const b = state.provisionAgent({ id: "b", parentId: "a", name: "review", lastTask: "verify" });
  assert.equal(a.path, "/root/research");
  assert.equal(b.path, "/root/research/review");
  assert.equal(b.depth, 2);
  assert.throws(
    () => state.provisionAgent({ id: "c", parentId: "root", name: "research", lastTask: "duplicate" }),
    /TASK_NAME_CONFLICT/u
  );
});

test("enforces tree-wide concurrency, depth, and total limits", () => {
  const concurrent = registry({ maxConcurrentSubagents: 2 });
  concurrent.activateRoot("root");
  concurrent.provisionAgent({ id: "a", parentId: "root", name: "a", lastTask: "a" });
  concurrent.provisionAgent({ id: "b", parentId: "root", name: "b", lastTask: "b" });
  assert.deepEqual(concurrent.canSpawn("root").code, "CONCURRENCY_LIMIT");

  const depth = registry({ maxDepth: 1 });
  depth.activateRoot("root");
  depth.provisionAgent({ id: "a", parentId: "root", name: "a", lastTask: "a" });
  assert.equal(depth.canSpawn("a").code, "DEPTH_LIMIT");

  const total = registry({ maxConcurrentSubagents: 8, maxTotalSubagents: 1 });
  total.activateRoot("root");
  total.provisionAgent({ id: "a", parentId: "root", name: "a", lastTask: "a" });
  assert.equal(total.canSpawn("root").code, "AGENT_LIMIT");
});

test("parallel cold wakes reserve the same tree-wide concurrency pool", () => {
  const state = registry({ maxConcurrentSubagents: 1, maxTotalSubagents: 3 });
  state.activateRoot("root");
  state.addAgent({ id: "a", parentId: "root", status: "ready", name: "a" });
  state.addAgent({ id: "b", parentId: "root", status: "ready", name: "b" });
  assert.equal(state.reserveWake(Symbol.for("wake-a"), "root", "a").ok, true);
  assert.equal(state.reserveWake(Symbol.for("wake-b"), "root", "b").code, "CONCURRENCY_LIMIT");
});

test("a cold-wake reservation does not consume the total-agent creation budget", () => {
  const state = registry({ maxConcurrentSubagents: 2, maxTotalSubagents: 2 });
  state.activateRoot("root");
  state.addAgent({ id: "existing", parentId: "root", status: "ready", name: "existing" });
  const token = Symbol("wake-existing");
  assert.equal(state.reserveWake(token, "root", "existing").ok, true);
  assert.equal(state.canSpawn("root").ok, true);
  state.releaseReservation(token);
});

test("rollback releases a reserved path and total slot", () => {
  const state = registry({ maxTotalSubagents: 1 });
  state.activateRoot("root");
  state.provisionAgent({ id: "a", parentId: "root", name: "worker", lastTask: "x" });
  state.rollbackAgent("a", "provider failed");
  assert.equal(state.node("a"), undefined);
  assert.equal(state.canSpawn("root").ok, true);
  assert.doesNotThrow(() => state.provisionAgent({ id: "b", parentId: "root", name: "worker", lastTask: "y" }));
});

test("idle is not terminal until the paired subagent end", () => {
  const state = registry({ maxConcurrentSubagents: 1 });
  state.activateRoot("root");
  state.provisionAgent({ id: "a", parentId: "root", name: "worker", lastTask: "x" });
  state.addAgent({ id: "a", parentId: "root", status: "idle" });
  assert.equal(state.activeCount("root"), 1);
  assert.equal(state.runningDescendants("root").length, 1);
  state.markStatus("a", "ready", "end", { stopReason: "completed" });
  assert.equal(state.activeCount("root"), 0);
});

test("failed start rolls back even after agent publication", () => {
  const state = registry();
  state.activateRoot("root");
  state.provisionAgent({ id: "a", parentId: "root", name: "worker", lastTask: "x" });
  state.addAgent({ id: "a", parentId: "root", status: "idle" });
  state.rollbackAgent("a", "admission failed");
  assert.equal(state.node("a"), undefined);
  assert.equal(state.canSpawn("root").ok, true);
});

test("native publication disposed before start becomes terminal, but a started activation waits for end", () => {
  const state = registry({ maxConcurrentSubagents: 1 });
  state.activateRoot("root");
  state.addAgent({ id: "native", parentId: "root", status: "idle", name: "native" });
  state.markAgentDisposed("native");
  assert.equal(state.node("native").status, "failed");
  assert.equal(state.activeCount("root"), 0);

  state.beginRun("root");
  state.addAgent({ id: "started", parentId: "root", status: "idle", name: "started" });
  state.markStatus("started", "running", "start");
  state.markStatus("started", "idle");
  state.markAgentDisposed("started");
  assert.equal(state.node("started").status, "idle");
  assert.equal(state.activeCount("root"), 1);
});

test("a new idle-root /ultra run retires old accounting and names", () => {
  const state = registry({ maxConcurrentSubagents: 2, maxTotalSubagents: 1 });
  state.activateRoot("root");
  state.addAgent({ id: "old", parentId: "root", status: "ready", name: "worker" });
  assert.equal(state.canSpawn("root").code, "AGENT_LIMIT");
  const restarted = state.beginRun("root");
  assert.deepEqual(restarted.retiredAgentIds, ["old"]);
  assert.equal(state.node("old"), undefined);
  assert.equal(state.canSpawn("root").ok, true);
  assert.doesNotThrow(() => state.provisionAgent({ id: "new", parentId: "root", name: "worker", lastTask: "new" }));
});

test("reactivation does not reset a run while descendants are active", () => {
  const state = registry();
  state.activateRoot("root");
  state.provisionAgent({ id: "a", parentId: "root", name: "a", lastTask: "work" });
  const reactivated = state.beginRun("root");
  assert.deepEqual(reactivated.retiredAgentIds, []);
  assert.notEqual(state.node("a"), undefined);
});

test("reactivation does not reset a run while a cold wake owns a reservation", () => {
  const state = registry();
  state.activateRoot("root");
  state.addAgent({ id: "child", parentId: "root", status: "ready", name: "child" });
  const token = Symbol("cold-wake");
  assert.equal(state.reserveWake(token, "root", "child").ok, true);
  state.beginRun("root");
  assert.equal(state.rootForAgent("root").run, 1);
  state.releaseReservation(token);
  state.beginRun("root");
  assert.equal(state.rootForAgent("root").run, 2);
});

test("a failed cold-resume publication is terminal even after an earlier successful run", () => {
  const state = registry({ maxConcurrentSubagents: 1 });
  state.activateRoot("root");
  state.addAgent({ id: "child", parentId: "root", status: "idle", name: "child" });
  state.markStatus("child", "running", "start", { runId: "run-1" });
  state.markStatus("child", "ready", "end", { runId: "run-1" });
  assert.equal(state.node("child").started, true);

  state.markPublished("child", "idle");
  assert.equal(state.node("child").started, false);
  state.markAgentDisposed("child");
  assert.equal(state.node("child").status, "failed");
  assert.equal(state.activeCount("root"), 0);
});

test("cursor wait wakes on matching report and never consumes history", async () => {
  const state = registry();
  state.activateRoot("root");
  state.provisionAgent({ id: "a", parentId: "root", name: "worker", lastTask: "work" });
  state.commitAgent("a");
  const cursor = state.currentRevision("root");
  const controller = new AbortController();
  const waiting = state.waitForEvent(
    "root",
    cursor,
    (event) => event.type === "report" && event.agentId === "a",
    { signal: controller.signal, timeoutMs: 1000 }
  );
  state.recordMessage("root", "a", "report", "finding");
  assert.equal(await waiting, "updated");
  const first = state.eventsSince("root", cursor, ["a"]);
  const second = state.eventsSince("root", cursor, ["a"]);
  assert.deepEqual(first.events, second.events);
  assert.equal(first.events.at(-1).message, "finding");
});

test("cursor wait returns timeout without changing revision", async () => {
  const state = registry();
  state.activateRoot("root");
  const cursor = state.currentRevision("root");
  const reason = await state.waitForEvent(
    "root",
    cursor,
    () => true,
    { signal: new AbortController().signal, timeoutMs: 5 }
  );
  assert.equal(reason, "timeout");
  assert.equal(state.currentRevision("root"), cursor);
});

test("target-filtered history does not mix a watched parent with its child", () => {
  const state = registry();
  state.activateRoot("root");
  state.addAgent({ id: "a", parentId: "root", status: "running", name: "a" });
  state.addAgent({ id: "b", parentId: "a", status: "running", name: "b" });
  const cursor = state.currentRevision("root");
  state.recordMessage("a", "b", "report", "nested finding");
  assert.deepEqual(state.eventsSince("root", cursor, ["a"]).events, []);
  assert.equal(state.eventsSince("root", cursor, ["b"]).events.at(-1).message, "nested finding");
});

test("aborting an event wait removes it without changing history", async () => {
  const state = registry();
  state.activateRoot("root");
  const cursor = state.currentRevision("root");
  const controller = new AbortController();
  const waiting = state.waitForEvent("root", cursor, () => true, {
    signal: controller.signal,
    timeoutMs: 1000
  });
  controller.abort(new Error("stop waiting"));
  await assert.rejects(waiting, /stop waiting/u);
  assert.equal(state.currentRevision("root"), cursor);
});
