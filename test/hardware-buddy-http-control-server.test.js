"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert");
const http = require("node:http");

const {
  HeadlessHardwareBuddyRuntime,
} = require("../src/runtime/headless-runtime");

function controlUrl(runtime, path) {
  const address = runtime.controlServer.address();
  return `http://127.0.0.1:${address.port}${path}`;
}

async function readJson(response) {
  return JSON.parse(await response.text());
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(predicate, { timeoutMs = 1000, intervalMs = 10 } = {}) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (predicate()) return true;
    await delay(intervalMs);
  }
  return predicate();
}

function parseSseEvent(raw) {
  const event = { event: "message", id: "", data: "" };
  for (const line of raw.split(/\r?\n/)) {
    if (line.startsWith("event:")) event.event = line.slice(6).trim();
    else if (line.startsWith("id:")) event.id = line.slice(3).trim();
    else if (line.startsWith("data:")) event.data += line.slice(5).trimStart();
  }
  return {
    event: event.event,
    id: event.id,
    data: event.data ? JSON.parse(event.data) : null,
  };
}

function createSseReader(response) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  return {
    async nextEvent() {
      while (!buffer.includes("\n\n")) {
        const { done, value } = await reader.read();
        if (done) return null;
        buffer += decoder.decode(value, { stream: true });
      }
      const idx = buffer.indexOf("\n\n");
      const raw = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);
      return parseSseEvent(raw);
    },
    cancel() {
      return reader.cancel();
    },
  };
}

function openRawSse(url) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const req = http.get(url, (res) => {
      res.setEncoding("utf8");
      let buffer = "";
      res.on("data", (chunk) => {
        buffer += chunk;
        if (!settled && buffer.includes("\n\n")) {
          settled = true;
          resolve({
            req,
            res,
            close() {
              res.destroy();
              req.destroy();
            },
          });
        }
      });
    });
    req.on("error", (err) => {
      if (!settled) {
        settled = true;
        reject(err);
      }
    });
  });
}

describe("hardware buddy HTTP control server", () => {
  it("serves health and runtime status on loopback", async () => {
    const runtime = new HeadlessHardwareBuddyRuntime({
      config: {
        transport: "fake",
        keepaliveMs: 0,
        controlServer: true,
        controlPort: 0,
      },
    });

    runtime.start();
    await runtime.controlServer.ready();

    const health = await readJson(await fetch(controlUrl(runtime, "/health")));
    assert.deepStrictEqual(health, {
      ok: true,
      service: "claudebuddy",
      started: true,
    });

    const status = await readJson(await fetch(controlUrl(runtime, "/status")));
    assert.strictEqual(status.ok, true);
    assert.strictEqual(status.status.started, true);
    assert.strictEqual(status.status.transport.type, "fake");
    assert.strictEqual(status.status.transport.connected, true);
    assert.strictEqual(status.status.transport.secure, true);
    assert.strictEqual(status.status.controlServer.enabled, true);

    await runtime.stop();
  });

  it("accepts POST /state and emits a hardware snapshot", async () => {
    const runtime = new HeadlessHardwareBuddyRuntime({
      config: {
        transport: "fake",
        fakeSecure: true,
        keepaliveMs: 0,
        controlServer: true,
        controlPort: 0,
      },
    });

    runtime.start();
    await runtime.controlServer.ready();

    const response = await fetch(controlUrl(runtime, "/state"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        sessions: [{
          id: "standalone",
          title: "HTTP Task",
          state: "thinking",
          updatedAt: 2000,
        }],
        permissions: [],
        doNotDisturb: true,
      }),
    });
    const body = await readJson(response);

    assert.strictEqual(response.status, 200);
    assert.strictEqual(body.ok, true);
    assert.strictEqual(body.snapshot.msg, "HTTP Task");
    assert.strictEqual(runtime.lastSnapshot.msg, "HTTP Task");
    assert.strictEqual(runtime.source.getDoNotDisturb(), true);
    assert.strictEqual(runtime.transport.lastOutbound().meta.reason, "control-state");

    await runtime.stop();
  });

  it("requires the configured control token", async () => {
    const runtime = new HeadlessHardwareBuddyRuntime({
      config: {
        transport: "fake",
        keepaliveMs: 0,
        controlServer: true,
        controlPort: 0,
        controlToken: "secret",
      },
    });

    runtime.start();
    await runtime.controlServer.ready();

    const unauthorized = await readJson(await fetch(controlUrl(runtime, "/status")));
    assert.strictEqual(unauthorized.ok, false);
    assert.strictEqual(unauthorized.error, "unauthorized");

    const authorizedResponse = await fetch(controlUrl(runtime, "/status"), {
      headers: { authorization: "Bearer secret" },
    });
    const authorized = await readJson(authorizedResponse);
    assert.strictEqual(authorizedResponse.status, 200);
    assert.strictEqual(authorized.ok, true);

    await runtime.stop();
  });

  it("can trigger a manual snapshot", async () => {
    const runtime = new HeadlessHardwareBuddyRuntime({
      config: {
        transport: "fake",
        keepaliveMs: 0,
        controlServer: true,
        controlPort: 0,
      },
    });

    runtime.start();
    await runtime.controlServer.ready();

    const response = await fetch(controlUrl(runtime, "/snapshot"), {
      method: "POST",
    });
    const body = await readJson(response);

    assert.strictEqual(response.status, 200);
    assert.strictEqual(body.ok, true);
    assert.strictEqual(runtime.transport.lastOutbound().meta.reason, "control-snapshot");

    await runtime.stop();
  });

  it("accepts explicit finished task state for quick-command affordances", async () => {
    let now = 1710000000000;
    const runtime = new HeadlessHardwareBuddyRuntime({
      config: {
        transport: "fake",
        keepaliveMs: 0,
        controlServer: true,
        controlPort: 0,
        quickCommands: true,
      },
      now: () => now,
    });

    runtime.start();
    await runtime.controlServer.ready();

    const empty = await readJson(await fetch(controlUrl(runtime, "/task-state")));
    assert.strictEqual(empty.ok, true);
    assert.strictEqual(empty.taskState.latest, null);

    const invalid = await fetch(controlUrl(runtime, "/task-state"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        sessionId: "session-1",
        state: "running",
      }),
    });
    const invalidBody = await readJson(invalid);
    assert.strictEqual(invalid.status, 400);
    assert.strictEqual(invalidBody.error, "invalid_task_state");

    const response = await fetch(controlUrl(runtime, "/task-state"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        sessionId: "session-1",
        state: "finished",
        title: "Refactor settings flow",
        source: "adapter",
      }),
    });
    const body = await readJson(response);

    assert.strictEqual(response.status, 200);
    assert.deepStrictEqual(body.taskState, {
      seq: 1,
      type: "task_state",
      version: 1,
      sessionId: "session-1",
      state: "finished",
      title: "Refactor settings flow",
      source: "adapter",
      createdAt: 1710000000000,
    });

    const latest = await readJson(await fetch(controlUrl(runtime, "/task-state?maxAgeMs=30000")));
    assert.deepStrictEqual(latest.taskState.latest, body.taskState);

    now += 30001;
    const expired = await readJson(await fetch(controlUrl(runtime, "/task-state?maxAgeMs=30000")));
    assert.strictEqual(expired.taskState.latest, null);

    await runtime.stop();
  });

  it("rejects task-state endpoints when quick commands are disabled", async () => {
    const runtime = new HeadlessHardwareBuddyRuntime({
      config: {
        transport: "fake",
        keepaliveMs: 0,
        controlServer: true,
        controlPort: 0,
        quickCommands: false,
      },
    });

    runtime.start();
    await runtime.controlServer.ready();

    const getResponse = await fetch(controlUrl(runtime, "/task-state"));
    const getBody = await readJson(getResponse);
    assert.strictEqual(getResponse.status, 409);
    assert.strictEqual(getBody.error, "quick_commands_disabled");

    const postResponse = await fetch(controlUrl(runtime, "/task-state"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        sessionId: "session-1",
        state: "finished",
      }),
    });
    const postBody = await readJson(postResponse);
    assert.strictEqual(postResponse.status, 409);
    assert.strictEqual(postBody.error, "quick_commands_disabled");

    await runtime.stop();
  });

  it("exposes hardware permission replies over HTTP without a reply file", async () => {
    const runtime = new HeadlessHardwareBuddyRuntime({
      config: {
        transport: "fake",
        fakeSecure: true,
        keepaliveMs: 0,
        controlServer: true,
        controlPort: 0,
        permissionReplies: true,
        replyBufferSize: 10,
      },
      now: () => 1710000000000,
    });

    runtime.start();
    await runtime.controlServer.ready();

    const stateResponse = await fetch(controlUrl(runtime, "/state"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        sessions: [{
          id: "standalone",
          title: "HTTP Approval",
          state: "working",
        }],
        permissions: [{
          id: "prompt-1",
          sessionId: "standalone",
          agentId: "claude-code",
          toolName: "Bash",
          toolInput: { command: "git status" },
          createdAt: 1000,
        }],
      }),
    });
    const state = await readJson(stateResponse);
    const promptId = state.snapshot.prompt.id;

    runtime.transport.injectCommand({ cmd: "permission", id: promptId, decision: "once" });

    const repliesResponse = await fetch(controlUrl(runtime, "/replies?after=0"));
    const replies = await readJson(repliesResponse);
    assert.strictEqual(replies.ok, true);
    assert.strictEqual(replies.replies.nextCursor, 1);
    assert.strictEqual(replies.replies.hasMore, false);
    assert.deepStrictEqual(replies.replies.items, [{
      seq: 1,
      type: "permission_reply",
      id: "prompt-1",
      promptId,
      behavior: "allow",
      decision: "once",
      sessionId: "standalone",
      agentId: "claude-code",
      toolName: "Bash",
      createdAt: 1000,
      time: "2024-03-09T16:00:00.000Z",
    }]);
    assert.ok(!Object.prototype.hasOwnProperty.call(replies.replies.items[0], "toolInput"));
    assert.deepStrictEqual(runtime.source.getPendingPermissions(), []);

    const empty = await readJson(await fetch(controlUrl(runtime, `/replies?after=${replies.replies.nextCursor}`)));
    assert.strictEqual(empty.replies.items.length, 0);

    await runtime.stop();
  });

  it("long-polls /replies until a hardware permission reply arrives", async () => {
    const runtime = new HeadlessHardwareBuddyRuntime({
      config: {
        transport: "fake",
        fakeSecure: true,
        keepaliveMs: 0,
        controlServer: true,
        controlPort: 0,
        permissionReplies: true,
        replyBufferSize: 10,
      },
      now: () => 1710000000000,
    });

    runtime.start();
    await runtime.controlServer.ready();

    await fetch(controlUrl(runtime, "/state"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        sessions: [{ id: "standalone", title: "HTTP Approval", state: "working" }],
        permissions: [{
          id: "prompt-1",
          sessionId: "standalone",
          agentId: "claude-code",
          toolName: "Bash",
          createdAt: 1000,
        }],
      }),
    });
    const promptId = runtime.lastSnapshot.prompt.id;
    let settled = false;
    const pending = fetch(controlUrl(runtime, "/replies?after=0&wait=1000"))
      .then(readJson)
      .then((body) => {
        settled = true;
        return body;
      });

    await delay(20);
    assert.strictEqual(settled, false);

    runtime.transport.injectCommand({ cmd: "permission", id: promptId, decision: "once" });
    const replies = await pending;

    assert.strictEqual(replies.ok, true);
    assert.strictEqual(replies.replies.nextCursor, 1);
    assert.deepStrictEqual(replies.replies.items.map((item) => item.behavior), ["allow"]);

    await runtime.stop();
  });

  it("long-polls /replies until timeout when no reply arrives", async () => {
    const runtime = new HeadlessHardwareBuddyRuntime({
      config: {
        transport: "fake",
        fakeSecure: true,
        keepaliveMs: 0,
        controlServer: true,
        controlPort: 0,
        permissionReplies: true,
        replyBufferSize: 10,
      },
    });

    runtime.start();
    await runtime.controlServer.ready();

    let settled = false;
    const pending = fetch(controlUrl(runtime, "/replies?after=0&wait=80"))
      .then(readJson)
      .then((body) => {
        settled = true;
        return body;
      });

    await delay(20);
    assert.strictEqual(settled, false);
    const replies = await pending;

    assert.strictEqual(replies.ok, true);
    assert.strictEqual(replies.replies.nextCursor, 0);
    assert.deepStrictEqual(replies.replies.items, []);
    assert.strictEqual(runtime.permissionReplySink.waiters.size, 0);

    await runtime.stop();
  });

  it("cleans long-poll waiters when the client aborts", async () => {
    const runtime = new HeadlessHardwareBuddyRuntime({
      config: {
        transport: "fake",
        fakeSecure: true,
        keepaliveMs: 0,
        controlServer: true,
        controlPort: 0,
        permissionReplies: true,
        replyBufferSize: 10,
      },
    });

    runtime.start();
    await runtime.controlServer.ready();

    const controller = new AbortController();
    const pending = fetch(controlUrl(runtime, "/replies?after=0&wait=1000"), {
      signal: controller.signal,
    }).catch((err) => err);

    assert.strictEqual(await waitFor(() => runtime.permissionReplySink.waiters.size === 1), true);
    controller.abort();
    await pending;
    assert.strictEqual(await waitFor(() => runtime.permissionReplySink.waiters.size === 0), true);

    await runtime.stop();
  });

  it("streams permission replies over server-sent events", async () => {
    const runtime = new HeadlessHardwareBuddyRuntime({
      config: {
        transport: "fake",
        fakeSecure: true,
        keepaliveMs: 0,
        controlServer: true,
        controlPort: 0,
        permissionReplies: true,
        replyBufferSize: 10,
      },
      now: () => 1710000000000,
    });

    runtime.start();
    await runtime.controlServer.ready();

    const response = await fetch(controlUrl(runtime, "/replies/stream?after=0&heartbeat=60000"));
    const stream = createSseReader(response);
    try {
      assert.strictEqual(response.status, 200);
      assert.match(response.headers.get("content-type"), /text\/event-stream/);

      const ready = await stream.nextEvent();
      assert.strictEqual(ready.event, "ready");
      assert.strictEqual(ready.data.ok, true);
      assert.strictEqual(ready.data.count, 0);

      await fetch(controlUrl(runtime, "/state"), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          sessions: [{ id: "standalone", title: "HTTP Approval", state: "working" }],
          permissions: [{
            id: "prompt-1",
            sessionId: "standalone",
            agentId: "claude-code",
            toolName: "Bash",
            createdAt: 1000,
          }],
        }),
      });
      const promptId = runtime.lastSnapshot.prompt.id;
      runtime.transport.injectCommand({ cmd: "permission", id: promptId, decision: "deny" });

      const reply = await stream.nextEvent();
      assert.strictEqual(reply.event, "permission_reply");
      assert.strictEqual(reply.id, "1");
      assert.strictEqual(reply.data.id, "prompt-1");
      assert.strictEqual(reply.data.promptId, promptId);
      assert.strictEqual(reply.data.behavior, "deny");
      assert.ok(!Object.prototype.hasOwnProperty.call(reply.data, "toolInput"));
    } finally {
      await runtime.stop();
      await stream.cancel().catch(() => {});
    }
  });

  it("emits SSE heartbeat events", async () => {
    const runtime = new HeadlessHardwareBuddyRuntime({
      config: {
        transport: "fake",
        fakeSecure: true,
        keepaliveMs: 0,
        controlServer: true,
        controlPort: 0,
        permissionReplies: true,
      },
    });

    runtime.start();
    await runtime.controlServer.ready();

    const response = await fetch(controlUrl(runtime, "/replies/stream?after=0&heartbeat=1000"));
    const stream = createSseReader(response);
    try {
      assert.strictEqual((await stream.nextEvent()).event, "ready");
      const heartbeat = await stream.nextEvent();
      assert.strictEqual(heartbeat.event, "heartbeat");
      assert.strictEqual(heartbeat.data.ok, true);
      assert.strictEqual(heartbeat.data.cursor, 0);
    } finally {
      await runtime.stop();
      await stream.cancel().catch(() => {});
    }
  });

  it("cleans SSE clients when the client disconnects", async () => {
    const runtime = new HeadlessHardwareBuddyRuntime({
      config: {
        transport: "fake",
        fakeSecure: true,
        keepaliveMs: 0,
        controlServer: true,
        controlPort: 0,
        permissionReplies: true,
      },
    });

    runtime.start();
    await runtime.controlServer.ready();

    const client = await openRawSse(controlUrl(runtime, "/replies/stream?after=0&heartbeat=60000"));
    try {
      assert.strictEqual(runtime.controlServer.streamClients.size, 1);
      client.close();
      assert.strictEqual(await waitFor(() => runtime.controlServer.streamClients.size === 0), true);
    } finally {
      client.close();
      await runtime.stop();
    }
  });

  it("closes SSE clients during runtime stop", async () => {
    const runtime = new HeadlessHardwareBuddyRuntime({
      config: {
        transport: "fake",
        fakeSecure: true,
        keepaliveMs: 0,
        controlServer: true,
        controlPort: 0,
        permissionReplies: true,
      },
    });

    runtime.start();
    await runtime.controlServer.ready();

    const response = await fetch(controlUrl(runtime, "/replies/stream?after=0&heartbeat=60000"));
    const stream = createSseReader(response);
    try {
      assert.strictEqual((await stream.nextEvent()).event, "ready");
      assert.strictEqual(runtime.controlServer.streamClients.size, 1);
      const stopped = await Promise.race([
        Promise.resolve(runtime.stop()).then(() => true),
        delay(500).then(() => false),
      ]);
      assert.strictEqual(stopped, true);
      assert.strictEqual(runtime.controlServer.streamClients.size, 0);
    } finally {
      await runtime.stop();
      await stream.cancel().catch(() => {});
    }
  });

  it("writes replies to both HTTP memory and JSONL file when configured", async (t) => {
    const fs = require("node:fs");
    const os = require("node:os");
    const path = require("node:path");
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "claudebuddy-http-replies-"));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const replyFile = path.join(dir, "replies.jsonl");
    const runtime = new HeadlessHardwareBuddyRuntime({
      config: {
        transport: "fake",
        fakeSecure: true,
        keepaliveMs: 0,
        controlServer: true,
        controlPort: 0,
        permissionReplies: true,
        replyFile,
      },
      now: () => 1710000000000,
    });

    runtime.start();
    await runtime.controlServer.ready();

    await fetch(controlUrl(runtime, "/state"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        sessions: [{ id: "standalone", title: "HTTP Approval", state: "working" }],
        permissions: [{
          id: "prompt-1",
          sessionId: "standalone",
          agentId: "claude-code",
          toolName: "Bash",
          createdAt: 1000,
        }],
      }),
    });
    const promptId = runtime.lastSnapshot.prompt.id;
    runtime.transport.injectCommand({ cmd: "permission", id: promptId, decision: "deny" });

    const replies = await readJson(await fetch(controlUrl(runtime, "/replies")));
    assert.strictEqual(replies.replies.items[0].behavior, "deny");
    const fileLine = JSON.parse(fs.readFileSync(replyFile, "utf8").trim());
    assert.strictEqual(fileLine.behavior, "deny");
    assert.ok(!Object.prototype.hasOwnProperty.call(fileLine, "seq"));

    await runtime.stop();
  });
});
