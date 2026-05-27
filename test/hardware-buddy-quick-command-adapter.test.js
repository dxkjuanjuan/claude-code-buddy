"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const {
  HeadlessHardwareBuddyRuntime,
  consumeQuickCommandsOnce,
  mapQuickCommandToAdapterAction,
} = require("..");

const repoRoot = path.join(__dirname, "..");

function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "claudebuddy-quick-command-adapter-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function controlUrl(runtime, pathname) {
  const address = runtime.controlServer.address();
  return `http://127.0.0.1:${address.port}${pathname}`;
}

async function readJson(response) {
  return JSON.parse(await response.text());
}

async function postQuickCommand(runtime, body, token = "") {
  const headers = { "content-type": "application/json" };
  if (token) headers.authorization = `Bearer ${token}`;
  const response = await fetch(controlUrl(runtime, "/quick-commands"), {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
  const parsed = await readJson(response);
  assert.strictEqual(response.status, 200, JSON.stringify(parsed));
  return parsed.quickCommand;
}

function readJsonLines(file) {
  return fs.readFileSync(file, "utf8")
    .trim()
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

describe("quick command adapter action mapping", () => {
  it("maps message, constraint, and local action presets without shell execution", () => {
    const mappedAt = new Date("2026-05-23T00:00:00.000Z");

    const correction = mapQuickCommandToAdapterAction({
      seq: 7,
      id: "correct",
      label: "不是这样的",
      target: {
        scope: "active_session",
        sessionId: "session-1",
        resolution: "client_provided",
      },
      source: "tray",
      clientRequestId: "req-correct",
      userText: "请换个方向",
      createdAt: 1779463800000,
    }, { now: mappedAt });
    assert.deepStrictEqual(correction, {
      type: "quick_command_action",
      version: 1,
      commandSeq: 7,
      commandId: "correct",
      label: "不是这样的",
      target: {
        scope: "active_session",
        sessionId: "session-1",
        resolution: "client_provided",
      },
      source: "tray",
      clientRequestId: "req-correct",
      createdAt: 1779463800000,
      mappedAt: "2026-05-23T00:00:00.000Z",
      action: "message",
      message: {
        text: "请换个方向",
      },
    });

    const constraint = mapQuickCommandToAdapterAction({
      id: "no_commit",
      clientRequestId: "req-no-commit",
    }, { now: mappedAt });
    assert.deepStrictEqual(constraint.constraint, {
      id: "no_commit",
      kind: "safety",
      policy: "no_commits",
      duration: "next_turn",
    });

    const diff = mapQuickCommandToAdapterAction({
      id: "show_diff",
      source: "http",
      clientRequestId: "req-diff",
    }, { now: mappedAt });
    assert.strictEqual(diff.action, "local_action");
    assert.deepStrictEqual(diff.localAction, {
      id: "show_diff",
      runShell: false,
    });
    assert.ok(!Object.prototype.hasOwnProperty.call(diff, "message"));
    assert.doesNotMatch(JSON.stringify(diff), /git diff|shellCommand|commandLine/);
  });

  it("rejects unknown ids and non-MVP constraint durations", () => {
    assert.throws(() => mapQuickCommandToAdapterAction({
      id: "stop",
      clientRequestId: "req-stop",
    }), /unknown quick command preset/);

    assert.throws(() => mapQuickCommandToAdapterAction({
      id: "no_source_edits",
      duration: "session",
      clientRequestId: "req-session",
    }), /unsupported quick command constraint duration/);
  });
});

describe("quick command HTTP JSONL adapter consumer", () => {
  it("long-polls runtime commands and appends adapter action JSONL", async (t) => {
    const dir = tempDir(t);
    const actionFile = path.join(dir, "logs", "quick-command-actions.jsonl");
    const runtime = new HeadlessHardwareBuddyRuntime({
      config: {
        transport: "fake",
        keepaliveMs: 0,
        controlServer: true,
        controlPort: 0,
        controlToken: "secret",
        quickCommands: true,
      },
      now: () => 1710000000000,
    });

    runtime.start();
    await runtime.controlServer.ready();
    t.after(() => runtime.stop());

    await postQuickCommand(runtime, {
      id: "plan_first",
      source: "http",
      clientRequestId: "adapter-plan-1",
    }, "secret");
    await postQuickCommand(runtime, {
      id: "no_commit",
      source: "http",
      clientRequestId: "adapter-no-commit-1",
    }, "secret");
    await postQuickCommand(runtime, {
      id: "show_diff",
      source: "http",
      clientRequestId: "adapter-diff-1",
    }, "secret");

    const consumed = await consumeQuickCommandsOnce({
      baseUrl: controlUrl(runtime, "/"),
      token: "secret",
      after: 0,
      waitMs: 0,
      actionFile,
      now: () => 1710000001234,
    });

    assert.strictEqual(consumed.count, 3);
    assert.strictEqual(consumed.written, 3);
    assert.strictEqual(consumed.nextCursor, 3);

    const records = readJsonLines(actionFile);
    assert.deepStrictEqual(records.map((record) => record.action), [
      "message",
      "constraint",
      "local_action",
    ]);
    assert.deepStrictEqual(records.map((record) => record.commandId), [
      "plan_first",
      "no_commit",
      "show_diff",
    ]);
    assert.strictEqual(records[0].message.text, "先列计划");
    assert.strictEqual(records[1].constraint.duration, "next_turn");
    assert.deepStrictEqual(records[2].localAction, {
      id: "show_diff",
      runShell: false,
    });
    for (const record of records) {
      assert.strictEqual(record.type, "quick_command_action");
      assert.strictEqual(record.version, 1);
      assert.strictEqual(record.createdAt, 1710000000000);
      assert.strictEqual(record.mappedAt, "2024-03-09T16:00:01.234Z");
      assert.ok(!Object.prototype.hasOwnProperty.call(record, "mode"));
    }
  });

  it("surfaces disabled runtime endpoints as HTTP 409", async (t) => {
    const dir = tempDir(t);
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
    t.after(() => runtime.stop());

    await assert.rejects(() => consumeQuickCommandsOnce({
      baseUrl: controlUrl(runtime, "/"),
      after: 0,
      waitMs: 0,
      actionFile: path.join(dir, "actions.jsonl"),
    }), (err) => {
      assert.strictEqual(err.statusCode, 409);
      assert.match(err.message, /quick commands are disabled/);
      return true;
    });
  });

  it("exposes the reference consumer CLI help path", () => {
    const result = spawnSync(process.execPath, [
      path.join(repoRoot, "bin", "claudebuddy-quick-command-consumer.js"),
      "--help",
    ], {
      encoding: "utf8",
      timeout: 5000,
      windowsHide: true,
    });

    assert.strictEqual(result.status, 0, result.stderr || result.stdout);
    assert.match(result.stdout, /Usage: claudebuddy-quick-command-consumer/);
    assert.match(result.stdout, /adapter consumer/);
  });
});
