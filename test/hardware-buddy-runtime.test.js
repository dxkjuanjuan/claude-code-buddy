"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert");
const { EventEmitter } = require("node:events");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { PassThrough, Writable } = require("node:stream");

const { FakeHardwareBuddyTransport } = require("../src/hardware-buddy/fake-transport");
const { HeadlessHardwareBuddyRuntime } = require("../src/runtime/headless-runtime");
const { createStaticHardwareBuddySource } = require("../src/runtime/static-source");

function permission(overrides = {}) {
  return {
    sessionId: "standalone",
    agentId: "claude-code",
    toolName: "Bash",
    toolInput: { command: "git status" },
    createdAt: 1000,
    ...overrides,
  };
}

function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "claudebuddy-runtime-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function writeJson(file, value) {
  fs.writeFileSync(file, JSON.stringify(value), "utf8");
}

function readJsonLines(file) {
  return fs.readFileSync(file, "utf8")
    .trim()
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function makeIntervalApi() {
  const intervals = [];
  const timeouts = [];
  return {
    intervals,
    timeouts,
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
    setTimeout(fn, ms) {
      const id = timeouts.length;
      timeouts.push({ fn, ms, active: true });
      return id;
    },
    clearTimeout(id) {
      if (timeouts[id]) timeouts[id].active = false;
    },
    runTimeout(id = 0) {
      const timeout = timeouts[id];
      if (!timeout || !timeout.active) return false;
      timeout.active = false;
      timeout.fn();
      return true;
    },
    activeTimeouts() {
      return timeouts.filter((timeout) => timeout.active);
    },
  };
}

class SinkWritable extends Writable {
  constructor() {
    super();
    this.writes = [];
  }

  _write(_chunk, _encoding, callback) {
    this.writes.push(Buffer.isBuffer(_chunk) ? _chunk.toString("utf8") : String(_chunk));
    callback();
  }
}

function makeFakeChild() {
  const child = new EventEmitter();
  child.pid = 4242;
  child.stdin = new SinkWritable();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = () => {
    child.emit("exit", null, "SIGTERM");
    return true;
  };
  return child;
}

function controlActionCount(child, action) {
  return child.stdin.writes
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter((message) => message && message.type === "control" && message.action === action)
    .length;
}

class FakeSidecarClient {
  constructor() {
    this.transport = new FakeHardwareBuddyTransport({ secure: false, connected: false });
    this.calls = [];
  }

  start() {
    this.calls.push(["start"]);
  }

  connect(data) {
    this.calls.push(["connect", data]);
    return true;
  }

  scan() {
    this.calls.push(["scan"]);
    return true;
  }

  pollStatus() {
    this.calls.push(["status"]);
    return true;
  }

  stop() {
    this.calls.push(["stop"]);
  }
}

describe("headless hardware buddy runtime", () => {
  it("runs standalone with a fake transport and static source", () => {
    const logs = [];
    const runtime = new HeadlessHardwareBuddyRuntime({
      config: {
        transport: "fake",
        keepaliveMs: 0,
        sourceTitle: "Standalone Task",
        sourceState: "working",
      },
      log: (...args) => logs.push(args),
    });

    const snapshot = runtime.start();

    assert.strictEqual(snapshot.total, 1);
    assert.strictEqual(snapshot.running, 1);
    assert.strictEqual(snapshot.msg, "Standalone Task");
    assert.strictEqual(runtime.transport.outbound.length, 1);
    assert.strictEqual(runtime.transport.outbound[0].meta.reason, "start");
    assert.deepStrictEqual(logs, []);

    runtime.stop();
  });

  it("keeps hardware permission prompts opt-in even when transport is secure", () => {
    const source = createStaticHardwareBuddySource({
      title: "Repo",
      state: "working",
      now: 1000,
    });
    source.setPendingPermissions([permission()]);
    const runtime = new HeadlessHardwareBuddyRuntime({
      config: {
        transport: "fake",
        fakeSecure: true,
        keepaliveMs: 0,
        permissionReplies: false,
      },
      source,
    });

    const snapshot = runtime.start();

    assert.strictEqual(snapshot.waiting, 0);
    assert.ok(!Object.prototype.hasOwnProperty.call(snapshot, "prompt"));
    runtime.stop();
  });

  it("runs standalone from a json-file source and emits snapshots on file changes", (t) => {
    const clock = makeIntervalApi();
    const dir = tempDir(t);
    const file = path.join(dir, "state.json");
    writeJson(file, {
      sessions: [{ id: "s1", title: "Initial task", state: "working" }],
      permissions: [],
    });
    const runtime = new HeadlessHardwareBuddyRuntime({
      config: {
        source: "json-file",
        sourceFile: file,
        sourcePollMs: 25,
        transport: "fake",
        keepaliveMs: 0,
      },
      setInterval: clock.setInterval,
      clearInterval: clock.clearInterval,
    });

    const snapshot = runtime.start();

    assert.strictEqual(snapshot.msg, "Initial task");
    assert.strictEqual(clock.intervals.length, 1);

    writeJson(file, {
      sessions: [{ id: "s1", title: "Updated task", state: "thinking" }],
      permissions: [],
    });
    clock.tick();

    const outbound = runtime.transport.lastOutbound();
    assert.strictEqual(outbound.meta.reason, "state-change");
    assert.strictEqual(outbound.snapshot.msg, "Updated task");
    runtime.stop();
    assert.strictEqual(clock.intervals[0].active, false);
  });

  it("runs standalone from stdin-jsonl input and emits snapshots on lines", () => {
    const input = new PassThrough();
    const runtime = new HeadlessHardwareBuddyRuntime({
      config: {
        source: "stdin-jsonl",
        transport: "fake",
        keepaliveMs: 0,
      },
      stdin: input,
    });

    const snapshot = runtime.start();
    assert.strictEqual(snapshot.msg, "ClaudeBuddy Standalone");

    input.write(`${JSON.stringify({
      sessions: [{ id: "s1", title: "Pipe task", state: "thinking" }],
      permissions: [],
    })}\n`);

    const outbound = runtime.transport.lastOutbound();
    assert.strictEqual(outbound.meta.reason, "state-change");
    assert.strictEqual(outbound.snapshot.msg, "Pipe task");
    runtime.stop();
  });

  it("keeps json-file permissions fail-closed by default", (t) => {
    const dir = tempDir(t);
    const file = path.join(dir, "state.json");
    writeJson(file, {
      sessions: [{ id: "standalone", title: "Repo", state: "working" }],
      permissions: [permission()],
    });
    const runtime = new HeadlessHardwareBuddyRuntime({
      config: {
        source: "json-file",
        sourceFile: file,
        transport: "fake",
        fakeSecure: true,
        keepaliveMs: 0,
      },
    });

    const snapshot = runtime.start();

    assert.strictEqual(snapshot.waiting, 0);
    assert.ok(!Object.prototype.hasOwnProperty.call(snapshot, "prompt"));
    runtime.stop();
  });

  it("keeps permission prompts fail-closed when no reply sink is configured", () => {
    const source = createStaticHardwareBuddySource({
      title: "Repo",
      state: "working",
      now: 1000,
    });
    const runtime = new HeadlessHardwareBuddyRuntime({
      config: {
        transport: "fake",
        fakeSecure: true,
        keepaliveMs: 0,
        permissionReplies: true,
      },
      source,
    });

    runtime.start();
    source.setPendingPermissions([permission()]);

    const outbound = runtime.transport.lastOutbound();
    assert.strictEqual(outbound.snapshot.waiting, 0);
    assert.ok(!Object.prototype.hasOwnProperty.call(outbound.snapshot, "prompt"));
    runtime.stop();
  });

  it("emits prompt snapshots after explicit permission opt-in with a reply sink", (t) => {
    const dir = tempDir(t);
    const source = createStaticHardwareBuddySource({
      title: "Repo",
      state: "working",
      now: 1000,
    });
    const pending = permission();
    const runtime = new HeadlessHardwareBuddyRuntime({
      config: {
        transport: "fake",
        fakeSecure: true,
        keepaliveMs: 0,
        permissionReplies: true,
        replyFile: path.join(dir, "replies.jsonl"),
      },
      source,
    });

    runtime.start();
    source.setPendingPermissions([pending]);

    const outbound = runtime.transport.lastOutbound();
    assert.strictEqual(outbound.meta.reason, "permission-change");
    assert.strictEqual(outbound.snapshot.waiting, 1);
    assert.deepStrictEqual(outbound.snapshot.prompt, {
      id: "hb_1",
      tool: "Bash",
      hint: "git status",
    });

    source.setDoNotDisturb(true);
    assert.strictEqual(runtime.transport.lastOutbound().snapshot.waiting, 0);
    assert.ok(!Object.prototype.hasOwnProperty.call(runtime.transport.lastOutbound().snapshot, "prompt"));
    runtime.stop();
  });

  it("writes accepted hardware permission replies to a jsonl reply file", (t) => {
    const dir = tempDir(t);
    const replyFile = path.join(dir, "replies.jsonl");
    const source = createStaticHardwareBuddySource({
      title: "Repo",
      state: "working",
      now: 1000,
    });
    const pending = permission({ id: "prompt-1" });
    const runtime = new HeadlessHardwareBuddyRuntime({
      config: {
        transport: "fake",
        fakeSecure: true,
        keepaliveMs: 0,
        permissionReplies: true,
        replyFile,
      },
      source,
      now: () => 1710000000000,
    });

    runtime.start();
    source.setPendingPermissions([pending]);
    const promptId = runtime.transport.lastOutbound().snapshot.prompt.id;

    runtime.transport.injectCommand({ cmd: "permission", id: promptId, decision: "once" });

    assert.deepStrictEqual(readJsonLines(replyFile), [{
      type: "permission_reply",
      id: "prompt-1",
      promptId,
      behavior: "allow",
      decision: "once",
      sessionId: "standalone",
      agentId: "claude-code",
      toolName: "Bash",
      createdAt: 1000,
      time: "2024-03-09T16:00:00.000Z",
    }]);
    assert.deepStrictEqual(source.getPendingPermissions(), []);
    assert.strictEqual(runtime.transport.lastOutbound().meta.reason, "permission-reply");
    assert.ok(!Object.prototype.hasOwnProperty.call(runtime.transport.lastOutbound().snapshot, "prompt"));
    assert.strictEqual(runtime.getStatus().snapshot.waiting, 0);
    assert.ok(!Object.prototype.hasOwnProperty.call(runtime.getStatus().snapshot, "prompt"));
    runtime.stop();
  });

  it("keeps json-file replies suppressed after writing the reply sink", (t) => {
    const clock = makeIntervalApi();
    const dir = tempDir(t);
    const sourceFile = path.join(dir, "state.json");
    const replyFile = path.join(dir, "replies.jsonl");
    writeJson(sourceFile, {
      sessions: [{ id: "standalone", title: "Repo", state: "working" }],
      permissions: [permission({ id: "prompt-1" })],
    });
    const runtime = new HeadlessHardwareBuddyRuntime({
      config: {
        source: "json-file",
        sourceFile,
        sourcePollMs: 25,
        transport: "fake",
        fakeSecure: true,
        keepaliveMs: 0,
        permissionReplies: true,
        replyFile,
      },
      setInterval: clock.setInterval,
      clearInterval: clock.clearInterval,
      now: () => 1710000000000,
    });

    const snapshot = runtime.start();
    const promptId = snapshot.prompt.id;
    runtime.transport.injectCommand({ cmd: "permission", id: promptId, decision: "deny" });

    assert.strictEqual(readJsonLines(replyFile)[0].behavior, "deny");
    assert.ok(!Object.prototype.hasOwnProperty.call(runtime.transport.lastOutbound().snapshot, "prompt"));

    clock.tick();
    assert.ok(!Object.prototype.hasOwnProperty.call(runtime.transport.lastOutbound().snapshot, "prompt"));

    writeJson(sourceFile, {
      sessions: [{ id: "standalone", title: "Repo", state: "working" }],
      permissions: [],
    });
    clock.tick();
    writeJson(sourceFile, {
      sessions: [{ id: "standalone", title: "Repo", state: "working" }],
      permissions: [permission({ id: "prompt-1", createdAt: 2000 })],
    });
    clock.tick();

    assert.strictEqual(runtime.transport.lastOutbound().snapshot.prompt.id, "hb_2");
    runtime.stop();
  });

  it("does not write replies when permission replies are disabled or stale", (t) => {
    const dir = tempDir(t);
    const replyFile = path.join(dir, "replies.jsonl");
    const source = createStaticHardwareBuddySource({
      title: "Repo",
      state: "working",
      now: 1000,
    });
    source.setPendingPermissions([permission({ id: "prompt-1" })]);
    const runtime = new HeadlessHardwareBuddyRuntime({
      config: {
        transport: "fake",
        fakeSecure: true,
        keepaliveMs: 0,
        permissionReplies: false,
        replyFile,
      },
      source,
    });

    const snapshot = runtime.start();
    assert.ok(!Object.prototype.hasOwnProperty.call(snapshot, "prompt"));
    runtime.transport.injectCommand({ cmd: "permission", id: "hb_1", decision: "once" });

    assert.strictEqual(fs.existsSync(replyFile), false);
    runtime.stop();
  });

  it("does not throw when a reply file append fails", (t) => {
    const dir = tempDir(t);
    const logs = [];
    const source = createStaticHardwareBuddySource({
      title: "Repo",
      state: "working",
      now: 1000,
    });
    const pending = permission({ id: "prompt-1" });
    const runtime = new HeadlessHardwareBuddyRuntime({
      config: {
        transport: "fake",
        fakeSecure: true,
        keepaliveMs: 0,
        permissionReplies: true,
        replyFile: dir,
      },
      source,
      log: (...args) => logs.push(args),
    });

    runtime.start();
    source.setPendingPermissions([pending]);
    const promptId = runtime.transport.lastOutbound().snapshot.prompt.id;

    assert.doesNotThrow(() => {
      runtime.transport.injectCommand({ cmd: "permission", id: promptId, decision: "once" });
    });

    assert.strictEqual(source.getPendingPermissions().length, 1);
    assert.strictEqual(logs[0][0], "error");
    assert.match(logs[0][1], /failed to write permission reply/);
    runtime.stop();
  });

  it("starts a sidecar runtime, connects to the fake sidecar target, and polls status", () => {
    const clock = makeIntervalApi();
    const sidecar = new FakeSidecarClient();
    const runtime = new HeadlessHardwareBuddyRuntime({
      config: {
        transport: "sidecar",
        backend: "fake",
        keepaliveMs: 0,
        pollStatusMs: 100,
      },
      sidecarClient: sidecar,
      setInterval: clock.setInterval,
      clearInterval: clock.clearInterval,
      setTimeout: clock.setTimeout,
      clearTimeout: clock.clearTimeout,
    });

    runtime.start();

    assert.deepStrictEqual(sidecar.calls, [
      ["start"],
      ["connect", { address: "FAKE:CLAWSTICK" }],
    ]);
    assert.strictEqual(clock.intervals.length, 1);
    assert.strictEqual(clock.intervals[0].ms, 100);

    clock.tick();
    assert.deepStrictEqual(sidecar.calls[2], ["status"]);

    runtime.stop();
    clock.tick();
    assert.deepStrictEqual(sidecar.calls[sidecar.calls.length - 1], ["stop"]);
    assert.strictEqual(sidecar.calls.filter((call) => call[0] === "status").length, 1);
  });

  it("retries empty scans with backoff and coalesces pending retry timers", () => {
    const clock = makeIntervalApi();
    const child = makeFakeChild();
    const runtime = new HeadlessHardwareBuddyRuntime({
      config: {
        transport: "sidecar",
        backend: "bleak",
        keepaliveMs: 0,
        pollStatusMs: 0,
        retryInitialMs: 10,
        retryMaxMs: 25,
        retryBackoffFactor: 2,
        sidecarDiagnostics: false,
      },
      sidecarClientOptions: {
        spawn: () => child,
      },
      setTimeout: clock.setTimeout,
      clearTimeout: clock.clearTimeout,
    });

    runtime.start();
    assert.strictEqual(controlActionCount(child, "scan"), 1);

    child.stdout.write("{\"type\":\"devices\",\"items\":[]}\n");
    assert.strictEqual(clock.activeTimeouts().length, 1);
    assert.strictEqual(clock.activeTimeouts()[0].ms, 10);

    child.stdout.write("{\"type\":\"devices\",\"items\":[]}\n");
    assert.strictEqual(clock.activeTimeouts().length, 1);

    clock.runTimeout(0);
    assert.strictEqual(controlActionCount(child, "scan"), 2);
    assert.strictEqual(runtime.retryAttempts, 1);

    child.stdout.write("{\"type\":\"devices\",\"items\":[]}\n");
    assert.strictEqual(clock.activeTimeouts().length, 1);
    assert.strictEqual(clock.activeTimeouts()[0].ms, 20);
    runtime.stop();
  });

  it("retries fixed-target connects after NO_DEVICE errors", () => {
    const clock = makeIntervalApi();
    const child = makeFakeChild();
    const runtime = new HeadlessHardwareBuddyRuntime({
      config: {
        transport: "sidecar",
        backend: "bleak",
        address: "AA:BB:CC:DD:EE:FF",
        keepaliveMs: 0,
        pollStatusMs: 0,
        retryInitialMs: 5,
        sidecarDiagnostics: false,
      },
      sidecarClientOptions: {
        spawn: () => child,
      },
      setTimeout: clock.setTimeout,
      clearTimeout: clock.clearTimeout,
    });

    runtime.start();
    assert.strictEqual(controlActionCount(child, "connect"), 1);

    child.stdout.write("{\"type\":\"error\",\"message\":\"device not found\",\"code\":\"NO_DEVICE\"}\n");
    assert.strictEqual(clock.activeTimeouts().length, 1);
    assert.strictEqual(clock.activeTimeouts()[0].ms, 5);

    clock.runTimeout(0);
    assert.strictEqual(controlActionCount(child, "connect"), 2);
    runtime.stop();
  });

  it("restarts the sidecar process after child exit", () => {
    const clock = makeIntervalApi();
    const children = [makeFakeChild(), makeFakeChild()];
    let spawnCalls = 0;
    const runtime = new HeadlessHardwareBuddyRuntime({
      config: {
        transport: "sidecar",
        backend: "bleak",
        address: "AA:BB:CC:DD:EE:FF",
        keepaliveMs: 0,
        pollStatusMs: 0,
        retryInitialMs: 5,
        sidecarDiagnostics: false,
      },
      sidecarClientOptions: {
        spawn: () => children[spawnCalls++],
      },
      setTimeout: clock.setTimeout,
      clearTimeout: clock.clearTimeout,
    });

    runtime.start();
    assert.strictEqual(spawnCalls, 1);
    assert.strictEqual(controlActionCount(children[0], "connect"), 1);

    children[0].emit("exit", 1, null);
    assert.strictEqual(clock.activeTimeouts().length, 1);

    clock.runTimeout(0);
    assert.strictEqual(spawnCalls, 2);
    assert.strictEqual(controlActionCount(children[1], "connect"), 1);
    runtime.stop();
  });

  it("cancels pending sidecar retry timers on stop", () => {
    const clock = makeIntervalApi();
    const child = makeFakeChild();
    const runtime = new HeadlessHardwareBuddyRuntime({
      config: {
        transport: "sidecar",
        backend: "bleak",
        keepaliveMs: 0,
        pollStatusMs: 0,
        retryInitialMs: 5,
        sidecarDiagnostics: false,
      },
      sidecarClientOptions: {
        spawn: () => child,
      },
      setTimeout: clock.setTimeout,
      clearTimeout: clock.clearTimeout,
    });

    runtime.start();
    child.stdout.write("{\"type\":\"devices\",\"items\":[]}\n");
    assert.strictEqual(clock.activeTimeouts().length, 1);

    runtime.stop();
    assert.strictEqual(clock.activeTimeouts().length, 0);
    clock.runTimeout(0);
    assert.strictEqual(controlActionCount(child, "scan"), 1);
  });

  it("resets retry state when the sidecar reconnects", () => {
    const clock = makeIntervalApi();
    const child = makeFakeChild();
    const runtime = new HeadlessHardwareBuddyRuntime({
      config: {
        transport: "sidecar",
        backend: "bleak",
        address: "AA:BB:CC:DD:EE:FF",
        keepaliveMs: 0,
        pollStatusMs: 0,
        retryInitialMs: 5,
        sidecarDiagnostics: false,
      },
      sidecarClientOptions: {
        spawn: () => child,
      },
      setTimeout: clock.setTimeout,
      clearTimeout: clock.clearTimeout,
    });

    runtime.start();
    child.stdout.write("{\"type\":\"error\",\"message\":\"device not found\",\"code\":\"NO_DEVICE\"}\n");
    clock.runTimeout(0);
    assert.strictEqual(runtime.retryAttempts, 1);

    child.stdout.write("{\"type\":\"status\",\"connected\":true,\"secure\":true,\"ok\":true}\n");
    assert.strictEqual(runtime.retryAttempts, 0);

    child.stdout.write("{\"type\":\"status\",\"connected\":false,\"secure\":false,\"ok\":false}\n");
    assert.strictEqual(clock.activeTimeouts().length, 1);
    runtime.stop();
  });

  it("stops scheduling retries after retryMaxAttempts is reached", () => {
    const clock = makeIntervalApi();
    const child = makeFakeChild();
    const runtime = new HeadlessHardwareBuddyRuntime({
      config: {
        transport: "sidecar",
        backend: "bleak",
        address: "AA:BB:CC:DD:EE:FF",
        keepaliveMs: 0,
        pollStatusMs: 0,
        retryInitialMs: 5,
        retryMaxAttempts: 1,
        sidecarDiagnostics: false,
      },
      sidecarClientOptions: {
        spawn: () => child,
      },
      setTimeout: clock.setTimeout,
      clearTimeout: clock.clearTimeout,
    });

    runtime.start();
    child.stdout.write("{\"type\":\"error\",\"message\":\"device not found\",\"code\":\"NO_DEVICE\"}\n");
    clock.runTimeout(0);
    assert.strictEqual(controlActionCount(child, "connect"), 2);
    assert.strictEqual(runtime.retryAttempts, 1);

    child.stdout.write("{\"type\":\"error\",\"message\":\"device not found\",\"code\":\"NO_DEVICE\"}\n");
    assert.strictEqual(clock.activeTimeouts().length, 0);
    assert.strictEqual(runtime.retryExhausted, true);
    runtime.stop();
  });

  it("registers command forwarding before sidecar startup can emit commands", () => {
    const sidecar = new FakeSidecarClient();
    sidecar.start = () => {
      sidecar.calls.push(["start"]);
      sidecar.transport.injectCommand({ cmd: "status", battery: 88 });
    };
    const runtime = new HeadlessHardwareBuddyRuntime({
      config: {
        transport: "sidecar",
        backend: "fake",
        keepaliveMs: 0,
        pollStatusMs: 0,
      },
      sidecarClient: sidecar,
    });

    runtime.start();

    assert.deepStrictEqual(runtime.controller.lastDeviceStatus, { cmd: "status", battery: 88 });
    runtime.stop();
  });

  it("keeps the runtime alive and retries if sidecar startup throws", () => {
    const clock = makeIntervalApi();
    const sidecar = new FakeSidecarClient();
    let throwOnce = true;
    sidecar.start = () => {
      sidecar.calls.push(["start"]);
      if (throwOnce) {
        throwOnce = false;
        throw new Error("spawn failed");
      }
    };
    const runtime = new HeadlessHardwareBuddyRuntime({
      config: {
        transport: "sidecar",
        backend: "fake",
        keepaliveMs: 0,
        pollStatusMs: 0,
        retryInitialMs: 5,
      },
      sidecarClient: sidecar,
      setTimeout: clock.setTimeout,
      clearTimeout: clock.clearTimeout,
    });

    const snapshot = runtime.start();

    assert.strictEqual(snapshot.total, 1);
    assert.strictEqual(runtime.started, true);
    assert.strictEqual(clock.activeTimeouts().length, 1);
    assert.deepStrictEqual(sidecar.calls, [["start"]]);

    clock.runTimeout(0);
    assert.deepStrictEqual(sidecar.calls, [
      ["start"],
      ["start"],
      ["connect", { address: "FAKE:CLAWSTICK" }],
    ]);
    runtime.stop();
  });

  it("warns before BLE startup when another Hardware Buddy sidecar is running", () => {
    const logs = [];
    const sidecar = new FakeSidecarClient();
    const runtime = new HeadlessHardwareBuddyRuntime({
      config: {
        transport: "sidecar",
        backend: "bleak",
        keepaliveMs: 0,
        pollStatusMs: 0,
      },
      sidecarClient: sidecar,
      defer: (fn) => fn(),
      listProcesses: () => [
        {
          ProcessId: 100,
          ParentProcessId: 50,
          ProcessName: "python.exe",
          CommandLine: "python C:\\Projects\\ClaudeBuddy\\tools\\hardware_buddy_bridge.py --backend bleak --name-prefix Claude",
        },
        {
          ProcessId: 50,
          ProcessName: "electron.exe",
          CommandLine: "C:\\Apps\\Clawd\\node_modules\\electron\\dist\\electron.exe .",
        },
      ],
      log: (...args) => logs.push(args),
    });

    runtime.start();

    assert.strictEqual(runtime.sidecarContention.hasContention, true);
    assert.deepStrictEqual(sidecar.calls, [
      ["start"],
      ["scan"],
    ]);
    assert.strictEqual(logs[0][0], "warn");
    assert.match(logs[0][1], /existing Hardware Buddy BLE sidecar/);
    assert.match(logs[0][1], /device not found or devices=0/);
    runtime.stop();
  });

  it("defers BLE sidecar contention diagnostics until after the first snapshot", () => {
    const logs = [];
    const sidecar = new FakeSidecarClient();
    let deferred = null;
    let listProcessCalls = 0;
    const runtime = new HeadlessHardwareBuddyRuntime({
      config: {
        transport: "sidecar",
        backend: "bleak",
        keepaliveMs: 0,
        pollStatusMs: 0,
      },
      sidecarClient: sidecar,
      defer: (fn) => {
        deferred = fn;
      },
      listProcesses: () => {
        listProcessCalls += 1;
        return [];
      },
      log: (...args) => logs.push(args),
    });

    const snapshot = runtime.start();

    assert.strictEqual(snapshot.total, 1);
    assert.strictEqual(listProcessCalls, 0);
    assert.strictEqual(typeof deferred, "function");

    deferred();
    assert.strictEqual(listProcessCalls, 1);
    assert.deepStrictEqual(logs, []);
    runtime.stop();
  });

  it("throttles repeated failure-side contention diagnostics", () => {
    let now = 1000;
    let listProcessCalls = 0;
    const child = makeFakeChild();
    const runtime = new HeadlessHardwareBuddyRuntime({
      config: {
        transport: "sidecar",
        backend: "bleak",
        autoConnect: false,
        keepaliveMs: 0,
        pollStatusMs: 0,
      },
      sidecarClientOptions: {
        spawn: () => child,
      },
      defer: () => {},
      now: () => now,
      failureContentionDiagnosticsMinIntervalMs: 30000,
      listProcesses: () => {
        listProcessCalls += 1;
        return [];
      },
    });

    runtime.start();
    runtime.sidecarContention = { hasContention: false, matches: [] };

    child.stdout.write("{\"type\":\"devices\",\"items\":[]}\n");
    assert.strictEqual(listProcessCalls, 1);

    now = 2000;
    child.stdout.write("{\"type\":\"error\",\"message\":\"device not found\",\"code\":\"NO_DEVICE\"}\n");
    assert.strictEqual(listProcessCalls, 1);

    now = 32000;
    child.stdout.write("{\"type\":\"devices\",\"items\":[]}\n");
    assert.strictEqual(listProcessCalls, 2);
    runtime.stop();
  });

  it("does not run sidecar contention diagnostics for fake backend runtime", () => {
    const logs = [];
    const sidecar = new FakeSidecarClient();
    const runtime = new HeadlessHardwareBuddyRuntime({
      config: {
        transport: "sidecar",
        backend: "fake",
        keepaliveMs: 0,
        pollStatusMs: 0,
      },
      sidecarClient: sidecar,
      listProcesses: () => {
        throw new Error("should not list processes");
      },
      log: (...args) => logs.push(args),
    });

    runtime.start();

    assert.deepStrictEqual(logs, []);
    runtime.stop();
  });
});
