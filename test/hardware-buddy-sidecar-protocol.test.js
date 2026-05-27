"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert");

const {
  JsonLineParser,
  encodeSidecarMessage,
  normalizeSidecarMessage,
  parseSidecarLine,
  statusMessageFromDeviceAck,
} = require("../src/hardware-buddy/sidecar-protocol");

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

describe("hardware buddy sidecar protocol messages", () => {
  it("encodes normalized snapshot messages as newline-delimited JSON", () => {
    const line = encodeSidecarMessage({
      type: "snapshot",
      data: heartbeat({
        prompt: { id: "hb_1", tool: "Bash", hint: "git status" },
      }),
    });

    assert.match(line, /\n$/);
    assert.deepStrictEqual(JSON.parse(line), {
      type: "snapshot",
      data: heartbeat({
        prompt: { id: "hb_1", tool: "Bash", hint: "git status" },
      }),
    });
  });

  it("normalizes command, control, status, error, and log messages", () => {
    assert.deepStrictEqual(normalizeSidecarMessage({
      type: "command",
      data: { cmd: "permission", id: "hb_1", decision: "once" },
    }), {
      type: "command",
      data: { cmd: "permission", id: "hb_1", decision: "once" },
    });

    assert.deepStrictEqual(normalizeSidecarMessage({
      type: "control",
      action: "status",
    }), {
      type: "control",
      action: "status",
    });

    assert.deepStrictEqual(normalizeSidecarMessage({
      type: "control",
      action: "connect",
      data: { address: "AA:BB", ignored: true },
    }), {
      type: "control",
      action: "connect",
      data: { address: "AA:BB" },
    });

    assert.deepStrictEqual(normalizeSidecarMessage({
      type: "control",
      action: "connect",
      data: {},
    }), {
      type: "control",
      action: "connect",
    });

    assert.deepStrictEqual(normalizeSidecarMessage({
      type: "control",
      action: "set_owner",
      data: { name: " Felix " },
    }), {
      type: "control",
      action: "set_owner",
      data: { name: "Felix" },
    });

    assert.deepStrictEqual(normalizeSidecarMessage({
      type: "control",
      action: "set_name",
      data: { name: " Clawstick " },
    }), {
      type: "control",
      action: "set_name",
      data: { name: "Clawstick" },
    });

    assert.deepStrictEqual(normalizeSidecarMessage({
      type: "control",
      action: "set_time",
      data: { epoch: 1775731234, offset: -25200 },
    }), {
      type: "control",
      action: "set_time",
      data: { epoch: 1775731234, offset: -25200 },
    });

    assert.deepStrictEqual(normalizeSidecarMessage({
      type: "control",
      action: "simulate_permission",
      data: { id: " hb_1 ", decision: "once" },
    }), {
      type: "control",
      action: "simulate_permission",
      data: { id: "hb_1", decision: "once" },
    });

    assert.deepStrictEqual(normalizeSidecarMessage({
      type: "status",
      connected: true,
      device: { address: "AA:BB", name: "Clawstick" },
    }), {
      type: "status",
      connected: true,
      secure: false,
      device: { address: "AA:BB", name: "Clawstick" },
    });

    assert.deepStrictEqual(normalizeSidecarMessage({
      type: "error",
      message: "  no device  ",
      code: "NO_DEVICE",
    }), {
      type: "error",
      message: "no device",
      code: "NO_DEVICE",
    });

    assert.deepStrictEqual(normalizeSidecarMessage({
      type: "log",
      level: "loud",
      message: "connected",
    }), {
      type: "log",
      level: "info",
      message: "connected",
    });
  });

  it("normalizes scanned device lists", () => {
    assert.deepStrictEqual(normalizeSidecarMessage({
      type: "devices",
      items: [
        { address: "AA:BB", name: " Clawstick ", rssi: -51, extra: true },
        { id: "winrt-id", name: "Buddy" },
      ],
    }), {
      type: "devices",
      items: [
        { address: "AA:BB", name: "Clawstick", rssi: -51 },
        { id: "winrt-id", name: "Buddy" },
      ],
    });
  });

  it("derives sidecar status from the official device status ack", () => {
    const status = statusMessageFromDeviceAck({
      ack: "status",
      ok: true,
      data: { name: "Clawd", sec: true, batt: 88 },
    }, {
      connected: true,
    });

    assert.deepStrictEqual(status, {
      type: "status",
      connected: true,
      secure: true,
      ok: true,
      data: { name: "Clawd", sec: true, batt: 88 },
    });
  });

  it("fails closed for status acks unless connected is explicit", () => {
    assert.deepStrictEqual(statusMessageFromDeviceAck({
      ack: "status",
      ok: false,
      data: { sec: true },
    }), {
      type: "status",
      connected: false,
      secure: true,
      ok: false,
      data: { sec: true },
    });

    assert.deepStrictEqual(statusMessageFromDeviceAck({
      ack: "status",
      ok: true,
    }), {
      type: "status",
      connected: false,
      secure: false,
      ok: true,
      data: {},
    });
  });

  it("rejects invalid message shapes before they cross process boundaries", () => {
    assert.throws(() => normalizeSidecarMessage({ type: "snapshot", data: { total: 1 } }), /running/);
    assert.throws(() => normalizeSidecarMessage({ type: "command", data: { id: "hb_1" } }), /cmd or ack/);
    assert.throws(() => normalizeSidecarMessage({ type: "control", action: "format-disk" }), /control action/);
    assert.throws(() => normalizeSidecarMessage({ type: "control", action: "connect", data: [] }), /control data/);
    assert.throws(() => normalizeSidecarMessage({ type: "control", action: "set_owner" }), /data.name/);
    assert.throws(() => normalizeSidecarMessage({ type: "control", action: "set_time", data: { epoch: 1 } }), /set_time/);
    assert.throws(() => normalizeSidecarMessage({ type: "control", action: "simulate_permission", data: { id: "hb_1", decision: "always" } }), /simulate_permission/);
    assert.throws(() => normalizeSidecarMessage({ type: "status", data: [] }), /status data/);
    assert.throws(() => normalizeSidecarMessage({ type: "devices", items: [{}] }), /address, id, or name/);
    assert.throws(() => normalizeSidecarMessage({ type: "devices", items: [null] }), /devices.items/);
    assert.throws(() => normalizeSidecarMessage({ type: "unknown" }), /unsupported/);
  });
});

describe("hardware buddy sidecar JSONL parser", () => {
  it("parses complete lines", () => {
    const message = parseSidecarLine(JSON.stringify({
      type: "command",
      data: { cmd: "permission", id: "hb_1", decision: "deny" },
    }));

    assert.deepStrictEqual(message, {
      type: "command",
      data: { cmd: "permission", id: "hb_1", decision: "deny" },
    });
  });

  it("handles split chunks and sticky packets", () => {
    const parser = new JsonLineParser();
    const first = parser.push("{\"type\":\"status\",\"connected\":true");
    assert.deepStrictEqual(first, { messages: [], errors: [] });

    const second = parser.push("}\n{\"type\":\"command\",\"data\":{\"cmd\":\"permission\",\"id\":\"hb_1\",\"decision\":\"once\"}}\n");

    assert.strictEqual(second.errors.length, 0);
    assert.deepStrictEqual(second.messages, [
      { type: "status", connected: true, secure: false },
      { type: "command", data: { cmd: "permission", id: "hb_1", decision: "once" } },
    ]);
  });

  it("supports CRLF and ignores blank lines", () => {
    const parser = new JsonLineParser();
    const result = parser.push("\r\n{\"type\":\"log\",\"message\":\"hello\"}\r\n\n");

    assert.strictEqual(result.errors.length, 0);
    assert.deepStrictEqual(result.messages, [
      { type: "log", level: "info", message: "hello" },
    ]);
  });

  it("reports malformed JSON and continues parsing later lines", () => {
    const parser = new JsonLineParser();
    const result = parser.push("{bad json\n{\"type\":\"status\",\"connected\":true,\"secure\":true}\n");

    assert.strictEqual(result.errors.length, 1);
    assert.match(result.errors[0].message, /invalid sidecar JSON/);
    assert.deepStrictEqual(result.messages, [
      { type: "status", connected: true, secure: true },
    ]);
  });

  it("flushes the final unterminated line", () => {
    const parser = new JsonLineParser();
    assert.deepStrictEqual(parser.push("{\"type\":\"log\",\"message\":\"tail\"}"), {
      messages: [],
      errors: [],
    });

    assert.deepStrictEqual(parser.flush(), {
      messages: [{ type: "log", level: "info", message: "tail" }],
      errors: [],
    });
  });

  it("bounds line size to avoid unbounded sidecar output buffering", () => {
    const parser = new JsonLineParser({ maxLineBytes: 10 });
    const result = parser.push("{\"type\":\"log\",\"message\":\"too long\"}");

    assert.strictEqual(result.messages.length, 0);
    assert.strictEqual(result.errors.length, 1);
    assert.match(result.errors[0].message, /maximum size/);
    assert.deepStrictEqual(parser.flush(), { messages: [], errors: [] });
  });

  it("recovers after an oversized complete line", () => {
    const parser = new JsonLineParser({ maxLineBytes: 40 });
    const oversized = parser.push(`${"x".repeat(80)}\n`);
    assert.strictEqual(oversized.messages.length, 0);
    assert.strictEqual(oversized.errors.length, 1);

    const ok = parser.push("{\"type\":\"log\",\"message\":\"ok\"}\n");
    assert.deepStrictEqual(ok, {
      messages: [{ type: "log", level: "info", message: "ok" }],
      errors: [],
    });
  });
});
