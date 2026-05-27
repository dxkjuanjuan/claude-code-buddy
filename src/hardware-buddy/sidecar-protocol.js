"use strict";

// Stdio envelope between the desktop bridge core and the Python BLE sidecar.
// This is not the BLE wire protocol itself: each stdio message is compact
// newline-delimited JSON, with exactly one JSON object per line and no pretty
// printing/indentation. Direction is enforced by sidecar-client / Python code:
// desktop -> sidecar uses snapshot/control, while sidecar -> desktop uses
// command/status/devices/error/log.
// Device scan items should prefer address; use id when the platform cannot
// expose a stable address.

const MAX_SIDECAR_LINE_BYTES = 1024 * 1024;

const CONTROL_ACTIONS = new Set([
  "scan",
  "connect",
  "disconnect",
  "status",
  "unpair",
  "set_name",
  "set_owner",
  "set_time",
  "simulate_permission",
]);

const LOG_LEVELS = new Set([
  "debug",
  "info",
  "warn",
  "error",
]);

function isPlainObject(value) {
  return !!(value && typeof value === "object" && !Array.isArray(value));
}

function protocolError(message) {
  const err = new Error(message);
  err.name = "SidecarProtocolError";
  return err;
}

function normalizeString(value) {
  return typeof value === "string" ? value.trim() : "";
}

function normalizeHeartbeat(data) {
  if (!isPlainObject(data)) throw protocolError("snapshot data must be an object");

  const requiredNumbers = ["total", "running", "waiting", "tokens", "tokens_today"];
  for (const key of requiredNumbers) {
    if (!Number.isFinite(data[key]) || data[key] < 0) {
      throw protocolError(`snapshot data.${key} must be a non-negative number`);
    }
  }
  if (typeof data.msg !== "string") {
    throw protocolError("snapshot data.msg must be a string");
  }
  if (!Array.isArray(data.entries) || data.entries.some((entry) => typeof entry !== "string")) {
    throw protocolError("snapshot data.entries must be a string array");
  }
  if (Object.prototype.hasOwnProperty.call(data, "prompt")) {
    const prompt = data.prompt;
    if (!isPlainObject(prompt)) throw protocolError("snapshot data.prompt must be an object");
    if (!normalizeString(prompt.id)) throw protocolError("snapshot data.prompt.id must be a string");
    if (!normalizeString(prompt.tool)) throw protocolError("snapshot data.prompt.tool must be a string");
    if (typeof prompt.hint !== "string") throw protocolError("snapshot data.prompt.hint must be a string");
  }
  return data;
}

function normalizeCommandData(data) {
  if (!isPlainObject(data)) throw protocolError("command data must be an object");
  if (typeof data.cmd !== "string" && typeof data.ack !== "string") {
    throw protocolError("command data must include cmd or ack");
  }
  return data;
}

function normalizeControlData(action, data) {
  if (data !== undefined && !isPlainObject(data)) throw protocolError("control data must be an object");

  if (action === "set_name" || action === "set_owner") {
    const name = normalizeString(data && data.name);
    if (!name) throw protocolError(`control ${action} requires data.name`);
    return { name };
  }

  if (action === "set_time") {
    const epoch = data && Number(data.epoch);
    const offset = data && Number(data.offset);
    if (!Number.isFinite(epoch) || !Number.isFinite(offset)) {
      throw protocolError("control set_time requires finite data.epoch and data.offset");
    }
    return { epoch, offset };
  }

  if (action === "simulate_permission") {
    const id = normalizeString(data && data.id);
    const decision = normalizeString(data && data.decision);
    if (!id || (decision !== "once" && decision !== "deny")) {
      throw protocolError("control simulate_permission requires data.id and decision once or deny");
    }
    return { id, decision };
  }

  if (action === "connect" && data) {
    const normalized = {};
    const address = normalizeString(data.address);
    const name = normalizeString(data.name);
    if (address) normalized.address = address;
    if (name) normalized.name = name;
    return Object.keys(normalized).length ? normalized : undefined;
  }

  return data || undefined;
}

function normalizeDeviceItem(item) {
  if (!isPlainObject(item)) throw protocolError("devices.items must contain objects");
  const normalized = {};
  const address = normalizeString(item.address);
  const id = normalizeString(item.id);
  const name = normalizeString(item.name);
  const rssi = Number(item.rssi);
  if (address) normalized.address = address;
  if (id) normalized.id = id;
  if (name) normalized.name = name;
  if (Number.isFinite(rssi)) normalized.rssi = rssi;
  if (!normalized.address && !normalized.id && !normalized.name) {
    throw protocolError("devices.items require address, id, or name");
  }
  return normalized;
}

function normalizeSidecarMessage(message) {
  if (!isPlainObject(message)) throw protocolError("sidecar message must be an object");
  const type = normalizeString(message.type);
  if (!type) throw protocolError("sidecar message type is required");

  if (type === "snapshot") {
    return {
      type,
      data: normalizeHeartbeat(message.data),
    };
  }

  if (type === "command") {
    return {
      type,
      data: normalizeCommandData(message.data),
    };
  }

  if (type === "control") {
    const action = normalizeString(message.action);
    if (!CONTROL_ACTIONS.has(action)) {
      throw protocolError("control action is not supported");
    }
    const normalized = { type, action };
    if (Object.prototype.hasOwnProperty.call(message, "data")) {
      const data = normalizeControlData(action, message.data);
      if (data !== undefined) normalized.data = data;
    } else {
      const data = normalizeControlData(action, undefined);
      if (data !== undefined) normalized.data = data;
    }
    return normalized;
  }

  if (type === "status") {
    const normalized = {
      type,
      connected: message.connected === true,
      secure: message.secure === true,
    };
    if (Object.prototype.hasOwnProperty.call(message, "ok")) normalized.ok = message.ok === true;
    if (Object.prototype.hasOwnProperty.call(message, "data")) {
      if (!isPlainObject(message.data)) throw protocolError("status data must be an object");
      normalized.data = message.data;
    }
    if (Object.prototype.hasOwnProperty.call(message, "device")) {
      if (!isPlainObject(message.device)) throw protocolError("status device must be an object");
      normalized.device = message.device;
    }
    return normalized;
  }

  if (type === "devices") {
    if (!Array.isArray(message.items)) throw protocolError("devices.items must be an array");
    return {
      type,
      items: message.items.map(normalizeDeviceItem),
    };
  }

  if (type === "error") {
    const text = normalizeString(message.message);
    if (!text) throw protocolError("error message is required");
    return {
      type,
      message: text,
      ...(typeof message.code === "string" && message.code ? { code: message.code } : {}),
    };
  }

  if (type === "log") {
    const text = normalizeString(message.message);
    if (!text) throw protocolError("log message is required");
    const level = LOG_LEVELS.has(message.level) ? message.level : "info";
    return { type, level, message: text };
  }

  throw protocolError(`unsupported sidecar message type: ${type}`);
}

function encodeSidecarMessage(message) {
  const normalized = normalizeSidecarMessage(message);
  return `${JSON.stringify(normalized)}\n`;
}

function parseSidecarLine(line) {
  const trimmed = typeof line === "string" ? line.trim() : "";
  if (!trimmed) return null;
  let parsed;
  try {
    parsed = JSON.parse(trimmed);
  } catch (err) {
    throw protocolError(`invalid sidecar JSON: ${err.message}`);
  }
  return normalizeSidecarMessage(parsed);
}

function statusMessageFromDeviceAck(ack, options = {}) {
  if (!isPlainObject(ack) || ack.ack !== "status") {
    throw protocolError("status ack must include ack=status");
  }
  const data = isPlainObject(ack.data) ? ack.data : {};
  return normalizeSidecarMessage({
    type: "status",
    connected: options.connected === true,
    secure: data.sec === true,
    ok: ack.ok === true,
    data,
  });
}

class JsonLineParser {
  constructor(options = {}) {
    this.buffer = "";
    this.maxLineBytes = Number.isFinite(options.maxLineBytes) && options.maxLineBytes > 0
      ? Math.floor(options.maxLineBytes)
      : MAX_SIDECAR_LINE_BYTES;
  }

  push(chunk) {
    const text = Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk || "");
    const result = { messages: [], errors: [] };
    this.buffer += text;

    while (true) {
      const newline = this.buffer.indexOf("\n");
      if (newline === -1) break;
      const line = this.buffer.slice(0, newline).replace(/\r$/, "");
      this.buffer = this.buffer.slice(newline + 1);
      this.#consumeLine(line, result);
    }

    if (Buffer.byteLength(this.buffer, "utf8") > this.maxLineBytes) {
      result.errors.push(protocolError("sidecar line exceeded maximum size"));
      this.buffer = "";
    }
    return result;
  }

  flush() {
    const result = { messages: [], errors: [] };
    if (!this.buffer) return result;
    const line = this.buffer.replace(/\r$/, "");
    this.buffer = "";
    this.#consumeLine(line, result);
    return result;
  }

  #consumeLine(line, result) {
    const clean = typeof line === "string" ? line.trim() : "";
    if (!clean) return;
    if (Buffer.byteLength(clean, "utf8") > this.maxLineBytes) {
      result.errors.push(protocolError("sidecar line exceeded maximum size"));
      return;
    }
    try {
      const message = parseSidecarLine(clean);
      if (message) result.messages.push(message);
    } catch (err) {
      result.errors.push(err);
    }
  }
}

module.exports = {
  CONTROL_ACTIONS,
  LOG_LEVELS,
  MAX_SIDECAR_LINE_BYTES,
  JsonLineParser,
  encodeSidecarMessage,
  normalizeSidecarMessage,
  parseSidecarLine,
  statusMessageFromDeviceAck,
};
