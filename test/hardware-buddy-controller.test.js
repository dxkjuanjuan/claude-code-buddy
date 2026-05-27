"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert");

const {
  HardwareBuddyController,
  normalizeDeviceCommand,
} = require("../src/hardware-buddy/controller");
const {
  FakeHardwareBuddyTransport,
} = require("../src/hardware-buddy/fake-transport");

function session(id, state, overrides = {}) {
  return {
    id,
    state,
    displayTitle: id,
    updatedAt: 1000,
    agentId: "claude-code",
    headless: false,
    hiddenFromHud: false,
    ...overrides,
  };
}

function perm(overrides = {}) {
  return {
    sessionId: "s1",
    agentId: "claude-code",
    toolName: "Bash",
    toolInput: { command: "npm test" },
    createdAt: 1000,
    ...overrides,
  };
}

function makeFakeIntervalApi() {
  const intervals = [];
  return {
    intervals,
    setInterval(fn, ms) {
      const id = intervals.length;
      intervals.push({ fn, ms, active: true });
      return id;
    },
    clearInterval(id) {
      if (intervals[id]) intervals[id].active = false;
    },
    tick() {
      for (const interval of intervals) {
        if (interval.active) interval.fn();
      }
    },
  };
}

function makeControllerState(initial = {}) {
  const state = {
    sessions: initial.sessions || [session("s1", "working")],
    permissions: initial.permissions || [],
    dnd: initial.dnd === true,
    resolved: [],
  };

  const transport = initial.transport || new FakeHardwareBuddyTransport();
  const controller = new HardwareBuddyController({
    transport,
    getSessionSnapshot: () => ({ sessions: state.sessions }),
    getPendingPermissions: () => state.permissions,
    getDoNotDisturb: () => state.dnd,
    isAgentEnabled: () => true,
    isAgentPermissionsEnabled: () => true,
    keepaliveMs: initial.keepaliveMs ?? 0,
    setInterval: initial.setInterval,
    clearInterval: initial.clearInterval,
    log: (message) => {
      if (!state.logs) state.logs = [];
      state.logs.push(message);
    },
    resolvePermissionEntry: (entry, behavior) => {
      state.resolved.push({ entry, behavior });
      state.permissions = state.permissions.filter((candidate) => candidate !== entry);
    },
  });

  return { state, transport, controller };
}

describe("hardware buddy controller", () => {
  it("emits an initial snapshot on start", () => {
    const { transport, controller } = makeControllerState({
      sessions: [session("s1", "working", { displayTitle: "Build core" })],
    });

    const snapshot = controller.start();

    assert.strictEqual(transport.outbound.length, 1);
    assert.strictEqual(transport.outbound[0].meta.reason, "start");
    assert.strictEqual(snapshot.running, 1);
    assert.strictEqual(snapshot.msg, "Build core");
    controller.stop();
  });

  it("re-emits snapshots for state and permission changes", () => {
    const permission = perm();
    const { state, transport, controller } = makeControllerState({
      sessions: [session("s1", "idle", { displayTitle: "Repo" })],
    });

    controller.start();
    state.sessions = [session("s1", "working", { displayTitle: "Repo" })];
    controller.notifyStateChanged();
    assert.strictEqual(transport.lastOutbound().meta.reason, "state-change");
    assert.strictEqual(transport.lastOutbound().snapshot.running, 1);

    state.permissions = [permission];
    controller.notifyPermissionsChanged();
    const withPrompt = transport.lastOutbound().snapshot;
    assert.strictEqual(transport.lastOutbound().meta.reason, "permission-change");
    assert.strictEqual(withPrompt.waiting, 1);
    assert.strictEqual(withPrompt.prompt.id, "hb_1");

    state.permissions = [];
    controller.notifyPermissionsChanged();
    const withoutPrompt = transport.lastOutbound().snapshot;
    assert.strictEqual(withoutPrompt.waiting, 0);
    assert.ok(!Object.prototype.hasOwnProperty.call(withoutPrompt, "prompt"));

    controller.stop();
  });

  it("does not expose or accept permission prompts when transport security is unknown", () => {
    const permission = perm();
    const transport = {
      outbound: [],
      send(snapshot, meta) {
        this.outbound.push({ snapshot, meta });
      },
      lastOutbound() {
        return this.outbound[this.outbound.length - 1] || null;
      },
    };
    const { state, controller } = makeControllerState({
      transport,
      permissions: [permission],
    });

    controller.start();
    assert.strictEqual(transport.lastOutbound().snapshot.waiting, 0);
    assert.ok(!Object.prototype.hasOwnProperty.call(transport.lastOutbound().snapshot, "prompt"));

    const handled = controller.handleCommand({ cmd: "permission", id: "hb_1", decision: "once" });
    assert.strictEqual(handled, false);
    assert.deepStrictEqual(state.resolved, []);
    controller.stop();
  });

  it("sends keepalive snapshots on the injected interval", () => {
    const clock = makeFakeIntervalApi();
    const { transport, controller } = makeControllerState({
      keepaliveMs: 10000,
      setInterval: clock.setInterval,
      clearInterval: clock.clearInterval,
    });

    controller.start();
    assert.strictEqual(clock.intervals.length, 1);
    assert.strictEqual(clock.intervals[0].ms, 10000);

    transport.clear();
    clock.tick();
    assert.strictEqual(transport.outbound.length, 1);
    assert.strictEqual(transport.outbound[0].meta.reason, "keepalive");

    controller.stop();
    transport.clear();
    clock.tick();
    assert.strictEqual(transport.outbound.length, 0);
  });

  it("routes a hardware once reply to the matching pending permission", () => {
    const permission = perm();
    const { state, transport, controller } = makeControllerState({
      permissions: [permission],
    });

    controller.start();
    const id = transport.lastOutbound().snapshot.prompt.id;
    transport.injectCommand({ cmd: "permission", id, decision: "once" });

    assert.deepStrictEqual(state.resolved, [{ entry: permission, behavior: "allow" }]);
    assert.deepStrictEqual(state.permissions, []);
    assert.strictEqual(transport.lastOutbound().meta.reason, "permission-reply");
    assert.ok(!Object.prototype.hasOwnProperty.call(transport.lastOutbound().snapshot, "prompt"));
    controller.stop();
  });

  it("routes a hardware deny reply to the matching pending permission", () => {
    const permission = perm();
    const { state, transport, controller } = makeControllerState({
      permissions: [permission],
    });

    controller.start();
    const id = transport.lastOutbound().snapshot.prompt.id;
    const handled = controller.handleCommand(JSON.stringify({ cmd: "permission", id, decision: "deny" }));

    assert.strictEqual(handled, true);
    assert.deepStrictEqual(state.resolved, [{ entry: permission, behavior: "deny" }]);
    controller.stop();
  });

  it("ignores stale permission replies after the prompt disappears", () => {
    const permission = perm();
    const { state, transport, controller } = makeControllerState({
      permissions: [permission],
    });

    controller.start();
    const id = transport.lastOutbound().snapshot.prompt.id;

    state.permissions = [];
    controller.notifyPermissionsChanged();
    const handled = controller.handleCommand({ cmd: "permission", id, decision: "once" });

    assert.strictEqual(handled, false);
    assert.deepStrictEqual(state.resolved, []);
    assert.match(state.logs[state.logs.length - 1], /stale/);
    controller.stop();
  });

  it("ignores permission replies on insecure transport and suppresses prompt snapshots", () => {
    const permission = perm();
    const transport = new FakeHardwareBuddyTransport({ secure: true });
    const { state, controller } = makeControllerState({
      transport,
      permissions: [permission],
    });

    controller.start();
    const id = transport.lastOutbound().snapshot.prompt.id;

    transport.setSecure(false);
    controller.notifyPermissionsChanged();
    assert.ok(!Object.prototype.hasOwnProperty.call(transport.lastOutbound().snapshot, "prompt"));

    const handled = controller.handleCommand({ cmd: "permission", id, decision: "once" });
    assert.strictEqual(handled, false);
    assert.deepStrictEqual(state.resolved, []);
    controller.stop();
  });

  it("restores prompt snapshots when transport security returns", () => {
    const permission = perm();
    const transport = new FakeHardwareBuddyTransport({ secure: true });
    const { controller } = makeControllerState({
      transport,
      permissions: [permission],
    });

    controller.start();
    const originalId = transport.lastOutbound().snapshot.prompt.id;

    transport.setSecure(false);
    controller.notifyPermissionsChanged();
    assert.ok(!Object.prototype.hasOwnProperty.call(transport.lastOutbound().snapshot, "prompt"));

    transport.setSecure(true);
    controller.notifyPermissionsChanged();
    assert.strictEqual(transport.lastOutbound().snapshot.prompt.id, "hb_2");
    assert.notStrictEqual(transport.lastOutbound().snapshot.prompt.id, originalId);
    controller.stop();
  });

  it("keeps remaining prompt ids stable after resolving a different permission", () => {
    const older = perm({ toolName: "Read", createdAt: 1000, toolInput: { path: "a.txt" } });
    const newer = perm({ toolName: "Bash", createdAt: 2000, toolInput: { command: "npm test" } });
    const { transport, controller } = makeControllerState({
      permissions: [older, newer],
    });

    controller.start();
    const olderId = controller.promptIds.getPromptId(older);
    const newerId = controller.promptIds.getPromptId(newer);
    assert.strictEqual(transport.lastOutbound().snapshot.prompt.id, newerId);

    transport.injectCommand({ cmd: "permission", id: newerId, decision: "deny" });
    assert.strictEqual(transport.lastOutbound().snapshot.prompt.id, olderId);
    assert.strictEqual(controller.promptIds.getPromptId(older), olderId);
    controller.stop();
  });

  it("hides and restores prompts when DND changes at runtime", () => {
    const permission = perm();
    const { state, transport, controller } = makeControllerState({
      permissions: [permission],
    });

    controller.start();
    const firstId = transport.lastOutbound().snapshot.prompt.id;

    state.dnd = true;
    controller.notifyPermissionsChanged();
    assert.ok(!Object.prototype.hasOwnProperty.call(transport.lastOutbound().snapshot, "prompt"));

    state.dnd = false;
    controller.notifyPermissionsChanged();
    assert.strictEqual(transport.lastOutbound().snapshot.prompt.id, "hb_2");
    assert.notStrictEqual(transport.lastOutbound().snapshot.prompt.id, firstId);
    controller.stop();
  });

  it("stores status commands without mutating permission state", () => {
    const { state, controller } = makeControllerState();

    assert.strictEqual(controller.handleCommand({ cmd: "status", battery: 88 }), true);
    assert.deepStrictEqual(controller.lastDeviceStatus, { cmd: "status", battery: 88 });
    assert.deepStrictEqual(state.resolved, []);
  });

  it("stores official status ack commands without mutating permission state", () => {
    const { state, controller } = makeControllerState();
    const command = {
      ack: "status",
      ok: true,
      data: { name: "Clawd", sec: true, batt: 88 },
    };

    assert.strictEqual(controller.handleCommand(command), true);
    assert.deepStrictEqual(controller.lastDeviceStatus, command);
    assert.deepStrictEqual(state.resolved, []);
  });
});

describe("hardware buddy controller command parsing", () => {
  it("normalizes object and JSON commands", () => {
    assert.deepStrictEqual(normalizeDeviceCommand({ cmd: "status" }), { cmd: "status" });
    assert.deepStrictEqual(normalizeDeviceCommand("{\"cmd\":\"status\"}"), { cmd: "status" });
    assert.strictEqual(normalizeDeviceCommand("{bad json"), null);
    assert.strictEqual(normalizeDeviceCommand([]), null);
  });
});
