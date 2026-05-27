"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
  JsonlPermissionReplySink,
  createPermissionReplyRecord,
} = require("../src/runtime/jsonl-reply-sink");

function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "claudebuddy-reply-sink-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

describe("jsonl permission reply sink", () => {
  it("builds minimal permission reply records without tool input", () => {
    const record = createPermissionReplyRecord({
      id: "prompt-1",
      sessionId: "standalone",
      agentId: "claude-code",
      toolName: "Bash",
      toolInput: { command: "secret" },
      createdAt: 1000,
    }, "allow", {
      meta: { promptId: "hb_1", decision: "once" },
      now: 1710000000000,
    });

    assert.deepStrictEqual(record, {
      type: "permission_reply",
      id: "prompt-1",
      promptId: "hb_1",
      behavior: "allow",
      decision: "once",
      sessionId: "standalone",
      agentId: "claude-code",
      toolName: "Bash",
      createdAt: 1000,
      time: "2024-03-09T16:00:00.000Z",
    });
    assert.ok(!Object.prototype.hasOwnProperty.call(record, "toolInput"));
  });

  it("rejects invalid permission reply behavior", () => {
    assert.throws(() => {
      createPermissionReplyRecord({
        id: "prompt-1",
        sessionId: "standalone",
        toolName: "Bash",
      }, "maybe", {
        meta: { promptId: "hb_1" },
        now: 1710000000000,
      });
    }, /behavior must be allow or deny/);
  });

  it("appends JSONL records and creates parent directories", (t) => {
    const dir = tempDir(t);
    const file = path.join(dir, "nested", "replies.jsonl");
    const sink = new JsonlPermissionReplySink({
      file,
      now: () => 1710000000000,
    });

    assert.strictEqual(sink.write({
      id: "prompt-1",
      sessionId: "standalone",
      agentId: "claude-code",
      toolName: "Bash",
      createdAt: 1000,
    }, "deny", { promptId: "hb_1", decision: "deny" }), true);

    const lines = fs.readFileSync(file, "utf8").trim().split(/\r?\n/);
    assert.strictEqual(lines.length, 1);
    assert.deepStrictEqual(JSON.parse(lines[0]), {
      type: "permission_reply",
      id: "prompt-1",
      promptId: "hb_1",
      behavior: "deny",
      decision: "deny",
      sessionId: "standalone",
      agentId: "claude-code",
      toolName: "Bash",
      createdAt: 1000,
      time: "2024-03-09T16:00:00.000Z",
    });
  });

  it("returns false instead of writing invalid behavior", (t) => {
    const dir = tempDir(t);
    const file = path.join(dir, "replies.jsonl");
    const logs = [];
    const sink = new JsonlPermissionReplySink({
      file,
      log: (...args) => logs.push(args),
      now: () => 1710000000000,
    });

    assert.strictEqual(sink.write({
      id: "prompt-1",
      sessionId: "standalone",
      toolName: "Bash",
    }, "maybe", { promptId: "hb_1" }), false);

    assert.strictEqual(fs.existsSync(file), false);
    assert.strictEqual(logs[0][0], "error");
    assert.match(logs[0][1], /behavior must be allow or deny/);
  });
});
