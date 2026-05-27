"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert");
const { EventEmitter } = require("node:events");
const { PassThrough, Writable } = require("node:stream");

const { SidecarClient } = require("../src/hardware-buddy/sidecar-client");

class CaptureWritable extends Writable {
  constructor() {
    super();
    this.chunks = [];
  }

  _write(chunk, _encoding, callback) {
    this.chunks.push(Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk));
    callback();
  }

  text() {
    return this.chunks.join("");
  }
}

function makeFakeChild() {
  const child = new EventEmitter();
  child.stdin = new CaptureWritable();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.killed = false;
  child.kill = () => {
    child.killed = true;
    child.emit("exit", null, "SIGTERM");
    return true;
  };
  return child;
}

function spawnFake(child, calls = []) {
  return (command, args, options) => {
    calls.push({ command, args, options });
    return child;
  };
}

function heartbeat(overrides = {}) {
  return {
    total: 1,
    running: 1,
    waiting: 0,
    msg: "Build core",
    entries: ["Build core"],
    tokens: 0,
    tokens_today: 0,
    ...overrides,
  };
}

function writtenMessages(child) {
  const text = child.stdin.text().trim();
  if (!text) return [];
  return text.split("\n").filter(Boolean).map((line) => JSON.parse(line));
}

describe("hardware buddy sidecar client", () => {
  it("starts fail-closed and spawns the configured sidecar process", () => {
    const child = makeFakeChild();
    const calls = [];
    const client = new SidecarClient({
      spawn: spawnFake(child, calls),
      command: "python3",
      args: ["tools/hardware_buddy_bridge.py"],
      spawnOptions: { cwd: "sidecar" },
    });

    assert.strictEqual(client.transport.connected, false);
    assert.strictEqual(client.transport.secure, false);
    assert.strictEqual(client.transport.isSecure(), false);

    assert.strictEqual(client.start(), child);
    assert.strictEqual(client.started, true);
    assert.strictEqual(client.start(), child);
    assert.strictEqual(calls.length, 1);
    assert.deepStrictEqual(calls[0], {
      command: "python3",
      args: ["tools/hardware_buddy_bridge.py"],
      options: {
        stdio: ["pipe", "pipe", "pipe"],
        cwd: "sidecar",
      },
    });
  });

  it("writes snapshots and control messages as compact JSONL", () => {
    const child = makeFakeChild();
    const client = new SidecarClient({ spawn: spawnFake(child) });
    client.start();

    assert.strictEqual(client.sendSnapshot(heartbeat({
      prompt: { id: "hb_1", tool: "Bash", hint: "git status" },
    }), { reason: "test" }), true);
    assert.strictEqual(client.scan(), true);
    assert.strictEqual(client.connect(), true);
    assert.strictEqual(client.connect("AA:BB"), true);
    assert.strictEqual(client.disconnect(), true);
    assert.strictEqual(client.pollStatus(), true);
    assert.strictEqual(client.unpair(), true);
    assert.strictEqual(client.setOwner(" Felix "), true);
    assert.strictEqual(client.setName(" Clawstick "), true);
    assert.strictEqual(client.setTime(1775731234, -25200), true);
    assert.strictEqual(client.simulatePermission(" hb_1 ", "once"), true);

    assert.deepStrictEqual(writtenMessages(child), [
      {
        type: "snapshot",
        data: heartbeat({
          prompt: { id: "hb_1", tool: "Bash", hint: "git status" },
        }),
      },
      { type: "control", action: "scan" },
      { type: "control", action: "connect" },
      { type: "control", action: "connect", data: { address: "AA:BB" } },
      { type: "control", action: "disconnect" },
      { type: "control", action: "status" },
      { type: "control", action: "unpair" },
      { type: "control", action: "set_owner", data: { name: "Felix" } },
      { type: "control", action: "set_name", data: { name: "Clawstick" } },
      { type: "control", action: "set_time", data: { epoch: 1775731234, offset: -25200 } },
      { type: "control", action: "simulate_permission", data: { id: "hb_1", decision: "once" } },
    ]);
  });

  it("does not write before the child process is running", () => {
    const logs = [];
    const client = new SidecarClient({ log: (...args) => logs.push(args) });

    assert.strictEqual(client.sendSnapshot(heartbeat()), false);
    assert.strictEqual(logs.length, 1);
    assert.strictEqual(logs[0][0], "warn");
    assert.match(logs[0][1], /process is not running/);
  });

  it("forwards command message data to transport listeners", () => {
    const child = makeFakeChild();
    const optionCommands = [];
    const client = new SidecarClient({
      spawn: spawnFake(child),
      onCommand: (command) => optionCommands.push(command),
    });
    const transportCommands = [];
    const unsubscribe = client.transport.onCommand((command) => transportCommands.push(command));
    client.start();

    child.stdout.write("{\"type\":\"command\",\"data\":{\"cmd\":\"permission\",\"id\":\"hb_1\",\"decision\":\"once\"}}\n");

    assert.deepStrictEqual(optionCommands, [
      { cmd: "permission", id: "hb_1", decision: "once" },
    ]);
    assert.deepStrictEqual(transportCommands, [
      { cmd: "permission", id: "hb_1", decision: "once" },
    ]);

    unsubscribe();
    child.stdout.write("{\"type\":\"command\",\"data\":{\"ack\":\"status\",\"ok\":true}}\n");

    assert.deepStrictEqual(optionCommands, [
      { cmd: "permission", id: "hb_1", decision: "once" },
      { ack: "status", ok: true },
    ]);
    assert.deepStrictEqual(transportCommands, [
      { cmd: "permission", id: "hb_1", decision: "once" },
    ]);
  });

  it("updates transport state from status messages", () => {
    const child = makeFakeChild();
    const statuses = [];
    const changes = [];
    const client = new SidecarClient({
      spawn: spawnFake(child),
      onStatus: (status) => statuses.push(status),
      onTransportStateChanged: (state) => changes.push(state),
    });
    client.start();

    child.stdout.write("{\"type\":\"status\",\"connected\":true,\"secure\":true,\"ok\":true,\"device\":{\"address\":\"AA:BB\"}}\n");
    child.stdout.write("{\"type\":\"status\",\"connected\":true,\"secure\":false}\n");

    assert.strictEqual(client.transport.connected, true);
    assert.strictEqual(client.transport.secure, false);
    assert.deepStrictEqual(statuses, [
      {
        type: "status",
        connected: true,
        secure: true,
        ok: true,
        device: { address: "AA:BB" },
      },
      {
        type: "status",
        connected: true,
        secure: false,
      },
    ]);
    assert.deepStrictEqual(changes, [
      {
        connected: true,
        secure: true,
        previous: { connected: false, secure: false },
      },
      {
        connected: true,
        secure: false,
        previous: { connected: true, secure: true },
      },
    ]);
  });

  it("marks the transport insecure and disconnected after child exit", () => {
    const child = makeFakeChild();
    const changes = [];
    const logs = [];
    const client = new SidecarClient({
      spawn: spawnFake(child),
      log: (...args) => logs.push(args),
      onTransportStateChanged: (state) => changes.push(state),
    });
    client.start();
    child.stdout.write("{\"type\":\"status\",\"connected\":true,\"secure\":true}\n");
    changes.length = 0;

    child.emit("exit", 1, null);

    assert.strictEqual(client.child, null);
    assert.strictEqual(client.started, false);
    assert.strictEqual(client.transport.connected, false);
    assert.strictEqual(client.transport.secure, false);
    assert.deepStrictEqual(changes, [
      {
        connected: false,
        secure: false,
        previous: { connected: true, secure: true },
      },
    ]);
    assert.strictEqual(logs[0][0], "warn");
    assert.match(logs[0][1], /sidecar exited/);
  });

  it("flushes a final unterminated stdout line on stream end", async () => {
    const child = makeFakeChild();
    const commands = [];
    const client = new SidecarClient({
      spawn: spawnFake(child),
      onCommand: (command) => commands.push(command),
    });
    client.start();

    child.stdout.write("{\"type\":\"command\",\"data\":{\"cmd\":\"permission\",\"id\":\"hb_1\",\"decision\":\"deny\"}}");
    assert.deepStrictEqual(commands, []);

    const ended = new Promise((resolve) => child.stdout.once("end", resolve));
    child.stdout.end();
    await ended;

    assert.deepStrictEqual(commands, [
      { cmd: "permission", id: "hb_1", decision: "deny" },
    ]);
  });

  it("routes devices, error, and log messages outside the controller command path", () => {
    const child = makeFakeChild();
    const commands = [];
    const devices = [];
    const errors = [];
    const sidecarLogs = [];
    const logs = [];
    const client = new SidecarClient({
      spawn: spawnFake(child),
      onCommand: (command) => commands.push(command),
      onDevices: (items) => devices.push(items),
      onError: (err) => errors.push(err),
      onLog: (message) => sidecarLogs.push(message),
      log: (...args) => logs.push(args),
    });
    client.start();

    child.stdout.write("{\"type\":\"devices\",\"items\":[{\"address\":\"AA:BB\",\"name\":\" Clawstick \",\"rssi\":-50}]}\n");
    child.stdout.write("{\"type\":\"error\",\"message\":\" no device \",\"code\":\"NO_DEVICE\"}\n");
    child.stdout.write("{\"type\":\"log\",\"level\":\"debug\",\"message\":\"connected\"}\n");

    assert.deepStrictEqual(commands, []);
    assert.deepStrictEqual(devices, [[
      { address: "AA:BB", name: "Clawstick", rssi: -50 },
    ]]);
    assert.deepStrictEqual(errors, [
      { type: "error", message: "no device", code: "NO_DEVICE" },
    ]);
    assert.deepStrictEqual(sidecarLogs, [
      { type: "log", level: "debug", message: "connected" },
    ]);
    assert.deepStrictEqual(logs, [
      ["error", "no device", { type: "error", message: "no device", code: "NO_DEVICE" }],
      ["debug", "connected", { type: "log", level: "debug", message: "connected" }],
    ]);
  });

  it("reports parser errors and continues parsing later lines", () => {
    const child = makeFakeChild();
    const commands = [];
    const errors = [];
    const client = new SidecarClient({
      spawn: spawnFake(child),
      onCommand: (command) => commands.push(command),
      onError: (err) => errors.push(err),
    });
    client.start();

    child.stdout.write("{bad json\n");
    child.stdout.write("{\"type\":\"command\",\"data\":{\"cmd\":\"permission\",\"id\":\"hb_2\",\"decision\":\"once\"}}\n");

    assert.strictEqual(errors.length, 1);
    assert.match(errors[0].message, /invalid sidecar JSON/);
    assert.deepStrictEqual(commands, [
      { cmd: "permission", id: "hb_2", decision: "once" },
    ]);
  });

  it("preserves parser options across start", () => {
    const child = makeFakeChild();
    const errors = [];
    const sidecarLogs = [];
    const client = new SidecarClient({
      spawn: spawnFake(child),
      parserOptions: { maxLineBytes: 40 },
      onError: (err) => errors.push(err),
      onLog: (message) => sidecarLogs.push(message),
    });
    client.start();

    child.stdout.write(`${"x".repeat(80)}\n`);
    child.stdout.write("{\"type\":\"log\",\"message\":\"ok\"}\n");

    assert.strictEqual(errors.length, 1);
    assert.match(errors[0].message, /maximum size/);
    assert.deepStrictEqual(sidecarLogs, [
      { type: "log", level: "info", message: "ok" },
    ]);
  });

  it("stops the child process and clears transport state", () => {
    const child = makeFakeChild();
    const changes = [];
    const client = new SidecarClient({
      spawn: spawnFake(child),
      onTransportStateChanged: (state) => changes.push(state),
    });
    client.start();
    child.stdout.write("{\"type\":\"status\",\"connected\":true,\"secure\":true}\n");
    changes.length = 0;

    client.stop();

    assert.strictEqual(child.killed, true);
    assert.strictEqual(client.child, null);
    assert.strictEqual(client.started, false);
    assert.strictEqual(client.transport.connected, false);
    assert.strictEqual(client.transport.secure, false);
    assert.deepStrictEqual(changes, [
      {
        connected: false,
        secure: false,
        previous: { connected: true, secure: true },
      },
    ]);
  });
});
