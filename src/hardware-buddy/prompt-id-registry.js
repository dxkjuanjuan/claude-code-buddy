"use strict";

class PromptIdRegistry {
  constructor(options = {}) {
    this.prefix = typeof options.prefix === "string" && options.prefix
      ? options.prefix
      : "hb";
    this.next = Number.isFinite(options.startAt) && options.startAt > 0
      ? Math.floor(options.startAt)
      : 1;
    this.entryToId = new WeakMap();
    this.idToEntry = new Map();
  }

  getPromptId(entry) {
    if (!entry || (typeof entry !== "object" && typeof entry !== "function")) return null;

    const existing = this.entryToId.get(entry);
    if (existing && this.idToEntry.get(existing) === entry) return existing;

    let id;
    do {
      id = `${this.prefix}_${this.next.toString(36)}`;
      this.next += 1;
    } while (this.idToEntry.has(id));

    this.entryToId.set(entry, id);
    this.idToEntry.set(id, entry);
    return id;
  }

  resolvePromptId(id) {
    return this.idToEntry.get(id) || null;
  }

  deleteEntry(entry) {
    if (!entry || (typeof entry !== "object" && typeof entry !== "function")) return false;
    const id = this.entryToId.get(entry);
    if (!id) return false;
    this.entryToId.delete(entry);
    return this.idToEntry.delete(id);
  }

  syncActiveEntries(entries) {
    const active = new Set(Array.isArray(entries) ? entries : []);
    let removed = 0;
    for (const [id, entry] of this.idToEntry) {
      if (active.has(entry)) continue;
      this.idToEntry.delete(id);
      this.entryToId.delete(entry);
      removed += 1;
    }
    return removed;
  }

  clear() {
    this.entryToId = new WeakMap();
    this.idToEntry.clear();
  }

  get size() {
    return this.idToEntry.size;
  }
}

module.exports = {
  PromptIdRegistry,
};
