"use strict";

const { StaticHardwareBuddySource } = require("./static-source");
const {
  DEFAULT_MAX_SOURCE_BYTES,
  normalizeJsonFileState,
  permissionKey,
} = require("./json-file-source");

function cleanString(value) {
  return typeof value === "string" ? value.trim() : "";
}

function plainObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : null;
}

function lineBytes(value) {
  return Buffer.byteLength(String(value || ""), "utf8");
}

function unwrapStateMessage(value) {
  const object = plainObject(value);
  if (!object) throw new Error("stdin-jsonl source line must contain a JSON object");

  const type = cleanString(object.type);
  if (!type) return object;
  if (type !== "state") {
    throw new Error(`unsupported stdin-jsonl message type: ${type}`);
  }

  if (plainObject(object.data)) return object.data;
  if (plainObject(object.state)) return object.state;
  return object;
}

class StdinJsonlHardwareBuddySource extends StaticHardwareBuddySource {
  constructor(options = {}) {
    super({
      title: options.title,
      state: options.state,
      doNotDisturb: options.doNotDisturb,
      now: options.now,
    });
    this.stream = options.stream || options.stdin || process.stdin;
    this.maxBytes = Math.max(1, Math.floor(Number(options.maxBytes || options.sourceMaxBytes || DEFAULT_MAX_SOURCE_BYTES)));
    this.now = Number.isFinite(options.now)
      ? () => options.now
      : (typeof options.now === "function" ? options.now : () => Date.now());
    this.log = typeof options.log === "function" ? options.log : () => {};
    this.autoResume = options.autoResume !== false;
    this.buffer = "";
    this.discardingOversizedLine = false;
    this.started = false;
    this.lastSignature = "";
    this.lastErrorKey = "";
    this.permissionIdentities = new Map();
    this.resolvedPermissionKeys = new Set();
    this.onData = null;
    this.onError = null;
    this.onEnd = null;
  }

  start() {
    if (this.started) return;
    this.started = true;
    if (!this.stream || typeof this.stream.on !== "function") {
      this.#logError("missing-stream", "stdin-jsonl source requires a readable stream");
      return;
    }

    this.onData = (chunk) => this.#handleData(chunk);
    this.onError = (err) => {
      const message = err && err.message ? err.message : String(err);
      this.#logError(`stream-error:${message}`, `stdin-jsonl source stream error: ${message}`);
    };
    this.onEnd = () => {
      if (!this.discardingOversizedLine && this.buffer.trim()) {
        const line = this.buffer;
        this.buffer = "";
        this.applyLine(line);
      }
      this.discardingOversizedLine = false;
      this.log("debug", "stdin-jsonl source stream ended");
    };

    if (typeof this.stream.setEncoding === "function") {
      this.stream.setEncoding("utf8");
    }
    this.stream.on("data", this.onData);
    this.stream.on("error", this.onError);
    this.stream.on("end", this.onEnd);
    if (this.autoResume && typeof this.stream.resume === "function") {
      this.stream.resume();
    }
  }

  stop() {
    if (!this.started) return;
    this.started = false;
    if (this.stream && typeof this.stream.off === "function") {
      if (this.onData) this.stream.off("data", this.onData);
      if (this.onError) this.stream.off("error", this.onError);
      if (this.onEnd) this.stream.off("end", this.onEnd);
    } else if (this.stream && typeof this.stream.removeListener === "function") {
      if (this.onData) this.stream.removeListener("data", this.onData);
      if (this.onError) this.stream.removeListener("error", this.onError);
      if (this.onEnd) this.stream.removeListener("end", this.onEnd);
    }
    if (this.autoResume && this.stream && typeof this.stream.pause === "function") {
      this.stream.pause();
    }
    this.onData = null;
    this.onError = null;
    this.onEnd = null;
    this.buffer = "";
    this.discardingOversizedLine = false;
  }

  applyLine(line, { emit = true } = {}) {
    const rawLine = String(line || "").trim();
    if (!rawLine) return true;
    if (lineBytes(rawLine) > this.maxBytes) {
      this.#logError("line-too-large", `stdin-jsonl source line is too large: exceeds ${this.maxBytes} bytes`);
      return false;
    }

    let parsed;
    try {
      parsed = JSON.parse(rawLine);
    } catch (err) {
      const message = err && err.message ? err.message : String(err);
      this.#logError(`parse:${message}`, `invalid stdin-jsonl source line: ${message}`);
      return false;
    }

    let state;
    try {
      state = normalizeJsonFileState(unwrapStateMessage(parsed), { now: this.now() });
    } catch (err) {
      const message = err && err.message ? err.message : String(err);
      this.#logError(`state:${message}`, `invalid stdin-jsonl source state: ${message}`);
      return false;
    }

    state.pendingPermissions = this.#filterResolvedPermissions(state.pendingPermissions);
    state.pendingPermissions = this.#preservePermissionIdentities(state.pendingPermissions);
    const signature = JSON.stringify({
      sessions: state.sessions,
      pendingPermissions: state.pendingPermissions,
      doNotDisturb: state.doNotDisturb,
    });
    if (signature === this.lastSignature) {
      this.lastErrorKey = "";
      return true;
    }

    this.sessions = state.sessions;
    this.pendingPermissions = state.pendingPermissions;
    this.doNotDisturb = state.doNotDisturb;
    this.lastSignature = signature;
    this.lastErrorKey = "";
    if (emit) this.emitChange("state-change");
    return true;
  }

  resolvePermissionEntry(entry) {
    const key = permissionKey(entry);
    if (key) this.resolvedPermissionKeys.add(key);
    const before = this.pendingPermissions.length;
    this.pendingPermissions = this.pendingPermissions.filter((candidate) => candidate !== entry);
    if (key) this.permissionIdentities.delete(key);
    return this.pendingPermissions.length !== before;
  }

  #handleData(chunk) {
    let text = Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk);
    if (this.discardingOversizedLine) {
      const newlineIndex = text.indexOf("\n");
      if (newlineIndex === -1) return;
      text = text.slice(newlineIndex + 1);
      this.discardingOversizedLine = false;
    }

    this.buffer += text;
    let newlineIndex = this.buffer.indexOf("\n");
    while (newlineIndex !== -1) {
      let line = this.buffer.slice(0, newlineIndex);
      if (line.endsWith("\r")) line = line.slice(0, -1);
      this.buffer = this.buffer.slice(newlineIndex + 1);
      this.applyLine(line);
      newlineIndex = this.buffer.indexOf("\n");
    }

    if (lineBytes(this.buffer) > this.maxBytes) {
      this.#logError("line-too-large", `stdin-jsonl source line is too large: exceeds ${this.maxBytes} bytes`);
      this.buffer = "";
      this.discardingOversizedLine = true;
    }
  }

  #preservePermissionIdentities(permissions) {
    const next = new Map();
    const out = [];
    for (const permission of permissions) {
      const key = permissionKey(permission);
      const existing = key && !next.has(key) ? this.permissionIdentities.get(key) : null;
      if (existing) {
        Object.assign(existing, permission);
        next.set(key, existing);
        out.push(existing);
      } else {
        if (key && !next.has(key)) next.set(key, permission);
        out.push(permission);
      }
    }
    this.permissionIdentities = next;
    return out;
  }

  #filterResolvedPermissions(permissions) {
    if (this.resolvedPermissionKeys.size === 0) return permissions;
    const currentKeys = new Set();
    for (const permission of permissions) {
      const key = permissionKey(permission);
      if (key) currentKeys.add(key);
    }
    for (const key of [...this.resolvedPermissionKeys]) {
      if (!currentKeys.has(key)) this.resolvedPermissionKeys.delete(key);
    }
    if (this.resolvedPermissionKeys.size === 0) return permissions;
    return permissions.filter((permission) => {
      const key = permissionKey(permission);
      return !key || !this.resolvedPermissionKeys.has(key);
    });
  }

  #logError(key, message) {
    if (this.lastErrorKey === key) return;
    this.lastErrorKey = key;
    this.log("warn", message);
  }
}

function createStdinJsonlHardwareBuddySource(options = {}) {
  return new StdinJsonlHardwareBuddySource(options);
}

module.exports = {
  StdinJsonlHardwareBuddySource,
  createStdinJsonlHardwareBuddySource,
  unwrapStateMessage,
};
