/** In-process Ultra tree, concurrency accounting, and cursor-based event waits. */

// `idle` is still an open continuable Activation until the paired
// `subagent/end` arrives. Treating agent/status=idle as completion creates a
// race where the parent can finalize before the settlement/report is delivered.
const ACTIVE = new Set(["starting", "running", "idle"]);

function abortError(signal) {
  if (signal.reason instanceof Error) return signal.reason;
  return new Error(typeof signal.reason === "string" ? signal.reason : "wait_agent aborted");
}

function shortId(id) {
  return String(id).replace(/[^a-zA-Z0-9]/gu, "").slice(0, 8) || "agent";
}

export class UltraRegistry {
  constructor(config) {
    this.config = config;
    this.roots = new Map();
    this.nodes = new Map();
    this.reservations = new Map();
  }

  activateRoot(id, status = "running") {
    const existing = this.nodes.get(id);
    if (existing !== undefined) return existing;
    const root = {
      id,
      run: 1,
      nodes: new Set([id]),
      namesByParent: new Map(),
      revision: 0,
      events: [],
      waiters: new Set()
    };
    const node = {
      id,
      rootId: id,
      parentId: null,
      parentPath: null,
      name: "root",
      path: "/root",
      depth: 0,
      status,
      started: true,
      provisional: false,
      lastTask: "Ultra root"
    };
    this.roots.set(id, root);
    this.nodes.set(id, node);
    this.record(id, { type: "activated", agentId: id, status });
    return node;
  }

  beginRun(id, status = "running") {
    const existing = this.nodes.get(id);
    if (existing === undefined) {
      return { node: this.activateRoot(id, status), retiredAgentIds: [] };
    }
    // A descendant may use the /ultra gesture to reinforce its current policy,
    // but only the root owns run epochs and tree-wide accounting.
    if (existing.parentId !== null) {
      return { node: existing, retiredAgentIds: [] };
    }
    const root = this.roots.get(existing.rootId);
    if (root === undefined || this.runningDescendants(id).length > 0 || this.reservationsForRoot(existing.rootId) > 0) {
      this.record(id, { type: "reactivated", agentId: id, status });
      return { node: existing, retiredAgentIds: [] };
    }
    const retiredAgentIds = [...root.nodes].filter((agentId) => agentId !== id);
    for (const agentId of retiredAgentIds) this.nodes.delete(agentId);
    root.nodes = new Set([id]);
    root.namesByParent.clear();
    root.run += 1;
    existing.status = status;
    existing.lastTask = "Ultra root";
    this.record(id, {
      type: "run-started",
      agentId: id,
      status,
      run: root.run,
      retiredAgentIds
    });
    return { node: existing, retiredAgentIds };
  }

  node(id) {
    return this.nodes.get(id);
  }

  rootForAgent(id) {
    const node = this.nodes.get(id);
    return node === undefined ? undefined : this.roots.get(node.rootId);
  }

  isActive(id) {
    return this.nodes.has(id);
  }

  addAgent({ id, parentId, status = "idle", name, lastTask }) {
    const existing = this.nodes.get(id);
    if (existing !== undefined) {
      existing.status = status;
      // Every publication begins a new residency attempt. A successful
      // subagent/start below will open this attempt; disposal before that event
      // is a terminal pre-start failure even if an earlier run had succeeded.
      existing.started = false;
      if (lastTask !== undefined) existing.lastTask = lastTask;
      return existing;
    }
    const parent = this.nodes.get(parentId);
    if (parent === undefined) return undefined;
    const root = this.roots.get(parent.rootId);
    if (root === undefined) return undefined;
    const requestedName = name ?? `agent-${shortId(id)}`;
    const safeName = this.uniqueName(root, parent.id, requestedName);
    const node = {
      id,
      rootId: parent.rootId,
      parentId: parent.id,
      parentPath: parent.path,
      name: safeName,
      path: `${parent.path}/${safeName}`,
      depth: parent.depth + 1,
      status,
      started: false,
      provisional: false,
      lastTask: lastTask ?? safeName
    };
    root.nodes.add(id);
    this.nodes.set(id, node);
    this.claimName(root, parent.id, safeName);
    this.record(id, { type: "created", agentId: id, parentId: parent.id, status });
    return node;
  }

  markPublished(id, status = "idle") {
    const node = this.nodes.get(id);
    if (node === undefined) return undefined;
    node.started = false;
    return this.markStatus(id, status, "created");
  }

  provisionAgent({ id, parentId, name, lastTask }) {
    const check = this.canSpawn(parentId);
    if (!check.ok) throw new Error(`${check.code}: ${check.message}`);
    const parent = this.nodes.get(parentId);
    const root = this.roots.get(parent.rootId);
    if (this.nameTaken(root, parent.id, name)) {
      throw new Error(`TASK_NAME_CONFLICT: ${parent.path} already has a child named ${name}`);
    }
    const node = {
      id,
      rootId: parent.rootId,
      parentId: parent.id,
      parentPath: parent.path,
      name,
      path: `${parent.path}/${name}`,
      depth: parent.depth + 1,
      status: "starting",
      started: false,
      provisional: true,
      lastTask
    };
    root.nodes.add(id);
    this.nodes.set(id, node);
    this.claimName(root, parent.id, name);
    this.record(id, { type: "spawn-requested", agentId: id, parentId: parent.id, status: "starting" });
    return node;
  }

  commitAgent(id, status = "running") {
    const node = this.nodes.get(id);
    if (node === undefined) return undefined;
    node.provisional = false;
    this.markStatus(id, status, "spawn-accepted");
    return node;
  }

  rollbackAgent(id, detail = "spawn failed") {
    const node = this.nodes.get(id);
    if (node === undefined || !node.provisional) return;
    const root = this.roots.get(node.rootId);
    if (root !== undefined) {
      root.nodes.delete(id);
      this.releaseName(root, node.parentId, node.name);
      this.record(id, { type: "spawn-failed", agentId: id, parentId: node.parentId, status: "failed", message: detail });
    }
    this.nodes.delete(id);
  }

  markStatus(id, status, type = "status", extra = {}) {
    const node = this.nodes.get(id);
    if (node === undefined) return undefined;
    if (type === "start") node.started = true;
    const changed = node.status !== status;
    node.status = status;
    if (changed || type !== "status") {
      this.record(id, { type, agentId: id, parentId: node.parentId, status, ...extra });
    }
    return node;
  }

  markAgentDisposed(id) {
    const node = this.nodes.get(id);
    if (node === undefined) return undefined;
    // Native continuable creation can publish an Agent and then fail before
    // subagent/start. That path emits agent/disposed but no paired start/end;
    // terminalize it so the idle publication cannot occupy a slot forever.
    if (node.depth > 0 && !node.provisional && !node.started && ACTIVE.has(node.status)) {
      return this.markStatus(id, "failed", "start-failed", {
        message: "agent disposed before subagent/start"
      });
    }
    this.record(id, { type: "agent-disposed", agentId: id, parentId: node.parentId, status: node.status });
    return node;
  }

  updateTask(id, task) {
    const node = this.nodes.get(id);
    if (node === undefined) return undefined;
    node.lastTask = task;
    return node;
  }

  recordMessage(parentId, authorId, type, message) {
    const parent = this.nodes.get(parentId);
    if (parent === undefined) return;
    this.record(parentId, {
      type,
      agentId: authorId,
      parentId,
      message
    });
  }

  record(agentId, event) {
    const node = this.nodes.get(agentId) ?? this.nodes.get(event.parentId);
    if (node === undefined) return undefined;
    const root = this.roots.get(node.rootId);
    if (root === undefined) return undefined;
    root.revision += 1;
    const entry = Object.freeze({ revision: root.revision, ...event });
    root.events.push(entry);
    if (root.events.length > this.config.eventHistory) root.events.shift();
    for (const waiter of [...root.waiters]) {
      if (entry.revision > waiter.afterRevision && waiter.predicate(entry)) {
        waiter.finish("updated");
      }
    }
    return entry;
  }

  canSpawn(parentId, { includeReservation = true } = {}) {
    const parent = this.nodes.get(parentId);
    if (parent === undefined) {
      return { ok: false, code: "ULTRA_NOT_ACTIVE", message: "activate /ultra before spawning agents" };
    }
    if (parent.depth >= this.config.maxDepth) {
      return { ok: false, code: "DEPTH_LIMIT", message: `maximum Ultra depth is ${this.config.maxDepth}` };
    }
    const root = this.roots.get(parent.rootId);
    const reservationCount = includeReservation ? this.reservationsForRoot(root.id) : 0;
    // Reservations represent cold wakes of existing nodes, not new children;
    // they consume concurrency but never the per-run creation budget.
    const total = root.nodes.size - 1;
    if (total >= this.config.maxTotalSubagents) {
      return { ok: false, code: "AGENT_LIMIT", message: `maximum subagents per Ultra run is ${this.config.maxTotalSubagents}` };
    }
    const active = this.activeCount(root.id) + reservationCount;
    if (active >= this.config.maxConcurrentSubagents) {
      return { ok: false, code: "CONCURRENCY_LIMIT", message: `at most ${this.config.maxConcurrentSubagents} subagents may run at once; call wait_agent before retrying` };
    }
    return { ok: true, rootId: root.id };
  }

  reserveWake(token, parentId, childId) {
    const child = this.nodes.get(childId);
    const check = this.canWake(parentId, childId);
    if (!check.ok || (child !== undefined && ACTIVE.has(child.status))) return check;
    const root = this.rootForAgent(parentId);
    this.reservations.set(token, root.id);
    return check;
  }

  releaseReservation(token) {
    this.reservations.delete(token);
  }

  reservationsForRoot(rootId) {
    let count = 0;
    for (const reservedRoot of this.reservations.values()) {
      if (reservedRoot === rootId) count += 1;
    }
    return count;
  }

  activeCount(rootId) {
    const root = this.roots.get(rootId);
    if (root === undefined) return 0;
    let count = 0;
    for (const id of root.nodes) {
      const node = this.nodes.get(id);
      if (node !== undefined && node.depth > 0 && ACTIVE.has(node.status)) count += 1;
    }
    return count;
  }

  canWake(parentId, childId) {
    const parent = this.nodes.get(parentId);
    const child = this.nodes.get(childId);
    if (parent === undefined || child === undefined || child.parentId !== parent.id) {
      return { ok: false, code: "NOT_DIRECT_CHILD", message: "followup_task can target only a direct child in the active Ultra tree" };
    }
    if (ACTIVE.has(child.status)) return { ok: true };
    const root = this.roots.get(parent.rootId);
    const active = this.activeCount(root.id) + this.reservationsForRoot(root.id);
    if (active >= this.config.maxConcurrentSubagents) {
      return { ok: false, code: "CONCURRENCY_LIMIT", message: `at most ${this.config.maxConcurrentSubagents} subagents may run at once` };
    }
    return { ok: true };
  }

  descendantsOf(ancestorId) {
    const ancestor = this.nodes.get(ancestorId);
    if (ancestor === undefined) return [];
    const root = this.roots.get(ancestor.rootId);
    const result = [];
    for (const id of root.nodes) {
      if (id === ancestorId) continue;
      const node = this.nodes.get(id);
      if (node !== undefined && this.isDescendant(node.id, ancestorId)) result.push(node);
    }
    return result.sort((a, b) => a.depth - b.depth || a.path.localeCompare(b.path));
  }

  isDescendant(candidateId, ancestorId) {
    let node = this.nodes.get(candidateId);
    while (node !== undefined && node.parentId !== null) {
      if (node.parentId === ancestorId) return true;
      node = this.nodes.get(node.parentId);
    }
    return false;
  }

  runningDescendants(ancestorId) {
    return this.descendantsOf(ancestorId).filter((node) => ACTIVE.has(node.status));
  }

  currentRevision(agentId) {
    return this.rootForAgent(agentId)?.revision ?? 0;
  }

  eventsSince(agentId, afterRevision, targetIds) {
    const root = this.rootForAgent(agentId);
    if (root === undefined) return { events: [], truncated: false, revision: 0 };
    const first = root.events[0]?.revision ?? root.revision + 1;
    const truncated = afterRevision < first - 1;
    const targets = targetIds === undefined ? undefined : new Set(targetIds);
    const events = root.events.filter((event) => {
      if (event.revision <= afterRevision) return false;
      if (targets === undefined) return true;
      return targets.has(event.agentId);
    });
    return { events, truncated, revision: root.revision };
  }

  waitForEvent(agentId, afterRevision, predicate, { signal, timeoutMs }) {
    const root = this.rootForAgent(agentId);
    if (root === undefined) return Promise.reject(new Error("ULTRA_NOT_ACTIVE: this agent is not in an active Ultra tree"));
    if (signal.aborted) return Promise.reject(abortError(signal));
    const existing = root.events.find((event) => event.revision > afterRevision && predicate(event));
    if (existing !== undefined) return Promise.resolve("updated");

    return new Promise((resolve, reject) => {
      let settled = false;
      let timer;
      const finish = (reason) => {
        if (settled) return;
        settled = true;
        root.waiters.delete(waiter);
        signal.removeEventListener("abort", onAbort);
        if (timer !== undefined) clearTimeout(timer);
        resolve(reason);
      };
      const onAbort = () => {
        if (settled) return;
        settled = true;
        root.waiters.delete(waiter);
        if (timer !== undefined) clearTimeout(timer);
        reject(abortError(signal));
      };
      const waiter = { afterRevision, predicate, finish };
      root.waiters.add(waiter);
      signal.addEventListener("abort", onAbort, { once: true });
      timer = setTimeout(() => finish("timeout"), timeoutMs);
    });
  }

  snapshot(nodes) {
    return nodes.map((node) => ({
      id: node.id,
      name: node.path,
      status: node.status,
      parent: node.parentId,
      task: node.lastTask
    }));
  }

  nameTaken(root, parentId, name) {
    return root.namesByParent.get(parentId)?.has(name) ?? false;
  }

  uniqueName(root, parentId, requested) {
    if (!this.nameTaken(root, parentId, requested)) return requested;
    let suffix = 2;
    while (this.nameTaken(root, parentId, `${requested}-${suffix}`)) suffix += 1;
    return `${requested}-${suffix}`;
  }

  claimName(root, parentId, name) {
    let names = root.namesByParent.get(parentId);
    if (names === undefined) {
      names = new Set();
      root.namesByParent.set(parentId, names);
    }
    names.add(name);
  }

  releaseName(root, parentId, name) {
    const names = root.namesByParent.get(parentId);
    if (names === undefined) return;
    names.delete(name);
    if (names.size === 0) root.namesByParent.delete(parentId);
  }
}
