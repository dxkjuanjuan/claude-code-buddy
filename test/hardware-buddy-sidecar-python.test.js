"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert");
const { spawnSync } = require("node:child_process");
const path = require("node:path");

const { SidecarClient } = require("../src/hardware-buddy/sidecar-client");

function findPython() {
  const candidates = process.env.PYTHON
    ? [{ command: process.env.PYTHON, prefixArgs: [] }]
    : [
      { command: "python", prefixArgs: [] },
      { command: "python3", prefixArgs: [] },
      { command: "py", prefixArgs: ["-3"] },
    ];

  for (const candidate of candidates) {
    const result = spawnSync(candidate.command, [...candidate.prefixArgs, "--version"], {
      encoding: "utf8",
      timeout: 2000,
      windowsHide: true,
    });
    if (result.status === 0) return candidate;
  }
  return null;
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

function waitFor(predicate, label, timeoutMs = 2500) {
  const startedAt = Date.now();
  return new Promise((resolve, reject) => {
    const tick = () => {
      const value = predicate();
      if (value) {
        resolve(value);
        return;
      }
      if (Date.now() - startedAt >= timeoutMs) {
        reject(new Error(`timed out waiting for ${label}`));
        return;
      }
      setTimeout(tick, 10);
    };
    tick();
  });
}

function scriptArgs(python, extraArgs = []) {
  return [
    ...python.prefixArgs,
    path.join(__dirname, "..", "tools", "hardware_buddy_bridge.py"),
    "--backend",
    "fake",
    ...extraArgs,
  ];
}

describe("hardware buddy Python sidecar", () => {
  const python = findPython();

  it("keeps Python sidecar modules syntactically valid", {
    skip: python ? false : "Python is not available",
  }, () => {
    const result = spawnSync(python.command, [
      ...python.prefixArgs,
      "-m",
      "py_compile",
      path.join(__dirname, "..", "tools", "hardware_buddy_common.py"),
      path.join(__dirname, "..", "tools", "hardware_buddy_bridge.py"),
      path.join(__dirname, "..", "tools", "backends", "__init__.py"),
      path.join(__dirname, "..", "tools", "backends", "bleak_backend.py"),
    ], {
      encoding: "utf8",
      timeout: 5000,
      windowsHide: true,
    });

    assert.strictEqual(result.status, 0, result.stderr || result.stdout);
  });

  it("accepts the pairing spike flag at the sidecar process boundary", {
    skip: python ? false : "Python is not available",
  }, () => {
    const result = spawnSync(python.command, scriptArgs(python, ["--pair"]), {
      encoding: "utf8",
      input: "",
      timeout: 5000,
      windowsHide: true,
    });

    assert.strictEqual(result.status, 0, result.stderr || result.stdout);
  });

  it("classifies common BLE authentication failures", {
    skip: python ? false : "Python is not available",
  }, () => {
    const toolsDir = path.join(__dirname, "..", "tools");
    const script = `
import sys
sys.path.insert(0, ${JSON.stringify(toolsDir)})
from backends.bleak_backend import BleakBackend

class Err(Exception):
    pass

cases = [
    Err("GATT Protocol Error: Insufficient Authentication"),
    Err("Access is denied"),
    Err("GattCommunicationStatus.AccessDenied"),
    Err("0x80650005"),
    Err("authentication is required"),
]
wrapped = Err("outer bleak wrapper")
wrapped.__cause__ = Err("Access is denied")

for err in [*cases, wrapped]:
    assert BleakBackend._is_authentication_error(err), str(err)

assert not BleakBackend._is_authentication_error(Err("device not found"))
`;
    const result = spawnSync(python.command, [
      ...python.prefixArgs,
      "-c",
      script,
    ], {
      encoding: "utf8",
      timeout: 5000,
      windowsHide: true,
    });

    assert.strictEqual(result.status, 0, result.stderr || result.stdout);
  });

  it("round-trips scan, connect, status, snapshot, and disconnect over JSONL stdio", {
    skip: python ? false : "Python is not available",
  }, async () => {
    const devices = [];
    const statuses = [];
    const errors = [];
    const logs = [];
    const client = new SidecarClient({
      command: python.command,
      args: scriptArgs(python),
      onDevices: (items) => devices.push(items),
      onStatus: (status) => statuses.push(status),
      onError: (err) => errors.push(err),
      log: (...args) => logs.push(args),
    });

    client.start();
    try {
      assert.strictEqual(client.transport.connected, false);
      assert.strictEqual(client.transport.secure, false);

      assert.strictEqual(client.scan(), true);
      const scanned = await waitFor(() => devices[0], "fake scan results");
      assert.deepStrictEqual(scanned, [
        {
          address: "FAKE:CLAWSTICK",
          id: "fake-clawstick",
          name: "Clawstick Fake",
          rssi: -42,
        },
      ]);

      assert.strictEqual(client.connect("FAKE:CLAWSTICK"), true);
      const connected = await waitFor(
        () => statuses.find((status) => status.connected === true),
        "connected status",
      );
      assert.strictEqual(connected.secure, true);
      assert.strictEqual(client.transport.connected, true);
      assert.strictEqual(client.transport.secure, true);

      const ownerStart = statuses.length;
      assert.strictEqual(client.setOwner("Felix"), true);
      const ownerStatus = await waitFor(
        () => statuses.slice(ownerStart).find((status) => status.data && status.data.owner === "Felix"),
        "owner status",
      );
      assert.strictEqual(ownerStatus.connected, true);

      assert.strictEqual(client.setTime(1775731234, -25200), true);
      const snapshotLogStart = logs.length;
      assert.strictEqual(client.sendSnapshot(heartbeat({
        prompt: { id: "hb_1", tool: "Bash", hint: "git status" },
      })), true);
      await waitFor(
        () => logs.slice(snapshotLogStart).find((entry) => /snapshot received/.test(entry[1])),
        "snapshot echo log",
      );

      const commands = [];
      const unsubscribe = client.transport.onCommand((command) => commands.push(command));
      assert.strictEqual(client.simulatePermission("hb_1", "once"), true);
      await waitFor(
        () => commands.find((command) => command.cmd === "permission"),
        "simulated permission command",
      );
      unsubscribe();
      assert.deepStrictEqual(commands, [
        { cmd: "permission", id: "hb_1", decision: "once" },
      ]);

      const disconnectStart = statuses.length;
      assert.strictEqual(client.disconnect(), true);
      const disconnected = await waitFor(
        () => statuses.slice(disconnectStart).find((status) => status.connected === false),
        "disconnected status",
      );
      assert.strictEqual(disconnected.secure, false);
      assert.strictEqual(client.transport.connected, false);
      assert.strictEqual(client.transport.secure, false);

      assert.deepStrictEqual(errors, []);
      assert.deepStrictEqual(logs.slice(snapshotLogStart), [
        [
          "debug",
          "snapshot received",
          { type: "log", level: "debug", message: "snapshot received" },
        ],
      ]);
    } finally {
      client.stop();
    }
  });

  it("rejects connect without an explicit device identifier", {
    skip: python ? false : "Python is not available",
  }, async () => {
    const errors = [];
    const logs = [];
    const client = new SidecarClient({
      command: python.command,
      args: scriptArgs(python),
      onError: (err) => errors.push(err),
      log: (...args) => logs.push(args),
    });

    client.start();
    try {
      assert.strictEqual(client.connect(), true);
      const error = await waitFor(() => errors[0], "missing connect target error");

      assert.deepStrictEqual(error, {
        type: "error",
        message: "connect requires data.address, id, or name",
        code: "BAD_CONTROL",
      });
      assert.strictEqual(client.transport.connected, false);
      assert.strictEqual(client.transport.secure, false);
      assert.deepStrictEqual(logs, [
        [
          "error",
          "connect requires data.address, id, or name",
          {
            type: "error",
            message: "connect requires data.address, id, or name",
            code: "BAD_CONTROL",
          },
        ],
      ]);
    } finally {
      client.stop();
    }
  });

  it("keeps the transport insecure when the backend cannot confirm encryption", {
    skip: python ? false : "Python is not available",
  }, async () => {
    const statuses = [];
    const client = new SidecarClient({
      command: python.command,
      args: scriptArgs(python, ["--fake-secure", "false"]),
      onStatus: (status) => statuses.push(status),
    });

    client.start();
    try {
      assert.strictEqual(client.connect("FAKE:CLAWSTICK"), true);
      const connected = await waitFor(
        () => statuses.find((status) => status.connected === true),
        "connected insecure status",
      );

      assert.strictEqual(connected.secure, false);
      assert.strictEqual(client.transport.connected, true);
      assert.strictEqual(client.transport.secure, false);
      assert.strictEqual(client.transport.isSecure(), false);
    } finally {
      client.stop();
    }
  });
});
