"use strict";

function cleanString(value) {
  return typeof value === "string" ? value.trim() : "";
}

function finiteTime(value, fallback) {
  if (value == null || value === "") return fallback;
  const n = Number(value);
  return Number.isFinite(n) ? Math.max(0, Math.floor(n)) : fallback;
}

function boundedString(value, maxLength) {
  const clean = cleanString(value).replace(/[\u0000-\u001f\u007f]/g, " ");
  if (!clean) return "";
  return clean.length > maxLength ? clean.slice(0, maxLength) : clean;
}

function badRequest(error, message) {
  return Object.assign(new Error(message), {
    statusCode: 400,
    error,
    code: error,
  });
}

function normalizeTaskStateInput(input = {}, options = {}) {
  const now = finiteTime(typeof options.now === "function" ? options.now() : options.now, Date.now());
  const object = input && typeof input === "object" && !Array.isArray(input) ? input : {};
  const sessionId = boundedString(object.sessionId, 200);
  if (!sessionId) {
    throw badRequest("missing_task_session_id", "task_state sessionId is required");
  }

  const state = cleanString(object.state);
  if (state !== "finished") {
    throw badRequest("invalid_task_state", "task_state state must be finished");
  }

  return {
    type: "task_state",
    version: 1,
    sessionId,
    state,
    title: boundedString(object.title, 200) || null,
    source: boundedString(object.source, 80) || "unknown",
    createdAt: finiteTime(object.createdAt, now),
  };
}

class MemoryTaskStateStore {
  constructor(options = {}) {
    this.maxRecords = Number.isFinite(Number(options.maxRecords))
      ? Math.max(1, Math.floor(Number(options.maxRecords)))
      : 20;
    this.now = typeof options.now === "function" ? options.now : () => Date.now();
    this.records = [];
    this.nextSeq = 1;
  }

  write(input = {}) {
    const record = {
      seq: this.nextSeq,
      ...normalizeTaskStateInput(input, { now: this.now }),
    };
    this.nextSeq += 1;
    this.records.push(record);
    if (this.records.length > this.maxRecords) {
      this.records.splice(0, this.records.length - this.maxRecords);
    }
    return { ...record };
  }

  latest(options = {}) {
    const record = this.records.length ? this.records[this.records.length - 1] : null;
    if (!record) return null;
    const maxAgeMs = Number.isFinite(Number(options.maxAgeMs))
      ? Math.max(0, Math.floor(Number(options.maxAgeMs)))
      : 0;
    if (maxAgeMs > 0) {
      const now = finiteTime(typeof options.now === "function" ? options.now() : options.now, this.now());
      if (now - record.createdAt > maxAgeMs) return null;
    }
    return { ...record };
  }

  status() {
    return {
      type: "memory",
      count: this.records.length,
      latestSeq: this.records.length ? this.records[this.records.length - 1].seq : 0,
    };
  }

  stop() {
    this.records = [];
  }
}

function createMemoryTaskStateStore(options = {}) {
  return new MemoryTaskStateStore(options);
}

module.exports = {
  MemoryTaskStateStore,
  createMemoryTaskStateStore,
  normalizeTaskStateInput,
};
