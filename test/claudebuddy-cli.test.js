"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert");
const { EventEmitter } = require("node:events");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
  armShutdownWatchdog,
  closeLogFileStream,
  createConsoleLogger,
  createLogFileStream,
  main,
  normalizeLogLevel,
  shouldLog,
} = require("../bin/claudebuddy");

function makeStream() {
  return {
    lines: [],
    write(line) {
      this.lines.push(String(line).replace(/\n$/, ""));
    },
  };
}

function makeProcess() {
  const processLike = new EventEmitter();
  processLike.exitCode = undefined;
  processLike.exits = [];
  processLike.exit = (code) => {
    processLike.exits.push(code);
  };
  return processLike;
}

describe("claudebuddy CLI", () => {
  it("normalizes and filters log levels", () => {
    assert.strictEqual(normalizeLogLevel("warn"), "warn");
    assert.strictEqual(normalizeLogLevel("wat"), "info");
    assert.strictEqual(shouldLog("warn", "info"), true);
    assert.strictEqual(shouldLog("info", "warn"), false);
    assert.strictEqual(shouldLog("error", "silent"), false);
  });

  it("routes text logs by level and honors logLevel", () => {
    const stdout = makeStream();
    const stderr = makeStream();
    const logger = createConsoleLogger({ logLevel: "warn" }, { stdout, stderr });

    logger("debug", "hidden");
    logger("info", "also hidden");
    logger("warn", "retry scheduled", { code: "NO_DEVICE" });
    logger("error", "sidecar failed", { message: "spawn failed" });

    assert.deepStrictEqual(stdout.lines, []);
    assert.deepStrictEqual(stderr.lines, [
      "[warn] retry scheduled (code=NO_DEVICE)",
      "[error] sidecar failed (detail=spawn failed)",
    ]);
  });

  it("tees emitted logs to a log file stream", () => {
    const stdout = makeStream();
    const stderr = makeStream();
    const logFile = makeStream();
    const logger = createConsoleLogger({ logLevel: "info" }, { stdout, stderr, logFileStream: logFile });

    logger("info", "started");
    logger("warn", "retry");

    assert.deepStrictEqual(stdout.lines, ["[info] started"]);
    assert.deepStrictEqual(stderr.lines, ["[warn] retry"]);
    assert.deepStrictEqual(logFile.lines, ["[info] started", "[warn] retry"]);
  });

  it("emits JSON logs with metadata when requested", () => {
    const stdout = makeStream();
    const logger = createConsoleLogger({
      jsonLogs: true,
      logLevel: "debug",
    }, {
      stdout,
      now: () => new Date("2026-05-18T00:00:00.000Z"),
    });

    logger("info", "status", { connected: true });

    assert.strictEqual(stdout.lines.length, 1);
    assert.deepStrictEqual(JSON.parse(stdout.lines[0]), {
      time: "2026-05-18T00:00:00.000Z",
      level: "info",
      message: "status",
      meta: { connected: true },
    });
  });

  it("arms a shutdown watchdog that can force process exit", () => {
    const timers = [];
    const exits = [];
    const timer = armShutdownWatchdog(25, {
      setTimeout: (fn, ms) => {
        const handle = {
          ms,
          unrefCalled: false,
          unref() {
            this.unrefCalled = true;
          },
        };
        timers.push({ fn, handle });
        return handle;
      },
      exit: (code) => exits.push(code),
    });

    assert.strictEqual(timer.ms, 25);
    assert.strictEqual(timer.unrefCalled, true);
    timers[0].fn();
    assert.deepStrictEqual(exits, [0]);
  });

  it("creates parent directories for log files", async (t) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "claudebuddy-log-file-"));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const logPath = path.join(dir, "nested", "daemon.log");

    const stream = createLogFileStream(logPath);
    stream.write("line 1\n");
    await closeLogFileStream(stream);

    assert.strictEqual(fs.readFileSync(logPath, "utf8"), "line 1\n");
  });

  it("resolves closeLogFileStream when the stream errors during shutdown", async () => {
    const stream = new EventEmitter();
    stream.end = () => {
      stream.emit("error", new Error("flush failed"));
    };

    await closeLogFileStream(stream);
  });

  it("runs until SIGTERM and then stops the runtime", async () => {
    const processLike = makeProcess();
    const stdout = makeStream();
    const stderr = makeStream();
    const calls = [];
    const timers = [];
    const cleared = [];
    const runtime = {
      start() {
        calls.push("start");
      },
      stop() {
        calls.push("stop");
      },
    };

    const resultPromise = main(["--transport", "fake"], {
      process: processLike,
      stdout,
      stderr,
      createRuntime: () => runtime,
      setTimeout: (fn, ms) => {
        const handle = {
          ms,
          unref() {},
        };
        timers.push({ fn, handle });
        return handle;
      },
      clearTimeout: (handle) => {
        cleared.push(handle);
      },
    });

    assert.deepStrictEqual(calls, ["start"]);
    processLike.emit("SIGTERM", "SIGTERM");

    const code = await resultPromise;

    assert.strictEqual(code, 0);
    assert.strictEqual(processLike.exitCode, 0);
    assert.deepStrictEqual(calls, ["start", "stop"]);
    assert.strictEqual(timers.length, 1);
    assert.strictEqual(timers[0].handle.ms, 1500);
    assert.deepStrictEqual(cleared, [timers[0].handle]);
    assert.deepStrictEqual(stderr.lines, []);
    assert.match(stdout.lines.join("\n"), /shutdown requested by SIGTERM/);
  });

  it("writes shutdown logs to --log-file", async (t) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "claudebuddy-main-log-file-"));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const logPath = path.join(dir, "daemon.log");
    const processLike = makeProcess();
    const calls = [];
    const runtime = {
      start() {
        calls.push("start");
      },
      stop() {
        calls.push("stop");
      },
    };

    const resultPromise = main(["--transport", "fake", "--log-file", logPath], {
      process: processLike,
      stdout: makeStream(),
      stderr: makeStream(),
      createRuntime: () => runtime,
      setTimeout: (fn, ms) => ({
        ms,
        unref() {},
        close() {},
      }),
    });
    processLike.emit("SIGTERM", "SIGTERM");

    const code = await resultPromise;

    assert.strictEqual(code, 0);
    assert.deepStrictEqual(calls, ["start", "stop"]);
    assert.match(fs.readFileSync(logPath, "utf8"), /shutdown requested by SIGTERM/);
  });

  it("closes the log file stream if runtime startup throws", async () => {
    let closed = false;
    const logFileStream = {
      write() {},
      end(callback) {
        closed = true;
        callback();
      },
    };

    await assert.rejects(() => main(["--transport", "fake"], {
      logFileStream,
      createRuntime: () => ({
        start() {
          throw new Error("boom");
        },
      }),
    }), /boom/);
    assert.strictEqual(closed, true);
  });

  it("stops once mode without installing a long-running signal wait", async () => {
    const processLike = makeProcess();
    const calls = [];
    const runtime = {
      start() {
        calls.push("start");
      },
      stop() {
        calls.push("stop");
      },
    };

    const code = await main(["--transport", "fake", "--once", "--once-ms", "5"], {
      process: processLike,
      createRuntime: () => runtime,
      delay: (ms) => {
        calls.push(`delay:${ms}`);
        return Promise.resolve();
      },
    });

    assert.strictEqual(code, 0);
    assert.deepStrictEqual(calls, ["start", "delay:5", "stop"]);
    assert.strictEqual(processLike.listenerCount("SIGINT"), 0);
    assert.strictEqual(processLike.listenerCount("SIGTERM"), 0);
  });
});
