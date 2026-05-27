"use strict";

const fs = require("node:fs");
const path = require("node:path");

function cleanString(value) {
  return typeof value === "string" ? value.trim() : "";
}

function isoTime(value) {
  if (value instanceof Date && Number.isFinite(value.getTime())) return value.toISOString();
  const n = Number(value);
  const date = new Date(Number.isFinite(n) ? n : Date.now());
  return Number.isFinite(date.getTime()) ? date.toISOString() : new Date().toISOString();
}

function createQuickCommandConsumedRecord(command, options = {}) {
  const object = command && typeof command === "object" && !Array.isArray(command) ? command : {};
  return {
    type: "quick_command_consumed",
    version: 1,
    seq: Number.isFinite(Number(object.seq)) ? Number(object.seq) : undefined,
    id: cleanString(object.id),
    label: cleanString(object.label),
    target: object.target && typeof object.target === "object" && !Array.isArray(object.target)
      ? { ...object.target }
      : null,
    duration: object.duration == null ? null : cleanString(object.duration),
    source: cleanString(object.source) || "unknown",
    clientRequestId: cleanString(object.clientRequestId),
    userText: object.userText == null ? null : cleanString(object.userText),
    createdAt: Number.isFinite(Number(object.createdAt)) ? Number(object.createdAt) : undefined,
    consumedAt: isoTime(typeof options.now === "function" ? options.now() : options.now),
  };
}

class JsonlQuickCommandConsumer {
  constructor(options = {}) {
    this.file = cleanString(options.file || options.quickCommandConsumerFile);
    this.fs = options.fs || fs;
    this.now = typeof options.now === "function" ? options.now : () => Date.now();
    this.log = typeof options.log === "function" ? options.log : () => {};
    this.unsubscribe = null;
    this.started = false;
  }

  start(sink) {
    if (this.started) return this;
    this.started = true;
    if (!sink || typeof sink.subscribe !== "function") {
      this.log("warn", "quick command JSONL consumer requires a quick command sink");
      return this;
    }
    this.unsubscribe = sink.subscribe((command) => {
      this.consume(command);
    });
    return this;
  }

  consume(command) {
    if (!this.file) {
      this.log("warn", "quick command JSONL consumer requires quickCommandConsumerFile");
      return false;
    }

    try {
      const record = createQuickCommandConsumedRecord(command, {
        now: this.now,
      });
      const dir = path.dirname(this.file);
      if (dir && typeof this.fs.mkdirSync === "function") {
        this.fs.mkdirSync(dir, { recursive: true });
      }
      this.fs.appendFileSync(this.file, `${JSON.stringify(record)}\n`, "utf8");
      return true;
    } catch (err) {
      const message = err && err.message ? err.message : String(err);
      this.log("error", `failed to consume quick command ${this.file}: ${message}`, err);
      return false;
    }
  }

  status() {
    return {
      type: "jsonl",
      file: this.file,
      started: this.started === true,
      configured: !!this.file,
    };
  }

  stop() {
    if (typeof this.unsubscribe === "function") this.unsubscribe();
    this.unsubscribe = null;
    this.started = false;
  }
}

function createJsonlQuickCommandConsumer(options = {}) {
  return new JsonlQuickCommandConsumer(options);
}

module.exports = {
  JsonlQuickCommandConsumer,
  createJsonlQuickCommandConsumer,
  createQuickCommandConsumedRecord,
};
