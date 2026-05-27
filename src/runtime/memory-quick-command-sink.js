"use strict";

const {
  QUICK_COMMAND_PRESETS,
  normalizeQuickCommandInput,
} = require("./quick-command-presets");

function integerValue(value, fallback, { min = -Infinity, max = Infinity } = {}) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(n)));
}

class MemoryQuickCommandSink {
  constructor(options = {}) {
    this.maxRecords = integerValue(options.maxRecords ?? options.quickCommandBufferSize, 100, { min: 1 });
    this.dedupeMs = integerValue(options.dedupeMs ?? options.quickCommandDedupeMs, 30000, { min: 0 });
    this.now = typeof options.now === "function" ? options.now : () => Date.now();
    this.log = typeof options.log === "function" ? options.log : () => {};
    this.records = [];
    this.nextSeq = integerValue(options.startSeq, 1, { min: 1 });
    this.dedupe = new Map();
    this.listeners = new Set();
    this.waiters = new Set();
  }

  presets() {
    return QUICK_COMMAND_PRESETS.map((preset) => ({ ...preset }));
  }

  write(input = {}) {
    const now = this.now();
    this.#pruneDedupe(now);
    const normalized = normalizeQuickCommandInput(input);
    const deduped = this.dedupeMs > 0 ? this.dedupe.get(normalized.clientRequestId) : null;
    if (deduped && deduped.expiresAt > now) {
      return {
        record: deduped.record,
        duplicate: true,
      };
    }

    const record = {
      seq: this.nextSeq,
      ...normalized,
      createdAt: now,
    };
    this.nextSeq += 1;
    this.records.push(record);
    if (this.records.length > this.maxRecords) {
      this.records.splice(0, this.records.length - this.maxRecords);
    }
    if (this.dedupeMs > 0) {
      this.dedupe.set(record.clientRequestId, {
        record,
        expiresAt: now + this.dedupeMs,
      });
    }
    this.#notify(record);
    return {
      record,
      duplicate: false,
    };
  }

  list(options = {}) {
    const after = integerValue(options.after, 0, { min: 0 });
    const limit = integerValue(options.limit, this.maxRecords, { min: 1, max: this.maxRecords });
    const available = this.records.filter((record) => record.seq > after);
    const items = available.slice(0, limit);
    const nextCursor = items.length ? items[items.length - 1].seq : after;
    const latestSeq = this.records.length ? this.records[this.records.length - 1].seq : 0;
    const oldestSeq = this.records.length ? this.records[0].seq : 0;

    return {
      cursor: after,
      nextCursor,
      latestSeq,
      oldestSeq,
      hasMore: available.length > items.length,
      items,
    };
  }

  subscribe(listener) {
    if (typeof listener !== "function") return () => {};
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  wait(options = {}) {
    const after = integerValue(options.after, 0, { min: 0 });
    const limit = integerValue(options.limit, this.maxRecords, { min: 1, max: this.maxRecords });
    const timeoutMs = integerValue(options.timeoutMs, 0, { min: 0 });
    const current = this.list({ after, limit });
    if (current.items.length || timeoutMs <= 0) return Promise.resolve(current);

    return new Promise((resolve) => {
      let timer = null;
      let settled = false;
      const signal = options.signal;
      const finish = () => {
        if (settled) return;
        settled = true;
        if (timer != null) clearTimeout(timer);
        this.waiters.delete(waiter);
        if (signal && typeof signal.removeEventListener === "function") {
          signal.removeEventListener("abort", finish);
        }
        resolve(this.list({ after, limit }));
      };
      const waiter = { after, finish };

      if (signal && signal.aborted === true) {
        finish();
        return;
      }

      this.waiters.add(waiter);
      timer = setTimeout(finish, timeoutMs);
      if (signal && typeof signal.addEventListener === "function") {
        signal.addEventListener("abort", finish, { once: true });
      }
    });
  }

  status() {
    return {
      type: "memory",
      size: this.records.length,
      maxRecords: this.maxRecords,
      dedupeMs: this.dedupeMs,
      dedupeSize: this.dedupe.size,
      nextSeq: this.nextSeq,
      oldestSeq: this.records.length ? this.records[0].seq : 0,
      latestSeq: this.records.length ? this.records[this.records.length - 1].seq : 0,
    };
  }

  stop() {
    for (const waiter of [...this.waiters]) {
      waiter.finish();
    }
    this.listeners.clear();
    this.dedupe.clear();
  }

  #notify(record) {
    for (const listener of [...this.listeners]) {
      try {
        listener(record);
      } catch (err) {
        const message = err && err.message ? err.message : String(err);
        this.log("error", `quick command listener failed: ${message}`, err);
      }
    }
    for (const waiter of [...this.waiters]) {
      if (record.seq > waiter.after) waiter.finish();
    }
  }

  #pruneDedupe(now) {
    if (this.dedupe.size === 0) return;
    for (const [clientRequestId, entry] of this.dedupe.entries()) {
      if (!entry || entry.expiresAt <= now) {
        this.dedupe.delete(clientRequestId);
      }
    }
  }
}

function createMemoryQuickCommandSink(options = {}) {
  return new MemoryQuickCommandSink(options);
}

module.exports = {
  MemoryQuickCommandSink,
  createMemoryQuickCommandSink,
};
