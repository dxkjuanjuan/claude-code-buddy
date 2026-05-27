"use strict";

const { createPermissionReplyRecord } = require("./jsonl-reply-sink");

function integerValue(value, fallback, { min = -Infinity, max = Infinity } = {}) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(n)));
}

class MemoryPermissionReplySink {
  constructor(options = {}) {
    this.maxRecords = integerValue(options.maxRecords ?? options.replyBufferSize, 100, { min: 1 });
    this.now = typeof options.now === "function" ? options.now : () => Date.now();
    this.log = typeof options.log === "function" ? options.log : () => {};
    this.records = [];
    this.nextSeq = integerValue(options.startSeq, 1, { min: 1 });
    this.listeners = new Set();
    this.waiters = new Set();
  }

  write(entry, behavior, meta = {}) {
    try {
      const record = {
        seq: this.nextSeq,
        ...createPermissionReplyRecord(entry, behavior, {
          meta,
          now: this.now,
        }),
      };
      this.nextSeq += 1;
      this.records.push(record);
      if (this.records.length > this.maxRecords) {
        this.records.splice(0, this.records.length - this.maxRecords);
      }
      this.#notify(record);
      return true;
    } catch (err) {
      const message = err && err.message ? err.message : String(err);
      this.log("error", `failed to store permission reply in memory: ${message}`, err);
      return false;
    }
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
  }

  #notify(record) {
    for (const listener of [...this.listeners]) {
      try {
        listener(record);
      } catch (err) {
        const message = err && err.message ? err.message : String(err);
        this.log("error", `permission reply listener failed: ${message}`, err);
      }
    }
    for (const waiter of [...this.waiters]) {
      if (record.seq > waiter.after) waiter.finish();
    }
  }
}

class CompositePermissionReplySink {
  constructor(sinks = []) {
    this.sinks = Array.isArray(sinks)
      ? sinks.filter((sink) => sink && typeof sink.write === "function")
      : [];
  }

  write(entry, behavior, meta = {}) {
    let delivered = false;
    for (const sink of this.sinks) {
      if (sink.write(entry, behavior, meta) === true) delivered = true;
    }
    return delivered;
  }

  list(options = {}) {
    const sink = this.sinks.find((candidate) => candidate && typeof candidate.list === "function");
    if (!sink) {
      const after = integerValue(options.after, 0, { min: 0 });
      return {
        cursor: after,
        nextCursor: after,
        latestSeq: 0,
        oldestSeq: 0,
        hasMore: false,
        items: [],
      };
    }
    return sink.list(options);
  }

  subscribe(listener) {
    const sink = this.sinks.find((candidate) => candidate && typeof candidate.subscribe === "function");
    if (!sink) return () => {};
    return sink.subscribe(listener);
  }

  wait(options = {}) {
    const sink = this.sinks.find((candidate) => candidate && typeof candidate.wait === "function");
    if (!sink) return Promise.resolve(this.list(options));
    return sink.wait(options);
  }

  status() {
    return {
      type: "composite",
      sinks: this.sinks.map((sink) => {
        if (sink && typeof sink.status === "function") return sink.status();
        return { type: sink && sink.constructor && sink.constructor.name ? sink.constructor.name : "unknown" };
      }),
    };
  }

  stop() {
    for (const sink of this.sinks) {
      if (sink && typeof sink.stop === "function") sink.stop();
    }
  }
}

function createMemoryPermissionReplySink(options = {}) {
  return new MemoryPermissionReplySink(options);
}

function createCompositePermissionReplySink(sinks = []) {
  return new CompositePermissionReplySink(sinks);
}

module.exports = {
  CompositePermissionReplySink,
  MemoryPermissionReplySink,
  createCompositePermissionReplySink,
  createMemoryPermissionReplySink,
};
