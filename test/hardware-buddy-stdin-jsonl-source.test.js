"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert");
const { PassThrough } = require("node:stream");

const {
  StdinJsonlHardwareBuddySource,
  unwrapStateMessage,
} = require("../src/runtime/stdin-jsonl-source");

function writeLine(stream, value) {
  stream.write(`${JSON.stringify(value)}\n`);
}

describe("stdin-jsonl hardware buddy source", () => {
  it("normalizes raw state lines from stdin", () => {
    const input = new PassThrough();
    const changes = [];
    const source = new StdinJsonlHardwareBuddySource({
      stream: input,
      now: () => 1000,
    });
    source.onChange((reason) => changes.push(reason));

    source.start();
    writeLine(input, {
      sessions: [{
        id: "s1",
        title: "Pipe task",
        state: "thinking",
        event: "stdin",
      }],
      permissions: [{
        id: "p1",
        sessionId: "s1",
        agentId: "codex",
        toolName: "Bash",
        toolInput: { command: "npm test" },
        createdAt: 900,
        isCodex: true,
      }],
      dnd: true,
    });

    assert.deepStrictEqual(changes, ["state-change"]);
    assert.strictEqual(source.getSessionSnapshot().sessions[0].displayTitle, "Pipe task");
    assert.strictEqual(source.getSessionSnapshot().sessions[0].lastEvent.rawEvent, "stdin");
    assert.strictEqual(source.getPendingPermissions()[0].id, "p1");
    assert.strictEqual(source.getPendingPermissions()[0].isCodex, true);
    assert.strictEqual(source.getDoNotDisturb(), true);

    source.stop();
  });

  it("accepts type=state envelopes and keeps the last valid state on bad input", () => {
    const logs = [];
    const source = new StdinJsonlHardwareBuddySource({
      stream: new PassThrough(),
      autoResume: false,
      log: (...args) => logs.push(args),
      now: 1000,
    });

    assert.strictEqual(source.applyLine(JSON.stringify({
      type: "state",
      data: {
        sessions: [{ id: "s1", title: "Envelope task", state: "working" }],
        permissions: [],
      },
    })), true);
    assert.strictEqual(source.getSessionSnapshot().sessions[0].displayTitle, "Envelope task");

    assert.strictEqual(source.applyLine("{"), false);
    assert.strictEqual(source.applyLine("{"), false);

    assert.strictEqual(source.getSessionSnapshot().sessions[0].displayTitle, "Envelope task");
    assert.strictEqual(logs.length, 1);
    assert.strictEqual(logs[0][0], "warn");
    assert.match(logs[0][1], /invalid stdin-jsonl source line/);
  });

  it("flushes a final unterminated JSON line on stream end", async () => {
    const input = new PassThrough();
    const source = new StdinJsonlHardwareBuddySource({
      stream: input,
      now: 1000,
    });

    source.start();
    input.write(JSON.stringify({
      sessions: [{ id: "s1", title: "No trailing newline", state: "working" }],
      permissions: [],
    }));
    input.end();
    await new Promise((resolve) => setImmediate(resolve));

    assert.strictEqual(source.getSessionSnapshot().sessions[0].displayTitle, "No trailing newline");
    source.stop();
  });

  it("drops oversized buffered lines and recovers after the next newline", async () => {
    const input = new PassThrough();
    const logs = [];
    const source = new StdinJsonlHardwareBuddySource({
      stream: input,
      maxBytes: 128,
      log: (...args) => logs.push(args),
      now: 1000,
    });

    source.start();
    input.write("x".repeat(129));
    await new Promise((resolve) => setImmediate(resolve));
    input.write("discarded tail\n");
    input.write(`${JSON.stringify({
      sessions: [{ id: "s1", title: "Recovered", state: "working" }],
      permissions: [],
    })}\n`);

    assert.strictEqual(logs.length, 1);
    assert.strictEqual(logs[0][0], "warn");
    assert.match(logs[0][1], /too large/);
    assert.strictEqual(source.getSessionSnapshot().sessions[0].displayTitle, "Recovered");
    source.stop();
  });

  it("suppresses resolved permissions until the input removes them", () => {
    const source = new StdinJsonlHardwareBuddySource({
      stream: new PassThrough(),
      autoResume: false,
      now: 1000,
    });
    const line = JSON.stringify({
      sessions: [{ id: "standalone", title: "Repo", state: "working" }],
      permissions: [{
        id: "p1",
        sessionId: "standalone",
        toolName: "Bash",
        toolInput: { command: "git status" },
        createdAt: 1000,
      }],
    });

    source.applyLine(line);
    const pending = source.getPendingPermissions()[0];
    assert.strictEqual(source.resolvePermissionEntry(pending), true);
    source.applyLine(line);
    assert.deepStrictEqual(source.getPendingPermissions(), []);

    source.applyLine(JSON.stringify({
      sessions: [{ id: "standalone", title: "Repo", state: "working" }],
      permissions: [],
    }));
    source.applyLine(JSON.stringify({
      sessions: [{ id: "standalone", title: "Repo", state: "working" }],
      permissions: [{
        id: "p1",
        sessionId: "standalone",
        toolName: "Bash",
        toolInput: { command: "git status" },
        createdAt: 2000,
      }],
    }));

    assert.strictEqual(source.getPendingPermissions().length, 1);
    assert.strictEqual(source.getPendingPermissions()[0].createdAt, 2000);
  });

  it("rejects unsupported typed envelopes", () => {
    assert.throws(() => unwrapStateMessage({ type: "ping" }), /unsupported stdin-jsonl message type/);
    assert.throws(() => unwrapStateMessage({ type: "snapshot" }), /unsupported stdin-jsonl message type/);
  });
});
