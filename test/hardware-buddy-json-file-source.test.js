"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
  DEFAULT_MAX_SOURCE_BYTES,
  JsonFileHardwareBuddySource,
  normalizeJsonFileState,
} = require("../src/runtime/json-file-source");

function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "claudebuddy-json-source-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function writeJson(file, value) {
  fs.writeFileSync(file, JSON.stringify(value), "utf8");
}

function makeIntervalApi() {
  const intervals = [];
  return {
    intervals,
    setInterval(fn, ms) {
      const id = intervals.length;
      intervals.push({ fn, ms, active: true });
      return id;
    },
    clearInterval(id) {
      if (intervals[id]) intervals[id].active = false;
    },
    tick() {
      for (const interval of intervals) {
        if (interval.active) interval.fn();
      }
    },
  };
}

describe("json-file hardware buddy source", () => {
  it("normalizes external sessions and permissions", () => {
    const state = normalizeJsonFileState({
      sessions: [{
        id: "s1",
        title: "Build firmware",
        state: "working",
        event: "PlatformIO",
      }],
      permissions: [{
        id: "p1",
        sessionId: "s1",
        agentId: "codex",
        tool: "Bash",
        input: { command: "npm test" },
        createdAt: 123,
        isCodex: true,
      }],
      dnd: true,
    }, { now: 1000 });

    assert.deepStrictEqual(state.sessions, [{
      id: "s1",
      state: "working",
      displayTitle: "Build firmware",
      sessionTitle: "Build firmware",
      updatedAt: 1000,
      agentId: "standalone",
      headless: false,
      hiddenFromHud: false,
      lastEvent: { rawEvent: "PlatformIO" },
    }]);
    assert.strictEqual(state.pendingPermissions.length, 1);
    assert.strictEqual(state.pendingPermissions[0].id, "p1");
    assert.strictEqual(state.pendingPermissions[0].toolName, "Bash");
    assert.deepStrictEqual(state.pendingPermissions[0].toolInput, { command: "npm test" });
    assert.strictEqual(state.pendingPermissions[0].isCodex, true);
    assert.strictEqual(state.doNotDisturb, true);
  });

  it("loads an initial state from a JSON file", (t) => {
    const dir = tempDir(t);
    const file = path.join(dir, "state.json");
    writeJson(file, {
      sessions: [{ id: "standalone", title: "Repo task", state: "thinking", updatedAt: 20 }],
      permissions: [],
      doNotDisturb: false,
    });
    const source = new JsonFileHardwareBuddySource({
      file,
      pollMs: 0,
      now: 10,
    });

    source.start();

    assert.deepStrictEqual(source.getSessionSnapshot().sessions.map((session) => session.displayTitle), ["Repo task"]);
    assert.strictEqual(source.getSessionSnapshot().sessions[0].state, "thinking");
    assert.deepStrictEqual(source.getPendingPermissions(), []);
    assert.strictEqual(source.getDoNotDisturb(), false);
  });

  it("polls for file changes and emits state changes", (t) => {
    const clock = makeIntervalApi();
    const dir = tempDir(t);
    const file = path.join(dir, "state.json");
    writeJson(file, {
      sessions: [{ id: "s1", title: "First", state: "working" }],
    });
    const changes = [];
    const source = new JsonFileHardwareBuddySource({
      file,
      pollMs: 50,
      setInterval: clock.setInterval,
      clearInterval: clock.clearInterval,
      now: 100,
    });
    source.onChange((reason) => changes.push(reason));

    source.start();
    assert.strictEqual(clock.intervals.length, 1);
    assert.deepStrictEqual(changes, []);

    writeJson(file, {
      sessions: [{ id: "s1", title: "Second", state: "working" }],
    });
    clock.tick();

    assert.deepStrictEqual(changes, ["state-change"]);
    assert.strictEqual(source.getSessionSnapshot().sessions[0].displayTitle, "Second");

    source.stop();
    assert.strictEqual(clock.intervals[0].active, false);
  });

  it("keeps the last valid state when JSON becomes invalid", (t) => {
    const clock = makeIntervalApi();
    const dir = tempDir(t);
    const file = path.join(dir, "state.json");
    const logs = [];
    writeJson(file, {
      sessions: [{ id: "s1", title: "Stable", state: "working" }],
    });
    const source = new JsonFileHardwareBuddySource({
      file,
      pollMs: 10,
      setInterval: clock.setInterval,
      clearInterval: clock.clearInterval,
      log: (...args) => logs.push(args),
      now: 100,
    });

    source.start();
    fs.writeFileSync(file, "{", "utf8");
    clock.tick();
    clock.tick();

    assert.strictEqual(source.getSessionSnapshot().sessions[0].displayTitle, "Stable");
    assert.strictEqual(logs.length, 1);
    assert.strictEqual(logs[0][0], "warn");
    assert.match(logs[0][1], /invalid json-file source/);
  });

  it("preserves permission object identity for stable permission keys", (t) => {
    const dir = tempDir(t);
    const file = path.join(dir, "state.json");
    writeJson(file, {
      sessions: [{ id: "s1", title: "Repo", state: "working" }],
      permissions: [{
        id: "p1",
        sessionId: "s1",
        toolName: "Bash",
        toolInput: { command: "git status" },
        createdAt: 1,
      }],
    });
    const source = new JsonFileHardwareBuddySource({ file, pollMs: 0 });

    source.start();
    const first = source.getPendingPermissions()[0];
    writeJson(file, {
      sessions: [{ id: "s1", title: "Repo updated", state: "working" }],
      permissions: [{
        id: "p1",
        sessionId: "s1",
        toolName: "Bash",
        toolInput: { command: "git diff" },
        createdAt: 1,
      }],
    });
    source.reload();

    const second = source.getPendingPermissions()[0];
    assert.strictEqual(second, first);
    assert.deepStrictEqual(second.toolInput, { command: "git diff" });
  });

  it("does not collapse duplicate shape-key permissions in the same revision", (t) => {
    const dir = tempDir(t);
    const file = path.join(dir, "state.json");
    writeJson(file, {
      sessions: [{ id: "s1", title: "Repo", state: "working" }],
      permissions: [
        {
          sessionId: "s1",
          agentId: "claude-code",
          toolName: "Bash",
          toolInput: { command: "git status" },
          createdAt: 1,
        },
        {
          sessionId: "s1",
          agentId: "claude-code",
          toolName: "Bash",
          toolInput: { command: "git diff" },
          createdAt: 1,
        },
      ],
    });
    const source = new JsonFileHardwareBuddySource({ file, pollMs: 0 });

    source.start();
    const permissions = source.getPendingPermissions();

    assert.strictEqual(permissions.length, 2);
    assert.notStrictEqual(permissions[0], permissions[1]);
    assert.deepStrictEqual(permissions.map((entry) => entry.toolInput), [
      { command: "git status" },
      { command: "git diff" },
    ]);
  });

  it("rejects oversized source files without reading them", (t) => {
    const dir = tempDir(t);
    const file = path.join(dir, "state.json");
    const logs = [];
    fs.writeFileSync(file, JSON.stringify({
      sessions: [{ id: "s1", title: "Repo", state: "working" }],
    }), "utf8");
    const source = new JsonFileHardwareBuddySource({
      file,
      pollMs: 0,
      maxBytes: 4,
      log: (...args) => logs.push(args),
    });

    assert.strictEqual(source.reload(), false);
    assert.match(logs[0][1], /too large/);
    assert.strictEqual(source.getSessionSnapshot().sessions[0].displayTitle, "ClaudeBuddy Standalone");
    assert.strictEqual(DEFAULT_MAX_SOURCE_BYTES, 1024 * 1024);
  });
});
