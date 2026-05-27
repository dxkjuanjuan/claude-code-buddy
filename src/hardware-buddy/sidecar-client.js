"use strict";

const { spawn: defaultSpawn } = require("child_process");
const {
  JsonLineParser,
  encodeSidecarMessage,
} = require("./sidecar-protocol");

function callback(fn, ...args) {
  if (typeof fn !== "function") return;
  fn(...args);
}

function textFromChunk(chunk) {
  return Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk || "");
}

class SidecarClient {
  constructor(options = {}) {
    this.spawn = typeof options.spawn === "function" ? options.spawn : defaultSpawn;
    this.command = typeof options.command === "string" && options.command
      ? options.command
      : "python";
    this.args = Array.isArray(options.args) ? options.args.slice() : [];
    this.spawnOptions = options.spawnOptions && typeof options.spawnOptions === "object"
      ? { ...options.spawnOptions }
      : {};
    this.parserOptions = options.parserOptions && typeof options.parserOptions === "object"
      ? { ...options.parserOptions }
      : {};
    this.parser = this.#createParser();
    this.log = typeof options.log === "function" ? options.log : () => {};
    this.onStatus = options.onStatus;
    this.onDevices = options.onDevices;
    this.onError = options.onError;
    this.onLog = options.onLog;
    this.onExit = options.onExit;
    this.onTransportStateChanged = options.onTransportStateChanged;

    this.commandListeners = new Set();
    if (typeof options.onCommand === "function") {
      this.commandListeners.add(options.onCommand);
    }

    this.child = null;
    this.started = false;
    this.stopping = false;
    this.lastStatus = null;
    this.lastDevices = [];
    this.lastError = null;

    this.transport = {
      connected: false,
      secure: false,
      send: (snapshot, meta) => this.sendSnapshot(snapshot, meta),
      onCommand: (listener) => this.onCommand(listener),
      isSecure: () => this.isSecure(),
    };
  }

  start() {
    if (this.child) return this.child;
    this.stopping = false;
    this.parser = this.#createParser();
    this.#setTransportState({ connected: false, secure: false }, { force: false });

    const child = this.spawn(this.command, this.args, {
      stdio: ["pipe", "pipe", "pipe"],
      ...this.spawnOptions,
    });
    this.child = child;
    this.started = true;

    if (child && child.stdout && typeof child.stdout.on === "function") {
      child.stdout.on("data", (chunk) => this.#handleStdoutChunk(chunk));
      child.stdout.on("end", () => this.#flushParser());
    }

    if (child && child.stderr && typeof child.stderr.on === "function") {
      child.stderr.on("data", (chunk) => {
        const message = textFromChunk(chunk).trim();
        if (message) this.log("warn", `sidecar stderr: ${message}`);
      });
    }

    if (child && typeof child.on === "function") {
      child.on("error", (err) => this.#handleChildError(err));
      child.on("exit", (code, signal) => this.#handleChildExit({ code, signal }));
    }

    return child;
  }

  stop() {
    this.stopping = true;
    const child = this.child;
    this.child = null;
    this.started = false;
    this.#flushParser();
    this.#setTransportState({ connected: false, secure: false }, { force: false });

    if (child && typeof child.kill === "function") {
      try {
        child.kill();
      } catch (err) {
        this.#emitError(err);
      }
    }
  }

  onCommand(listener) {
    if (typeof listener !== "function") return () => {};
    this.commandListeners.add(listener);
    return () => {
      this.commandListeners.delete(listener);
    };
  }

  isSecure() {
    return this.transport.secure === true;
  }

  sendSnapshot(snapshot, meta = {}) {
    return this.#writeMessage({ type: "snapshot", data: snapshot }, meta);
  }

  scan() {
    return this.#sendControl("scan");
  }

  connect(data = {}) {
    if (typeof data === "string") return this.#sendControl("connect", { address: data });
    return this.#sendControl("connect", data);
  }

  disconnect() {
    return this.#sendControl("disconnect");
  }

  pollStatus() {
    return this.#sendControl("status");
  }

  unpair() {
    return this.#sendControl("unpair");
  }

  setName(name) {
    return this.#sendControl("set_name", { name });
  }

  setOwner(name) {
    return this.#sendControl("set_owner", { name });
  }

  setTime(epoch, offset) {
    return this.#sendControl("set_time", { epoch, offset });
  }

  simulatePermission(id, decision) {
    return this.#sendControl("simulate_permission", { id, decision });
  }

  #sendControl(action, data) {
    const message = data === undefined ? { type: "control", action } : { type: "control", action, data };
    return this.#writeMessage(message);
  }

  #writeMessage(message, meta = {}) {
    if (!this.child || !this.child.stdin || this.child.stdin.destroyed) {
      this.log("warn", "sidecar write skipped: process is not running", meta);
      return false;
    }
    let line;
    try {
      line = encodeSidecarMessage(message);
    } catch (err) {
      this.#emitError(err);
      return false;
    }
    try {
      this.child.stdin.write(line);
      return true;
    } catch (err) {
      this.#emitError(err);
      return false;
    }
  }

  #createParser() {
    return new JsonLineParser(this.parserOptions);
  }

  #handleStdoutChunk(chunk) {
    const result = this.parser.push(chunk);
    for (const err of result.errors) this.#emitError(err);
    for (const message of result.messages) this.#dispatchMessage(message);
  }

  #flushParser() {
    const result = this.parser.flush();
    for (const err of result.errors) this.#emitError(err);
    for (const message of result.messages) this.#dispatchMessage(message);
  }

  #dispatchMessage(message) {
    if (!message || typeof message.type !== "string") return;

    if (message.type === "command") {
      for (const listener of [...this.commandListeners]) {
        listener(message.data);
      }
      return;
    }

    if (message.type === "status") {
      this.lastStatus = message;
      this.#setTransportState({
        connected: message.connected === true,
        secure: message.secure === true,
      });
      callback(this.onStatus, message);
      return;
    }

    if (message.type === "devices") {
      this.lastDevices = message.items.slice();
      callback(this.onDevices, this.lastDevices, message);
      return;
    }

    if (message.type === "error") {
      this.lastError = message;
      callback(this.onError, message);
      this.log("error", message.message, message);
      return;
    }

    if (message.type === "log") {
      callback(this.onLog, message);
      this.log(message.level || "info", message.message, message);
    }
  }

  #setTransportState(next, options = {}) {
    const prev = {
      connected: this.transport.connected === true,
      secure: this.transport.secure === true,
    };
    this.transport.connected = next.connected === true;
    this.transport.secure = next.secure === true;

    const changed = prev.connected !== this.transport.connected || prev.secure !== this.transport.secure;
    if (changed || options.force === true) {
      callback(this.onTransportStateChanged, {
        connected: this.transport.connected,
        secure: this.transport.secure,
        previous: prev,
      });
    }
  }

  #handleChildError(err) {
    this.#emitError(err);
    callback(this.onExit, { error: err, stopping: this.stopping });
    this.#markExited();
  }

  #handleChildExit(info) {
    if (!this.stopping && info && (info.code || info.signal)) {
      this.log("warn", `sidecar exited: code=${info.code ?? ""} signal=${info.signal ?? ""}`);
    }
    callback(this.onExit, {
      ...(info || {}),
      stopping: this.stopping,
    });
    this.#markExited();
  }

  #markExited() {
    this.child = null;
    this.started = false;
    this.#flushParser();
    this.#setTransportState({ connected: false, secure: false });
  }

  #emitError(err) {
    this.lastError = err;
    callback(this.onError, err);
    const message = err && err.message ? err.message : String(err);
    this.log("error", message, err);
  }
}

module.exports = {
  SidecarClient,
};
