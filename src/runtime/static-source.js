"use strict";

function cloneArray(value) {
  return Array.isArray(value) ? value.slice() : [];
}

class StaticHardwareBuddySource {
  constructor(options = {}) {
    this.sessions = cloneArray(options.sessions);
    this.pendingPermissions = cloneArray(options.pendingPermissions);
    this.doNotDisturb = options.doNotDisturb === true;
    this.listeners = new Set();

    if (!this.sessions.length) {
      const now = Number.isFinite(options.now) ? options.now : Date.now();
      this.sessions = [{
        id: options.sessionId || "standalone",
        state: options.state || "working",
        displayTitle: options.title || "ClaudeBuddy Standalone",
        updatedAt: now,
        agentId: "claudebuddy",
        headless: false,
        hiddenFromHud: false,
      }];
    }
  }

  getSessionSnapshot() {
    return { sessions: this.sessions.slice() };
  }

  getPendingPermissions() {
    return this.pendingPermissions.slice();
  }

  getDoNotDisturb() {
    return this.doNotDisturb === true;
  }

  setSessions(sessions) {
    this.sessions = cloneArray(sessions);
    this.emitChange("state-change");
  }

  setPendingPermissions(pendingPermissions) {
    this.pendingPermissions = cloneArray(pendingPermissions);
    this.emitChange("permission-change");
  }

  setState(state = {}) {
    if (Array.isArray(state.sessions)) {
      this.sessions = cloneArray(state.sessions);
    }
    if (Array.isArray(state.pendingPermissions)) {
      this.pendingPermissions = cloneArray(state.pendingPermissions);
    }
    if (Object.prototype.hasOwnProperty.call(state, "doNotDisturb")) {
      this.doNotDisturb = state.doNotDisturb === true;
    }
    this.emitChange("state-change");
  }

  resolvePermissionEntry(entry) {
    const before = this.pendingPermissions.length;
    this.pendingPermissions = this.pendingPermissions.filter((candidate) => candidate !== entry);
    return this.pendingPermissions.length !== before;
  }

  setDoNotDisturb(value) {
    this.doNotDisturb = value === true;
    this.emitChange("permission-change");
  }

  onChange(listener) {
    if (typeof listener !== "function") return () => {};
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  emitChange(reason) {
    for (const listener of [...this.listeners]) {
      listener(reason);
    }
  }
}

function createStaticHardwareBuddySource(options = {}) {
  return new StaticHardwareBuddySource(options);
}

module.exports = {
  StaticHardwareBuddySource,
  createStaticHardwareBuddySource,
};
