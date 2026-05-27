"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
  HeadlessHardwareBuddyRuntime,
} = require("../src/runtime/headless-runtime");
const {
  createMemoryQuickCommandSink,
} = require("../src/runtime/memory-quick-command-sink");
const {
  QUICK_COMMAND_PRESETS,
  normalizeQuickCommandInput,
} = require("../src/runtime/quick-command-presets");

function controlUrl(runtime, pathname) {
  const address = runtime.controlServer.address();
  return `http://127.0.0.1:${address.port}${pathname}`;
}

async function readJson(response) {
  return JSON.parse(await response.text());
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "claudebuddy-quick-commands-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function readJsonLines(file) {
  return fs.readFileSync(file, "utf8")
    .trim()
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

describe("quick command presets and memory sink", () => {
  it("keeps the MVP preset ids and labels stable without stop", () => {
    assert.deepStrictEqual(QUICK_COMMAND_PRESETS.map((preset) => preset.id), [
      "continue",
      "correct",
      "no_commit",
      "no_source_edits",
      "show_diff",
      "plain_language",
      "plan_first",
    ]);
    assert.deepStrictEqual(QUICK_COMMAND_PRESETS.map((preset) => preset.label), [
      "继续",
      "不是这样的",
      "不要 commit",
      "不要改源文件",
      "show diff",
      "说人话",
      "先列计划",
    ]);
    assert.strictEqual(QUICK_COMMAND_PRESETS.some((preset) => preset.id === "stop" || preset.label === "停"), false);
  });

  it("normalizes events without runtime prompt text or execution mode", () => {
    const command = normalizeQuickCommandInput({
      id: "plan_first",
      source: "http",
      clientRequestId: "req-1",
    });

    assert.deepStrictEqual(command, {
      type: "quick_command",
      version: 1,
      id: "plan_first",
      label: "先列计划",
      target: {
        scope: "active_session",
        sessionId: null,
        resolution: "defer_to_adapter",
      },
      duration: null,
      source: "http",
      clientRequestId: "req-1",
      userText: null,
    });
    assert.ok(!Object.prototype.hasOwnProperty.call(command, "text"));
    assert.ok(!Object.prototype.hasOwnProperty.call(command, "mode"));
  });

  it("defaults constraint commands to next_turn and rejects unsupported durations", () => {
    assert.strictEqual(normalizeQuickCommandInput({
      id: "no_commit",
      clientRequestId: "req-constraint",
    }).duration, "next_turn");

    assert.throws(() => normalizeQuickCommandInput({
      id: "plan_first",
      clientRequestId: "req-message-duration",
      duration: "next_turn",
    }), /duration must be null/);
    assert.throws(() => normalizeQuickCommandInput({
      id: "no_source_edits",
      clientRequestId: "req-bad-duration",
      duration: "session",
    }), /duration must be next_turn/);
  });

  it("requires clientRequestId and rejects unknown presets", () => {
    assert.throws(() => normalizeQuickCommandInput({ id: "plan_first" }), /clientRequestId is required/);
    assert.throws(() => normalizeQuickCommandInput({
      id: "stop",
      clientRequestId: "req-stop",
    }), /unknown quick command preset/);
  });

  it("stores, trims, waits, and de-duplicates commands by clientRequestId", async () => {
    let now = 1000;
    const sink = createMemoryQuickCommandSink({
      maxRecords: 2,
      dedupeMs: 100,
      now: () => now,
    });

    const first = sink.write({
      id: "plan_first",
      source: "http",
      clientRequestId: "req-1",
    });
    assert.strictEqual(first.duplicate, false);
    assert.strictEqual(first.record.seq, 1);

    const duplicate = sink.write({
      id: "plan_first",
      source: "http",
      clientRequestId: "req-1",
    });
    assert.strictEqual(duplicate.duplicate, true);
    assert.strictEqual(duplicate.record, first.record);

    now = 1101;
    const second = sink.write({ id: "continue", clientRequestId: "req-1" });
    const third = sink.write({ id: "correct", clientRequestId: "req-3" });
    assert.strictEqual(second.record.seq, 2);
    assert.strictEqual(third.record.seq, 3);

    const listed = sink.list({ after: 0 });
    assert.deepStrictEqual(listed.items.map((item) => item.id), ["continue", "correct"]);
    assert.strictEqual(listed.oldestSeq, 2);
    assert.strictEqual(listed.latestSeq, 3);

    const pending = sink.wait({ after: 3, timeoutMs: 1000 });
    sink.write({ id: "show_diff", clientRequestId: "req-4" });
    const waited = await pending;
    assert.deepStrictEqual(waited.items.map((item) => item.id), ["show_diff"]);
    sink.stop();
  });
});

describe("quick command HTTP control surface and JSONL consumer", () => {
  it("returns presets when disabled but rejects stateful endpoints with 409", async () => {
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

    const presetsResponse = await fetch(controlUrl(runtime, "/quick-commands/presets"));
    const presets = await readJson(presetsResponse);
    assert.strictEqual(presetsResponse.status, 200);
    assert.strictEqual(presets.enabled, false);
    assert.deepStrictEqual(presets.presets.map((preset) => preset.id), QUICK_COMMAND_PRESETS.map((preset) => preset.id));

    const getResponse = await fetch(controlUrl(runtime, "/quick-commands?after=0"));
    const getBody = await readJson(getResponse);
    assert.strictEqual(getResponse.status, 409);
    assert.strictEqual(getBody.error, "quick_commands_disabled");

    const postResponse = await fetch(controlUrl(runtime, "/quick-commands"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: "plan_first", clientRequestId: "disabled-1" }),
    });
    const postBody = await readJson(postResponse);
    assert.strictEqual(postResponse.status, 409);
    assert.strictEqual(postBody.error, "quick_commands_disabled");

    await runtime.stop();
  });

  it("requires control token for quick-command endpoints", async () => {
    const runtime = new HeadlessHardwareBuddyRuntime({
      config: {
        transport: "fake",
        keepaliveMs: 0,
        controlServer: true,
        controlPort: 0,
        controlToken: "secret",
        quickCommands: true,
      },
    });

    runtime.start();
    await runtime.controlServer.ready();

    const unauthorized = await fetch(controlUrl(runtime, "/quick-commands/presets"));
    assert.strictEqual(unauthorized.status, 401);

    const authorized = await fetch(controlUrl(runtime, "/quick-commands/presets"), {
      headers: { "x-claudebuddy-token": "secret" },
    });
    const body = await readJson(authorized);
    assert.strictEqual(authorized.status, 200);
    assert.strictEqual(body.enabled, true);

    await runtime.stop();
  });

  it("posts, lists, long-polls, and de-duplicates quick-command events", async () => {
    const runtime = new HeadlessHardwareBuddyRuntime({
      config: {
        transport: "fake",
        keepaliveMs: 0,
        controlServer: true,
        controlPort: 0,
        quickCommands: true,
        quickCommandBufferSize: 10,
        quickCommandDedupeMs: 30000,
      },
      now: () => 1710000000000,
    });

    runtime.start();
    await runtime.controlServer.ready();

    const missingResponse = await fetch(controlUrl(runtime, "/quick-commands"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: "plan_first" }),
    });
    const missing = await readJson(missingResponse);
    assert.strictEqual(missingResponse.status, 400);
    assert.strictEqual(missing.error, "missing_client_request_id");

    const postedResponse = await fetch(controlUrl(runtime, "/quick-commands"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        id: "no_commit",
        source: "http",
        clientRequestId: "req-constraint-1",
        target: { scope: "active_session", sessionId: "session-1" },
      }),
    });
    const posted = await readJson(postedResponse);
    assert.strictEqual(postedResponse.status, 200);
    assert.strictEqual(posted.duplicate, false);
    assert.strictEqual(posted.quickCommand.seq, 1);
    assert.strictEqual(posted.quickCommand.duration, "next_turn");
    assert.deepStrictEqual(posted.quickCommand.target, {
      scope: "active_session",
      sessionId: "session-1",
      resolution: "client_provided",
    });
    assert.ok(!Object.prototype.hasOwnProperty.call(posted.quickCommand, "text"));
    assert.ok(!Object.prototype.hasOwnProperty.call(posted.quickCommand, "mode"));

    const duplicateResponse = await fetch(controlUrl(runtime, "/quick-commands"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        id: "no_commit",
        source: "http",
        clientRequestId: "req-constraint-1",
      }),
    });
    const duplicate = await readJson(duplicateResponse);
    assert.strictEqual(duplicate.duplicate, true);
    assert.strictEqual(duplicate.quickCommand.seq, 1);

    const listed = await readJson(await fetch(controlUrl(runtime, "/quick-commands?after=0")));
    assert.strictEqual(listed.ok, true);
    assert.strictEqual(listed.quickCommands.nextCursor, 1);
    assert.deepStrictEqual(listed.quickCommands.items.map((item) => item.id), ["no_commit"]);

    let settled = false;
    const pending = fetch(controlUrl(runtime, "/quick-commands?after=1&wait=1000"))
      .then(readJson)
      .then((body) => {
        settled = true;
        return body;
      });
    await delay(20);
    assert.strictEqual(settled, false);

    await fetch(controlUrl(runtime, "/quick-commands"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        id: "plan_first",
        source: "http",
        clientRequestId: "req-plan-1",
        duration: null,
      }),
    });
    const longPolled = await pending;
    assert.strictEqual(longPolled.quickCommands.nextCursor, 2);
    assert.deepStrictEqual(longPolled.quickCommands.items.map((item) => item.id), ["plan_first"]);

    await runtime.stop();
  });

  it("uses the default GET limit instead of clamping a missing limit to one", async () => {
    const runtime = new HeadlessHardwareBuddyRuntime({
      config: {
        transport: "fake",
        keepaliveMs: 0,
        controlServer: true,
        controlPort: 0,
        quickCommands: true,
      },
    });

    runtime.start();
    await runtime.controlServer.ready();

    for (const [id, clientRequestId] of [
      ["plan_first", "limit-default-1"],
      ["plain_language", "limit-default-2"],
    ]) {
      const response = await fetch(controlUrl(runtime, "/quick-commands"), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id, source: "http", clientRequestId }),
      });
      assert.strictEqual(response.status, 200);
    }

    const listed = await readJson(await fetch(controlUrl(runtime, "/quick-commands?after=0")));
    assert.deepStrictEqual(listed.quickCommands.items.map((item) => item.id), ["plan_first", "plain_language"]);
    assert.strictEqual(listed.quickCommands.hasMore, false);

    await runtime.stop();
  });

  it("writes consumed quick-command events to the configured JSONL file", async (t) => {
    const dir = tempDir(t);
    const consumedFile = path.join(dir, "logs", "quick-commands-consumed.jsonl");
    const runtime = new HeadlessHardwareBuddyRuntime({
      config: {
        transport: "fake",
        keepaliveMs: 0,
        controlServer: true,
        controlPort: 0,
        quickCommands: true,
        quickCommandConsumer: "jsonl",
        quickCommandConsumerFile: consumedFile,
      },
      now: () => 1710000000000,
    });

    runtime.start();
    await runtime.controlServer.ready();

    await fetch(controlUrl(runtime, "/quick-commands"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        id: "plain_language",
        source: "http",
        clientRequestId: "req-consume-1",
      }),
    });

    const records = readJsonLines(consumedFile);
    assert.deepStrictEqual(records, [{
      type: "quick_command_consumed",
      version: 1,
      seq: 1,
      id: "plain_language",
      label: "说人话",
      target: {
        scope: "active_session",
        sessionId: null,
        resolution: "defer_to_adapter",
      },
      duration: null,
      source: "http",
      clientRequestId: "req-consume-1",
      userText: null,
      createdAt: 1710000000000,
      consumedAt: "2024-03-09T16:00:00.000Z",
    }]);

    await runtime.stop();
  });
});
