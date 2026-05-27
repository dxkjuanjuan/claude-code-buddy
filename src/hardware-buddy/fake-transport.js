"use strict";

class FakeHardwareBuddyTransport {
  constructor(options = {}) {
    this.secure = options.secure !== false;
    this.connected = options.connected !== false;
    this.outbound = [];
    this.commands = [];
    this.commandListeners = new Set();
  }

  send(snapshot, meta = {}) {
    const record = { snapshot, meta };
    this.outbound.push(record);
    return record;
  }

  onCommand(listener) {
    if (typeof listener !== "function") return () => {};
    this.commandListeners.add(listener);
    return () => {
      this.commandListeners.delete(listener);
    };
  }

  injectCommand(command) {
    this.commands.push(command);
    for (const listener of [...this.commandListeners]) {
      listener(command);
    }
  }

  setSecure(value) {
    this.secure = value === true;
  }

  isSecure() {
    return this.secure === true;
  }

  clear() {
    this.outbound.length = 0;
    this.commands.length = 0;
  }

  lastOutbound() {
    return this.outbound.length ? this.outbound[this.outbound.length - 1] : null;
  }
}

module.exports = {
  FakeHardwareBuddyTransport,
};
