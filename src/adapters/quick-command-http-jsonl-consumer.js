"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { URL } = require("node:url");
const { mapQuickCommandToAdapterAction } = require("./quick-command-actions");

function cleanString(value) {
  return typeof value === "string" ? value.trim() : "";
}

function integerValue(value, fallback, { min = -Infinity, max = Infinity } = {}) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(n)));
}

function controlUrlFromConfig(config = {}) {
  const host = cleanString(config.controlHost) || "127.0.0.1";
  const port = integerValue(config.controlPort, 27217, { min: 0 });
  const printableHost = host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
  return `http://${printableHost}:${port}`;
}

function headersForToken(token) {
  const clean = cleanString(token);
  return clean ? { authorization: `Bearer ${clean}` } : {};
}

function quickCommandListUrl(baseUrl, options = {}) {
  const url = new URL("/quick-commands", baseUrl);
  url.searchParams.set("after", String(integerValue(options.after, 0, { min: 0 })));
  url.searchParams.set("limit", String(integerValue(options.limit, 100, { min: 1, max: 1000 })));
  const waitMs = integerValue(options.waitMs, 0, { min: 0, max: 60000 });
  if (waitMs > 0) url.searchParams.set("wait", String(waitMs));
  return url;
}

async function readQuickCommands(options = {}) {
  const fetchImpl = options.fetch || globalThis.fetch;
  if (typeof fetchImpl !== "function") {
    throw new Error("global fetch is not available; Node.js 18 or newer is required");
  }
  const baseUrl = cleanString(options.baseUrl || options.controlUrl);
  if (!baseUrl) throw new Error("control URL is required");

  const response = await fetchImpl(quickCommandListUrl(baseUrl, options), {
    method: "GET",
    headers: headersForToken(options.token),
  });
  let body = null;
  try {
    body = await response.json();
  } catch {
    body = null;
  }
  if (!response.ok) {
    const message = body && body.message ? body.message : `quick command request failed with HTTP ${response.status}`;
    const error = new Error(message);
    error.statusCode = response.status;
    error.body = body;
    throw error;
  }
  const quickCommands = body && body.quickCommands && typeof body.quickCommands === "object"
    ? body.quickCommands
    : null;
  if (!quickCommands || !Array.isArray(quickCommands.items)) {
    throw new Error("quick command response did not include quickCommands.items");
  }
  return quickCommands;
}

function appendJsonlRecords(file, records, options = {}) {
  const target = cleanString(file);
  if (!target || !Array.isArray(records) || records.length === 0) return 0;
  const fsImpl = options.fs || fs;
  const dir = path.dirname(target);
  if (dir && typeof fsImpl.mkdirSync === "function") {
    fsImpl.mkdirSync(dir, { recursive: true });
  }
  const data = records.map((record) => JSON.stringify(record)).join("\n") + "\n";
  fsImpl.appendFileSync(target, data, "utf8");
  return records.length;
}

async function consumeQuickCommandsOnce(options = {}) {
  const quickCommands = await readQuickCommands(options);
  const records = quickCommands.items.map((command) => mapQuickCommandToAdapterAction(command, {
    now: options.now,
  }));
  const written = appendJsonlRecords(options.actionFile, records, {
    fs: options.fs,
  });
  return {
    cursor: quickCommands.cursor,
    nextCursor: quickCommands.nextCursor,
    latestSeq: quickCommands.latestSeq,
    oldestSeq: quickCommands.oldestSeq,
    hasMore: quickCommands.hasMore,
    count: records.length,
    written,
    records,
  };
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function runQuickCommandJsonlConsumer(options = {}) {
  let after = integerValue(options.after, 0, { min: 0 });
  const limit = integerValue(options.limit, 100, { min: 1, max: 1000 });
  const waitMs = integerValue(options.waitMs, 30000, { min: 0, max: 60000 });
  const idleMs = integerValue(options.idleMs, waitMs > 0 ? 0 : 1000, { min: 0 });
  const maxEvents = integerValue(options.maxEvents, 0, { min: 0 });
  let total = 0;
  const batches = [];

  while (true) {
    const batch = await consumeQuickCommandsOnce({
      ...options,
      after,
      limit,
      waitMs,
    });
    batches.push(batch);
    after = Math.max(after, integerValue(batch.nextCursor, after, { min: 0 }));
    total += batch.count;

    if (options.once === true) break;
    if (maxEvents > 0 && total >= maxEvents) break;
    if (idleMs > 0 && batch.count === 0) await delay(idleMs);
  }

  return {
    after,
    total,
    batches,
  };
}

module.exports = {
  appendJsonlRecords,
  consumeQuickCommandsOnce,
  controlUrlFromConfig,
  quickCommandListUrl,
  readQuickCommands,
  runQuickCommandJsonlConsumer,
};
