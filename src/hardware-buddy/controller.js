"use strict";

const {
  buildHardwareBuddyHeartbeat,
  collectHardwarePromptEntries,
} = require("./snapshot");
const { PromptIdRegistry } = require("./prompt-id-registry");

function boolFromGetter(getter, fallback = false) {
  if (typeof getter !== "function") return fallback;
  return getter() === true;
}

function valueFromGetter(getter, fallback) {
  if (typeof getter !== "function") return fallback;
  const value = getter();
  return value == null ? fallback : value;
}

function normalizeDeviceCommand(raw) {
  if (!raw) return null;
  if (typeof raw === "string") {
    try {
      return JSON.parse(raw);
    } catch {
      return null;
    }
  }
  if (typeof raw === "object" && !Array.isArray(raw)) return raw;
  return null;
}

class HardwareBuddyController {
  constructor(options = {}) {
    this.transport = options.transport || null;
    this.getSessionSnapshot = typeof options.getSessionSnapshot === "function"
      ? options.getSessionSnapshot
      : () => ({ sessions: [] });
    this.getPendingPermissions = typeof options.getPendingPermissions === "function"
      ? options.getPendingPermissions
      : () => [];
    this.getDoNotDisturb = typeof options.getDoNotDisturb === "function"
      ? options.getDoNotDisturb
      : () => options.doNotDisturb === true;
    this.isAgentEnabled = options.isAgentEnabled;
    this.isAgentPermissionsEnabled = options.isAgentPermissionsEnabled;
    this.resolvePermissionEntry = typeof options.resolvePermissionEntry === "function"
      ? options.resolvePermissionEntry
      : null;
    this.getTokens = options.getTokens;
    this.getTokensToday = options.getTokensToday;
    this.entriesCap = options.entriesCap;
    this.entriesMaxBytes = options.entriesMaxBytes;
    this.statePriority = options.statePriority;
    this.keepaliveMs = Number.isFinite(options.keepaliveMs)
      ? Math.max(0, Math.floor(options.keepaliveMs))
      : 10000;
    this.promptIds = options.promptIdRegistry || new PromptIdRegistry();
    this.setInterval = options.setInterval || setInterval;
    this.clearInterval = options.clearInterval || clearInterval;
    this.onSnapshot = typeof options.onSnapshot === "function" ? options.onSnapshot : null;
    this.log = typeof options.log === "function" ? options.log : () => {};

    this.started = false;
    this.keepaliveTimer = null;
    this.unsubscribeCommand = null;
    this.lastSnapshot = null;
    this.lastDeviceStatus = null;
  }

  start() {
    if (this.started) return this.emitSnapshot("start");
    this.started = true;

    if (this.transport && typeof this.transport.onCommand === "function") {
      this.unsubscribeCommand = this.transport.onCommand((command) => {
        this.handleCommand(command);
      });
    }

    if (this.keepaliveMs > 0 && typeof this.setInterval === "function") {
      this.keepaliveTimer = this.setInterval(() => {
        this.emitSnapshot("keepalive");
      }, this.keepaliveMs);
    }

    return this.emitSnapshot("start");
  }

  stop() {
    if (this.keepaliveTimer != null && typeof this.clearInterval === "function") {
      this.clearInterval(this.keepaliveTimer);
    }
    this.keepaliveTimer = null;

    if (typeof this.unsubscribeCommand === "function") {
      this.unsubscribeCommand();
    }
    this.unsubscribeCommand = null;
    this.started = false;
    this.promptIds.clear();
  }

  notifyStateChanged() {
    return this.emitSnapshot("state-change");
  }

  notifyPermissionsChanged() {
    return this.emitSnapshot("permission-change");
  }

  isTransportSecure() {
    if (this.transport && typeof this.transport.isSecure === "function") {
      return this.transport.isSecure() === true;
    }
    if (this.transport && Object.prototype.hasOwnProperty.call(this.transport, "secure")) {
      return this.transport.secure === true;
    }
    return false;
  }

  readInputs() {
    return {
      sessionSnapshot: valueFromGetter(this.getSessionSnapshot, { sessions: [] }),
      pendingPermissions: valueFromGetter(this.getPendingPermissions, []),
      doNotDisturb: boolFromGetter(this.getDoNotDisturb, false),
      transportSecure: this.isTransportSecure(),
    };
  }

  syncPromptIds(inputs = this.readInputs()) {
    const activeEntries = collectHardwarePromptEntries({
      sessionSnapshot: inputs.sessionSnapshot,
      pendingPermissions: inputs.pendingPermissions,
      doNotDisturb: inputs.doNotDisturb,
      transportSecure: inputs.transportSecure,
      isAgentEnabled: this.isAgentEnabled,
      isAgentPermissionsEnabled: this.isAgentPermissionsEnabled,
    });
    this.promptIds.syncActiveEntries(activeEntries);
    return activeEntries;
  }

  buildSnapshot() {
    const inputs = this.readInputs();
    this.syncPromptIds(inputs);
    return buildHardwareBuddyHeartbeat({
      ...inputs,
      isAgentEnabled: this.isAgentEnabled,
      isAgentPermissionsEnabled: this.isAgentPermissionsEnabled,
      getPromptId: (entry) => this.promptIds.getPromptId(entry),
      tokens: valueFromGetter(this.getTokens, 0),
      tokensToday: valueFromGetter(this.getTokensToday, 0),
      entriesCap: this.entriesCap,
      entriesMaxBytes: this.entriesMaxBytes,
      statePriority: this.statePriority,
    });
  }

  emitSnapshot(reason = "manual") {
    const snapshot = this.buildSnapshot();
    this.lastSnapshot = snapshot;
    if (this.transport && typeof this.transport.send === "function") {
      this.transport.send(snapshot, { reason });
    }
    if (this.onSnapshot) this.onSnapshot(snapshot, { reason });
    return snapshot;
  }

  handleCommand(rawCommand) {
    const command = normalizeDeviceCommand(rawCommand);
    if (!command || (typeof command.cmd !== "string" && typeof command.ack !== "string")) {
      this.log("ignored invalid hardware command");
      return false;
    }

    if (command.cmd === "status" || command.ack === "status") {
      this.lastDeviceStatus = command;
      return true;
    }

    if (command.cmd !== "permission") {
      this.log(`ignored unsupported hardware command: ${command.cmd}`);
      return false;
    }

    return this.handlePermissionCommand(command);
  }

  handlePermissionCommand(command) {
    if (!this.isTransportSecure()) {
      this.log("ignored hardware permission reply on insecure transport");
      return false;
    }

    const id = typeof command.id === "string" ? command.id : "";
    const decision = command.decision;
    const behavior = decision === "once" ? "allow" : (decision === "deny" ? "deny" : null);
    if (!id || !behavior) {
      this.log("ignored invalid hardware permission reply");
      return false;
    }

    this.syncPromptIds();
    const entry = this.promptIds.resolvePromptId(id);
    if (!entry) {
      this.log(`ignored stale hardware permission reply: ${id}`);
      return false;
    }

    this.promptIds.deleteEntry(entry);
    if (this.resolvePermissionEntry) {
      this.resolvePermissionEntry(entry, behavior, {
        decision,
        promptId: id,
      });
    }
    this.emitSnapshot("permission-reply");
    return true;
  }
}

module.exports = {
  HardwareBuddyController,
  normalizeDeviceCommand,
};
