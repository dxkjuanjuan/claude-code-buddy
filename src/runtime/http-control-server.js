"use strict";

const http = require("node:http");
const { URL } = require("node:url");
const { normalizeJsonFileState } = require("./json-file-source");

function jsonResponse(res, statusCode, body) {
  const data = JSON.stringify(body);
  res.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(data),
    "cache-control": "no-store",
  });
  res.end(data);
}

function sseEvent(res, event, data, id) {
  if (!res || res.writableEnded || res.destroyed) return false;
  try {
    if (id != null) res.write(`id: ${id}\n`);
    if (event) res.write(`event: ${event}\n`);
    res.write(`data: ${JSON.stringify(data)}\n\n`);
    return true;
  } catch {
    return false;
  }
}

function destroyResponse(res, err) {
  if (!res) return;
  try {
    if (typeof res.destroy === "function") {
      res.destroy(err);
      return;
    }
  } catch {
    // Fall through to socket destroy.
  }
  const socket = res.socket;
  if (socket && !socket.destroyed && typeof socket.destroy === "function") {
    socket.destroy(err);
  }
}

function methodNotAllowed(res) {
  jsonResponse(res, 405, { ok: false, error: "method_not_allowed" });
}

function cleanString(value) {
  return typeof value === "string" ? value.trim() : "";
}

function serializeError(err) {
  if (!err) return null;
  return {
    message: err && err.message ? err.message : String(err),
    ...(typeof err.code === "string" && err.code ? { code: err.code } : {}),
  };
}

function disabledQuickCommandsError() {
  return Object.assign(new Error("quick commands are disabled"), {
    statusCode: 409,
    error: "quick_commands_disabled",
    code: "quick_commands_disabled",
  });
}

function integerQuery(value, fallback, { min = -Infinity, max = Infinity } = {}) {
  if (value == null || value === "") return fallback;
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(n)));
}

function abortSignalForResponse(res) {
  const controller = new AbortController();
  const abort = () => controller.abort();
  res.once("close", abort);
  return {
    signal: controller.signal,
    cleanup: () => res.off("close", abort),
  };
}

function readJsonBody(req, { maxBytes = 1024 * 1024 } = {}) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (chunk) => {
      size += Buffer.byteLength(chunk);
      if (size > maxBytes) {
        reject(Object.assign(new Error("request body too large"), { statusCode: 413 }));
        req.destroy();
        return;
      }
      chunks.push(Buffer.from(chunk));
    });
    req.on("error", reject);
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      if (!raw.trim()) {
        reject(Object.assign(new Error("request body must be JSON"), { statusCode: 400 }));
        return;
      }
      try {
        resolve(JSON.parse(raw));
      } catch (err) {
        reject(Object.assign(new Error(`invalid JSON: ${err.message}`), { statusCode: 400 }));
      }
    });
  });
}

function applyStateToSource(source, rawState, options = {}) {
  if (!source || typeof source !== "object") {
    throw Object.assign(new Error("runtime source is not mutable"), { statusCode: 409 });
  }
  const state = normalizeJsonFileState(rawState, { now: options.now });
  if (typeof source.setState === "function") {
    source.setState(state);
    return state;
  }
  if (typeof source.setSessions === "function") {
    source.setSessions(state.sessions);
  }
  if (typeof source.setPendingPermissions === "function") {
    source.setPendingPermissions(state.pendingPermissions);
  }
  if (typeof source.setDoNotDisturb === "function") {
    source.setDoNotDisturb(state.doNotDisturb);
  }
  if (
    typeof source.setSessions !== "function" &&
    typeof source.setPendingPermissions !== "function" &&
    typeof source.setDoNotDisturb !== "function"
  ) {
    throw Object.assign(new Error("runtime source is not mutable"), { statusCode: 409 });
  }
  return state;
}

class HttpControlServer {
  constructor(options = {}) {
    this.runtime = options.runtime || null;
    this.host = cleanString(options.host) || "127.0.0.1";
    this.port = Number.isFinite(Number(options.port)) ? Math.max(0, Math.floor(Number(options.port))) : 27217;
    this.token = cleanString(options.token);
    this.maxBodyBytes = Number.isFinite(Number(options.maxBodyBytes))
      ? Math.max(1, Math.floor(Number(options.maxBodyBytes)))
      : 1024 * 1024;
    this.now = typeof options.now === "function" ? options.now : () => Date.now();
    this.log = typeof options.log === "function" ? options.log : () => {};
    this.createServer = typeof options.createServer === "function" ? options.createServer : http.createServer;
    this.server = null;
    this.readyPromise = null;
    this.lastError = null;
    this.streamClients = new Set();
  }

  start() {
    if (this.server) return this;
    this.server = this.createServer((req, res) => {
      this.#handleRequest(req, res);
    });
    this.readyPromise = new Promise((resolve) => {
      this.server.once("listening", () => {
        const address = this.address();
        this.log("info", `control server listening on ${this.url()}`, address);
        resolve(this);
      });
      this.server.once("error", (err) => {
        this.lastError = err;
        this.log("error", `control server error: ${err && err.message ? err.message : String(err)}`, err);
        resolve(this);
      });
    });
    this.server.listen(this.port, this.host);
    return this;
  }

  ready() {
    return this.readyPromise || Promise.resolve(this);
  }

  stop() {
    const server = this.server;
    this.server = null;
    for (const client of [...this.streamClients]) {
      this.#closeStreamClient(client);
    }
    if (!server || typeof server.close !== "function") return Promise.resolve();
    return new Promise((resolve) => {
      try {
        server.close(() => resolve());
      } catch {
        resolve();
      }
    });
  }

  address() {
    if (!this.server || typeof this.server.address !== "function") return null;
    return this.server.address();
  }

  url() {
    const address = this.address();
    const port = address && typeof address === "object" ? address.port : this.port;
    const host = this.host.includes(":") ? `[${this.host}]` : this.host;
    return `http://${host}:${port}`;
  }

  status() {
    return {
      enabled: true,
      host: this.host,
      port: this.port,
      address: this.address(),
      authenticated: !!this.token,
      error: serializeError(this.lastError),
    };
  }

  #authorized(req) {
    if (!this.token) return true;
    const auth = cleanString(req.headers.authorization);
    const headerToken = cleanString(req.headers["x-claudebuddy-token"]);
    return auth === `Bearer ${this.token}` || headerToken === this.token;
  }

  async #handleRequest(req, res) {
    if (!this.#authorized(req)) {
      jsonResponse(res, 401, { ok: false, error: "unauthorized" });
      return;
    }

    const url = new URL(req.url || "/", "http://localhost");
    try {
      if (url.pathname === "/health") {
        if (req.method !== "GET") return methodNotAllowed(res);
        jsonResponse(res, 200, {
          ok: true,
          service: "claudebuddy",
          started: this.runtime && this.runtime.started === true,
        });
        return;
      }

      if (url.pathname === "/status") {
        if (req.method !== "GET") return methodNotAllowed(res);
        const status = this.runtime && typeof this.runtime.getStatus === "function"
          ? this.runtime.getStatus()
          : { ok: false };
        jsonResponse(res, 200, { ok: true, status });
        return;
      }

      if (url.pathname === "/replies") {
        if (req.method !== "GET") return methodNotAllowed(res);
        const after = integerQuery(url.searchParams.get("after"), 0, { min: 0 });
        const limit = integerQuery(url.searchParams.get("limit"), 100, { min: 1, max: 1000 });
        const waitMs = integerQuery(url.searchParams.get("wait"), 0, { min: 0, max: 60000 });
        let replies = this.runtime && typeof this.runtime.listPermissionReplies === "function"
          ? this.runtime.listPermissionReplies({ after, limit })
          : {
            cursor: after,
            nextCursor: after,
            latestSeq: 0,
            oldestSeq: 0,
            hasMore: false,
            items: [],
          };
        if (
          waitMs > 0 &&
          replies.items.length === 0 &&
          this.runtime &&
          typeof this.runtime.waitForPermissionReplies === "function"
        ) {
          const abort = abortSignalForResponse(res);
          try {
            replies = await this.runtime.waitForPermissionReplies({
              after,
              limit,
              timeoutMs: waitMs,
              signal: abort.signal,
            });
          } finally {
            abort.cleanup();
          }
          if (abort.signal.aborted && !res.writableEnded) return;
        }
        jsonResponse(res, 200, { ok: true, replies });
        return;
      }

      if (url.pathname === "/replies/stream") {
        if (req.method !== "GET") return methodNotAllowed(res);
        this.#handleReplyStream(req, res, url);
        return;
      }

      if (url.pathname === "/quick-commands/presets") {
        if (req.method !== "GET") return methodNotAllowed(res);
        const payload = this.runtime && typeof this.runtime.getQuickCommandPresets === "function"
          ? this.runtime.getQuickCommandPresets()
          : { enabled: false, presets: [] };
        jsonResponse(res, 200, { ok: true, ...payload });
        return;
      }

      if (url.pathname === "/quick-commands") {
        const enabled = this.runtime &&
          this.runtime.config &&
          this.runtime.config.quickCommands === true;
        if (!enabled) throw disabledQuickCommandsError();

        if (req.method === "POST") {
          const body = await readJsonBody(req, { maxBytes: this.maxBodyBytes });
          const result = this.runtime && typeof this.runtime.createQuickCommand === "function"
            ? this.runtime.createQuickCommand(body)
            : null;
          jsonResponse(res, 200, {
            ok: true,
            quickCommand: result && result.record ? result.record : null,
            duplicate: result && result.duplicate === true,
          });
          return;
        }

        if (req.method === "GET") {
          const after = integerQuery(url.searchParams.get("after"), 0, { min: 0 });
          const limit = integerQuery(url.searchParams.get("limit"), 100, { min: 1, max: 1000 });
          const waitMs = integerQuery(url.searchParams.get("wait"), 0, { min: 0, max: 60000 });
          let quickCommands = this.runtime && typeof this.runtime.listQuickCommands === "function"
            ? this.runtime.listQuickCommands({ after, limit })
            : {
              cursor: after,
              nextCursor: after,
              latestSeq: 0,
              oldestSeq: 0,
              hasMore: false,
              items: [],
            };
          if (
            waitMs > 0 &&
            quickCommands.items.length === 0 &&
            this.runtime &&
            typeof this.runtime.waitForQuickCommands === "function"
          ) {
            const abort = abortSignalForResponse(res);
            try {
              quickCommands = await this.runtime.waitForQuickCommands({
                after,
                limit,
                timeoutMs: waitMs,
                signal: abort.signal,
              });
            } finally {
              abort.cleanup();
            }
            if (abort.signal.aborted && !res.writableEnded) return;
          }
          jsonResponse(res, 200, { ok: true, quickCommands });
          return;
        }

        return methodNotAllowed(res);
      }

      if (url.pathname === "/task-state") {
        const enabled = this.runtime &&
          this.runtime.config &&
          this.runtime.config.quickCommands === true;
        if (!enabled) throw disabledQuickCommandsError();

        if (req.method === "POST") {
          const body = await readJsonBody(req, { maxBytes: this.maxBodyBytes });
          const taskState = this.runtime && typeof this.runtime.createTaskState === "function"
            ? this.runtime.createTaskState(body)
            : null;
          jsonResponse(res, 200, { ok: true, taskState });
          return;
        }

        if (req.method === "GET") {
          const maxAgeMs = integerQuery(url.searchParams.get("maxAgeMs"), 0, { min: 0, max: 24 * 60 * 60 * 1000 });
          const taskState = this.runtime && typeof this.runtime.getTaskState === "function"
            ? this.runtime.getTaskState({ maxAgeMs })
            : { latest: null };
          jsonResponse(res, 200, { ok: true, taskState });
          return;
        }

        return methodNotAllowed(res);
      }

      if (url.pathname === "/state") {
        if (req.method !== "POST") return methodNotAllowed(res);
        const body = await readJsonBody(req, { maxBytes: this.maxBodyBytes });
        const state = applyStateToSource(this.runtime && this.runtime.source, body, { now: this.now() });
        const snapshot = this.runtime && typeof this.runtime.emitSnapshot === "function"
          ? this.runtime.emitSnapshot("control-state")
          : null;
        jsonResponse(res, 200, { ok: true, state, snapshot });
        return;
      }

      if (url.pathname === "/snapshot") {
        if (req.method !== "POST") return methodNotAllowed(res);
        const snapshot = this.runtime && typeof this.runtime.emitSnapshot === "function"
          ? this.runtime.emitSnapshot("control-snapshot")
          : null;
        jsonResponse(res, 200, { ok: true, snapshot });
        return;
      }

      jsonResponse(res, 404, { ok: false, error: "not_found" });
      return;
    } catch (err) {
      const statusCode = Number.isInteger(err && err.statusCode) ? err.statusCode : 500;
      jsonResponse(res, statusCode, {
        ok: false,
        error: typeof err.error === "string" && err.error
          ? err.error
          : (statusCode >= 500 ? "internal_error" : "bad_request"),
        message: err && err.message ? err.message : String(err),
      });
    }
  }

  #handleReplyStream(req, res, url) {
    let client = null;
    try {
      const after = integerQuery(url.searchParams.get("after"), 0, { min: 0 });
      const limit = integerQuery(url.searchParams.get("limit"), 100, { min: 1, max: 1000 });
      const heartbeatMs = integerQuery(url.searchParams.get("heartbeat"), 15000, { min: 1000, max: 60000 });
      const replies = this.runtime && typeof this.runtime.listPermissionReplies === "function"
        ? this.runtime.listPermissionReplies({ after, limit })
        : {
          cursor: after,
          nextCursor: after,
          latestSeq: 0,
          oldestSeq: 0,
          hasMore: false,
          items: [],
        };
      let cursor = Math.max(after, replies.nextCursor || after);
      client = {
        res,
        heartbeatTimer: null,
        unsubscribe: null,
      };

      res.writeHead(200, {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-store, no-transform",
        connection: "keep-alive",
        "x-accel-buffering": "no",
      });
      if (typeof res.flushHeaders === "function") res.flushHeaders();

      this.streamClients.add(client);
      const close = () => this.#closeStreamClient(client);
      req.once("aborted", close);
      res.once("close", close);

      const ready = sseEvent(res, "ready", {
        ok: true,
        cursor: replies.cursor,
        nextCursor: replies.nextCursor,
        latestSeq: replies.latestSeq,
        oldestSeq: replies.oldestSeq,
        hasMore: replies.hasMore,
        count: replies.items.length,
      });
      if (!ready) {
        this.#closeStreamClient(client);
        return;
      }
      for (const item of replies.items) {
        if (!sseEvent(res, "permission_reply", item, item.seq)) {
          this.#closeStreamClient(client);
          return;
        }
      }

      client.unsubscribe = this.runtime && typeof this.runtime.subscribePermissionReplies === "function"
        ? this.runtime.subscribePermissionReplies((record) => {
          if (!record || record.seq <= cursor) return;
          cursor = record.seq;
          if (!sseEvent(res, "permission_reply", record, record.seq)) {
            this.#closeStreamClient(client);
          }
        })
        : null;
      client.heartbeatTimer = setInterval(() => {
        if (!sseEvent(res, "heartbeat", { ok: true, time: new Date(this.now()).toISOString(), cursor })) {
          this.#closeStreamClient(client);
        }
      }, heartbeatMs);
    } catch (err) {
      this.log("warn", `failed to open reply stream: ${err && err.message ? err.message : String(err)}`, err);
      if (client) this.#closeStreamClient(client);
      else destroyResponse(res, err);
    }
  }

  #closeStreamClient(client) {
    if (!client || !this.streamClients.has(client)) return;
    this.streamClients.delete(client);
    if (client.heartbeatTimer != null) clearInterval(client.heartbeatTimer);
    client.heartbeatTimer = null;
    if (typeof client.unsubscribe === "function") client.unsubscribe();
    client.unsubscribe = null;
    if (client.res && !client.res.writableEnded && !client.res.destroyed) {
      try {
        client.res.end();
      } catch {
        // The socket destroy below is the real shutdown guarantee.
      }
    }
    if (client.res && client.res.socket && !client.res.socket.destroyed) {
      client.res.socket.destroy();
    }
  }
}

function createHttpControlServer(options = {}) {
  return new HttpControlServer(options);
}

module.exports = {
  HttpControlServer,
  applyStateToSource,
  createHttpControlServer,
  readJsonBody,
};
