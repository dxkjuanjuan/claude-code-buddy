"use strict";

const fs = require("node:fs");
const { StaticHardwareBuddySource } = require("./static-source");

const DEFAULT_MAX_SOURCE_BYTES = 1024 * 1024;

function cleanString(value) {
  return typeof value === "string" ? value.trim() : "";
}

function boolValue(value, fallback = false) {
  if (typeof value === "boolean") return value;
  return fallback;
}

function numberValue(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function plainObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : null;
}

function cloneToolInput(value) {
  if (typeof value === "string") return value;
  if (plainObject(value)) return { ...value };
  return {};
}

function normalizeLastEvent(value) {
  if (typeof value === "string") return { rawEvent: cleanString(value) };
  const object = plainObject(value);
  if (!object) return undefined;
  return {
    ...(cleanString(object.rawEvent) ? { rawEvent: cleanString(object.rawEvent) } : {}),
    ...(cleanString(object.labelKey) ? { labelKey: cleanString(object.labelKey) } : {}),
  };
}

function normalizeSession(item, index, now) {
  const object = plainObject(item);
  if (!object) return null;
  const id = cleanString(object.id || object.sessionId) || `session_${index + 1}`;
  const displayTitle = cleanString(object.displayTitle || object.title || object.sessionTitle) || id;
  const lastEvent = normalizeLastEvent(object.lastEvent || object.event);
  return {
    id,
    state: cleanString(object.state) || "working",
    displayTitle,
    sessionTitle: cleanString(object.sessionTitle) || displayTitle,
    updatedAt: numberValue(object.updatedAt, now),
    agentId: cleanString(object.agentId) || "standalone",
    headless: boolValue(object.headless, false),
    hiddenFromHud: boolValue(object.hiddenFromHud, false),
    ...(lastEvent && (lastEvent.rawEvent || lastEvent.labelKey) ? { lastEvent } : {}),
  };
}

function normalizePermission(item, index, now) {
  const object = plainObject(item);
  if (!object) return null;
  const sessionId = cleanString(object.sessionId);
  const toolName = cleanString(object.toolName || object.tool);
  if (!sessionId || !toolName) return null;
  return {
    id: cleanString(object.id) || "",
    sessionId,
    agentId: cleanString(object.agentId) || "claude-code",
    toolName,
    toolInput: cloneToolInput(object.toolInput || object.input),
    createdAt: numberValue(object.createdAt, now + index),
    headless: boolValue(object.headless, false),
    isCodex: boolValue(object.isCodex, false),
    isPi: boolValue(object.isPi, false),
    isOpencode: boolValue(object.isOpencode, false),
    isElicitation: boolValue(object.isElicitation, false),
    isCodexNotify: boolValue(object.isCodexNotify, false),
    isKimiNotify: boolValue(object.isKimiNotify, false),
  };
}

function permissionKey(permission) {
  if (!permission) return "";
  if (permission.id) return `id:${permission.id}`;
  return [
    "shape",
    permission.sessionId,
    permission.agentId,
    permission.toolName,
    String(permission.createdAt),
  ].join(":");
}

function normalizeJsonFileState(rawState, options = {}) {
  const object = plainObject(rawState);
  if (!object) {
    throw new Error("JSON source must contain an object");
  }

  const now = Number.isFinite(options.now) ? options.now : Date.now();
  const sessionItems = Array.isArray(object.sessions)
    ? object.sessions
    : (plainObject(object.sessionSnapshot) && Array.isArray(object.sessionSnapshot.sessions)
      ? object.sessionSnapshot.sessions
      : []);
  const permissionItems = Array.isArray(object.permissions)
    ? object.permissions
    : (Array.isArray(object.pendingPermissions) ? object.pendingPermissions : []);

  return {
    sessions: sessionItems
      .map((item, index) => normalizeSession(item, index, now))
      .filter(Boolean),
    pendingPermissions: permissionItems
      .map((item, index) => normalizePermission(item, index, now))
      .filter(Boolean),
    doNotDisturb: object.doNotDisturb === true || object.dnd === true,
  };
}

class JsonFileHardwareBuddySource extends StaticHardwareBuddySource {
  constructor(options = {}) {
    super({
      title: options.title,
      state: options.state,
      doNotDisturb: options.doNotDisturb,
      now: options.now,
    });
    this.file = cleanString(options.file || options.sourceFile);
    const pollMs = options.pollMs != null ? options.pollMs : options.sourcePollMs;
    this.pollMs = Math.max(0, Math.floor(Number(pollMs != null ? pollMs : 1000)));
    this.fs = options.fs || fs;
    this.maxBytes = Math.max(1, Math.floor(Number(options.maxBytes || options.sourceMaxBytes || DEFAULT_MAX_SOURCE_BYTES)));
    this.setInterval = options.setInterval || setInterval;
    this.clearInterval = options.clearInterval || clearInterval;
    this.now = Number.isFinite(options.now)
      ? () => options.now
      : (typeof options.now === "function" ? options.now : () => Date.now());
    this.log = typeof options.log === "function" ? options.log : () => {};
    this.timer = null;
    this.lastSignature = "";
    this.lastErrorKey = "";
    this.permissionIdentities = new Map();
    this.resolvedPermissionKeys = new Set();
  }

  start() {
    this.reload({ emit: false });
    if (this.pollMs > 0 && typeof this.setInterval === "function") {
      this.timer = this.setInterval(() => {
        this.reload({ emit: true });
      }, this.pollMs);
    }
  }

  stop() {
    if (this.timer != null && typeof this.clearInterval === "function") {
      this.clearInterval(this.timer);
    }
    this.timer = null;
  }

  reload({ emit = true } = {}) {
    if (!this.file) {
      this.#logError("missing", "json-file source requires sourceFile");
      return false;
    }

    let raw;
    try {
      const stat = typeof this.fs.statSync === "function" ? this.fs.statSync(this.file) : null;
      if (stat && Number.isFinite(stat.size) && stat.size > this.maxBytes) {
        this.#logError("too-large", `json-file source ${this.file} is too large: ${stat.size} bytes exceeds ${this.maxBytes}`);
        return false;
      }
      raw = this.fs.readFileSync(this.file, "utf8");
    } catch (err) {
      const message = err && err.message ? err.message : String(err);
      this.#logError(message, `failed to read json-file source ${this.file}: ${message}`);
      return false;
    }

    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      const message = err && err.message ? err.message : String(err);
      this.#logError(message, `invalid json-file source ${this.file}: ${message}`);
      return false;
    }

    let state;
    try {
      state = normalizeJsonFileState(parsed, { now: this.now() });
    } catch (err) {
      const message = err && err.message ? err.message : String(err);
      this.#logError(message, `invalid json-file source ${this.file}: ${message}`);
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

  resolvePermissionEntry(entry) {
    const key = permissionKey(entry);
    if (key) this.resolvedPermissionKeys.add(key);
    const before = this.pendingPermissions.length;
    this.pendingPermissions = this.pendingPermissions.filter((candidate) => candidate !== entry);
    if (key) this.permissionIdentities.delete(key);
    return this.pendingPermissions.length !== before;
  }

  #logError(key, message) {
    if (this.lastErrorKey === key) return;
    this.lastErrorKey = key;
    this.log("warn", message);
  }
}

function createJsonFileHardwareBuddySource(options = {}) {
  return new JsonFileHardwareBuddySource(options);
}

module.exports = {
  DEFAULT_MAX_SOURCE_BYTES,
  JsonFileHardwareBuddySource,
  createJsonFileHardwareBuddySource,
  normalizeJsonFileState,
  permissionKey,
};
