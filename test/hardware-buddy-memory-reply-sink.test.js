"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert");

const {
  CompositePermissionReplySink,
  MemoryPermissionReplySink,
} = require("../src/runtime/memory-reply-sink");

function entry(id = "prompt-1") {
  return {
    id,
    sessionId: "standalone",
    agentId: "claude-code",
    toolName: "Bash",
    toolInput: { command: "secret" },
    createdAt: 1000,
  };
}

describe("memory permission reply sink", () => {
  it("stores reply records with cursors and without tool input", () => {
    const sink = new MemoryPermissionReplySink({
      maxRecords: 2,
      now: () => 1710000000000,
    });

    assert.strictEqual(sink.write(entry("p1"), "allow", { promptId: "hb_1", decision: "once" }), true);
    assert.strictEqual(sink.write(entry("p2"), "deny", { promptId: "hb_2", decision: "deny" }), true);

    const first = sink.list({ after: 0, limit: 1 });
    assert.strictEqual(first.cursor, 0);
    assert.strictEqual(first.nextCursor, 1);
    assert.strictEqual(first.hasMore, true);
    assert.deepStrictEqual(first.items[0], {
      seq: 1,
      type: "permission_reply",
      id: "p1",
      promptId: "hb_1",
      behavior: "allow",
      decision: "once",
      sessionId: "standalone",
      agentId: "claude-code",
      toolName: "Bash",
      createdAt: 1000,
      time: "2024-03-09T16:00:00.000Z",
    });
    assert.ok(!Object.prototype.hasOwnProperty.call(first.items[0], "toolInput"));

    const second = sink.list({ after: first.nextCursor });
    assert.strictEqual(second.items.length, 1);
    assert.strictEqual(second.items[0].seq, 2);
    assert.strictEqual(second.hasMore, false);
  });

  it("trims old replies to the configured buffer size", () => {
    const sink = new MemoryPermissionReplySink({ maxRecords: 2 });

    sink.write(entry("p1"), "allow");
    sink.write(entry("p2"), "allow");
    sink.write(entry("p3"), "allow");

    const replies = sink.list({ after: 0 });
    assert.deepStrictEqual(replies.items.map((item) => item.id), ["p2", "p3"]);
    assert.strictEqual(replies.oldestSeq, 2);
    assert.strictEqual(replies.latestSeq, 3);
  });

  it("clamps maxRecords with nullish defaults", () => {
    const sink = new MemoryPermissionReplySink({ maxRecords: 0 });

    sink.write(entry("p1"), "allow");
    sink.write(entry("p2"), "allow");

    assert.strictEqual(sink.status().maxRecords, 1);
    assert.deepStrictEqual(sink.list({ after: 0 }).items.map((item) => item.id), ["p2"]);
  });

  it("notifies subscribers and resolves reply waiters", async () => {
    const sink = new MemoryPermissionReplySink({
      maxRecords: 10,
      now: () => 1710000000000,
    });
    const seen = [];
    const unsubscribe = sink.subscribe((record) => seen.push(record.id));
    const pending = sink.wait({ after: 0, timeoutMs: 1000 });

    sink.write(entry("p1"), "allow", { promptId: "hb_1", decision: "once" });
    const replies = await pending;

    assert.deepStrictEqual(seen, ["p1"]);
    assert.deepStrictEqual(replies.items.map((item) => item.id), ["p1"]);
    assert.strictEqual(replies.nextCursor, 1);

    unsubscribe();
    sink.write(entry("p2"), "deny", { promptId: "hb_2", decision: "deny" });
    assert.deepStrictEqual(seen, ["p1"]);
  });

  it("composite sink writes to every sink and lists from memory", () => {
    const memory = new MemoryPermissionReplySink({
      maxRecords: 10,
      now: () => 1710000000000,
    });
    const writes = [];
    const fileLike = {
      write(...args) {
        writes.push(args);
        return true;
      },
    };
    const sink = new CompositePermissionReplySink([fileLike, memory]);

    assert.strictEqual(sink.write(entry("p1"), "deny", { promptId: "hb_1" }), true);
    assert.strictEqual(writes.length, 1);
    assert.strictEqual(sink.list({ after: 0 }).items[0].behavior, "deny");
    assert.strictEqual(sink.status().type, "composite");
  });

  it("composite sink stops every sink that supports stop", () => {
    const stopped = [];
    const sink = new CompositePermissionReplySink([
      { write: () => true, stop: () => stopped.push("a") },
      { write: () => true, stop: () => stopped.push("b") },
    ]);

    sink.stop();

    assert.deepStrictEqual(stopped, ["a", "b"]);
  });
});
