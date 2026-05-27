"use strict";

const fs = require("node:fs");
const path = require("node:path");

function cleanString(value) {
  return typeof value === "string" ? value.trim() : "";
}

function plainObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : null;
}

function isoTime(value) {
  if (value instanceof Date && Number.isFinite(value.getTime())) {
    return value.toISOString();
  }
  const n = Number(value);
  const date = new Date(Number.isFinite(n) ? n : Date.now());
  return Number.isFinite(date.getTime()) ? date.toISOString() : new Date().toISOString();
}

function normalizeBehavior(behavior) {
  if (behavior === "allow" || behavior === "deny") return behavior;
  throw new Error("permission reply behavior must be allow or deny");
}

function createPermissionReplyRecord(entry, behavior, options = {}) {
  const object = plainObject(entry) || {};
  const meta = plainObject(options.meta) || {};
  const promptId = cleanString(meta.promptId || meta.id);
  const id = cleanString(object.id) || promptId;
  const normalizedBehavior = normalizeBehavior(behavior);
  const decision = cleanString(meta.decision) || (normalizedBehavior === "deny" ? "deny" : "once");

  return {
    type: "permission_reply",
    id,
    ...(promptId ? { promptId } : {}),
    behavior: normalizedBehavior,
    decision,
    sessionId: cleanString(object.sessionId),
    agentId: cleanString(object.agentId),
    toolName: cleanString(object.toolName),
    createdAt: Number.isFinite(Number(object.createdAt)) ? Number(object.createdAt) : undefined,
    time: isoTime(typeof options.now === "function" ? options.now() : options.now),
  };
}

class JsonlPermissionReplySink {
  constructor(options = {}) {
    this.file = cleanString(options.file || options.replyFile);
    this.fs = options.fs || fs;
    this.now = typeof options.now === "function" ? options.now : () => Date.now();
    this.log = typeof options.log === "function" ? options.log : () => {};
  }

  write(entry, behavior, meta = {}) {
    if (!this.file) {
      this.log("warn", "permission reply sink requires replyFile");
      return false;
    }

    try {
      const record = createPermissionReplyRecord(entry, behavior, {
        meta,
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
      this.log("error", `failed to write permission reply ${this.file}: ${message}`, err);
      return false;
    }
  }

  status() {
    return {
      type: "jsonl",
      file: this.file,
      configured: !!this.file,
    };
  }
}

function createJsonlPermissionReplySink(options = {}) {
  return new JsonlPermissionReplySink(options);
}

module.exports = {
  JsonlPermissionReplySink,
  createJsonlPermissionReplySink,
  createPermissionReplyRecord,
  normalizeBehavior,
};
