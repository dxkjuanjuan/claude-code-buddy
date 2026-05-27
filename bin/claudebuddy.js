#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const {
  HeadlessHardwareBuddyRuntime,
  formatRuntimeHelp,
  parseRuntimeArgs,
} = require("../src");

const LOG_LEVEL_WEIGHT = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
  silent: Infinity,
};

function normalizeLogLevel(level, fallback = "info") {
  const clean = typeof level === "string" ? level.trim().toLowerCase() : "";
  return Object.prototype.hasOwnProperty.call(LOG_LEVEL_WEIGHT, clean) ? clean : fallback;
}

function shouldLog(level, configuredLevel = "info") {
  const normalizedLevel = normalizeLogLevel(level);
  const normalizedConfiguredLevel = normalizeLogLevel(configuredLevel);
  return LOG_LEVEL_WEIGHT[normalizedLevel] >= LOG_LEVEL_WEIGHT[normalizedConfiguredLevel];
}

function writeLine(stream, fallback, line) {
  if (stream && typeof stream.write === "function") {
    stream.write(`${line}\n`);
    return;
  }
  fallback(line);
}

function cleanPath(value) {
  return typeof value === "string" ? value.trim() : "";
}

function createLogFileStream(logFile, options = {}) {
  const clean = cleanPath(logFile);
  if (!clean) return null;
  const cwd = options.cwd || process.cwd();
  const resolved = path.resolve(cwd, clean);
  const dir = path.dirname(resolved);
  fs.mkdirSync(dir, { recursive: true });
  return fs.createWriteStream(resolved, {
    flags: "a",
    encoding: "utf8",
  });
}

function closeLogFileStream(stream) {
  if (!stream || typeof stream.end !== "function") return Promise.resolve();
  return new Promise((resolve) => {
    let settled = false;
    const done = () => {
      if (settled) return;
      settled = true;
      resolve();
    };
    if (typeof stream.once === "function") {
      stream.once("error", done);
    }
    stream.end(done);
  });
}

function createConsoleLogger(config = {}, options = {}) {
  const stdout = options.stdout;
  const stderr = options.stderr;
  const logFileStream = options.logFileStream || null;
  const now = typeof options.now === "function" ? options.now : () => new Date();

  return (level, message, meta) => {
    const normalizedLevel = normalizeLogLevel(level);
    if (!shouldLog(normalizedLevel, config.logLevel)) return;

    const metaSuffix = !config.jsonLogs && meta && typeof meta === "object"
      ? [
        typeof meta.code === "string" && meta.code ? `code=${meta.code}` : "",
        meta.message && meta.message !== message ? `detail=${meta.message}` : "",
      ].filter(Boolean).join(" ")
      : "";
    const record = {
      level: normalizedLevel,
      message: metaSuffix ? `${String(message || "")} (${metaSuffix})` : String(message || ""),
      ...(meta && config.jsonLogs ? { meta } : {}),
    };
    const line = config.jsonLogs
      ? JSON.stringify({ time: now().toISOString(), ...record })
      : `[${record.level}] ${record.message}`;
    writeLine(logFileStream, () => {}, line);
    if (record.level === "error" || record.level === "warn") {
      writeLine(stderr, console.error, line);
    } else {
      writeLine(stdout, console.log, line);
    }
  };
}

function armShutdownWatchdog(ms, options = {}) {
  if (!Number.isFinite(ms) || ms <= 0) return null;
  const setTimer = typeof options.setTimeout === "function" ? options.setTimeout : setTimeout;
  const exit = typeof options.exit === "function" ? options.exit : (code) => process.exit(code);
  const timer = setTimer(() => {
    exit(0);
  }, ms);
  if (typeof timer.unref === "function") timer.unref();
  return timer;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function waitForShutdownSignal({ processLike, runtime, config, log, setTimeout: setTimer, clearTimeout: clearTimer }) {
  return new Promise((resolve) => {
    let stopping = false;
    let watchdog = null;

    const cleanup = () => {
      if (processLike && typeof processLike.removeListener === "function") {
        processLike.removeListener("SIGINT", onSignal);
        processLike.removeListener("SIGTERM", onSignal);
      }
    };

    const finish = (code) => {
      cleanup();
      resolve(code);
    };

    const onSignal = (signal) => {
      if (stopping) return;
      stopping = true;
      if (processLike) processLike.exitCode = 0;
      log("info", `shutdown requested by ${signal}`);
      watchdog = armShutdownWatchdog(config.shutdownTimeoutMs, {
        setTimeout: setTimer,
        exit: (code) => {
          if (processLike && typeof processLike.exit === "function") {
            processLike.exit(code);
          } else {
            process.exit(code);
          }
        },
      });

      Promise.resolve()
        .then(() => runtime.stop())
        .then(() => {
          if (watchdog && typeof clearTimer === "function") clearTimer(watchdog);
          finish(0);
        }, (err) => {
          const message = err && err.message ? err.message : String(err);
          log("error", `shutdown failed: ${message}`, err);
          finish(1);
        });
    };

    if (processLike && typeof processLike.on === "function") {
      processLike.on("SIGINT", onSignal);
      processLike.on("SIGTERM", onSignal);
      return;
    }

    finish(0);
  });
}

async function main(argv = process.argv.slice(2), options = {}) {
  const processLike = options.process || process;
  const env = options.env || process.env;
  const cwd = options.cwd || process.cwd();
  const setTimer = typeof options.setTimeout === "function" ? options.setTimeout : setTimeout;
  const clearTimer = typeof options.clearTimeout === "function" ? options.clearTimeout : clearTimeout;
  const delayFn = typeof options.delay === "function" ? options.delay : delay;
  let config;
  try {
    config = parseRuntimeArgs(argv, env, { cwd });
  } catch (err) {
    writeLine(options.stderr, console.error, err.message);
    writeLine(options.stderr, console.error, formatRuntimeHelp());
    return 2;
  }

  if (config.help) {
    writeLine(options.stdout, console.log, formatRuntimeHelp());
    return 0;
  }

  let logFileStream = null;
  try {
    logFileStream = options.logFileStream || createLogFileStream(config.logFile, { cwd });
  } catch (err) {
    const message = err && err.message ? err.message : String(err);
    writeLine(options.stderr, console.error, `failed to open log file: ${message}`);
    return 2;
  }

  const log = createConsoleLogger(config, {
    stdout: options.stdout,
    stderr: options.stderr,
    logFileStream,
    now: options.now,
  });
  const createRuntime = typeof options.createRuntime === "function"
    ? options.createRuntime
    : (runtimeOptions) => new HeadlessHardwareBuddyRuntime(runtimeOptions);
  const runtime = createRuntime({
    config,
    log,
  });

  try {
    runtime.start();

    if (config.once) {
      await delayFn(config.onceMs);
      await Promise.resolve(runtime.stop());
      await closeLogFileStream(logFileStream);
      return 0;
    }

    const code = await waitForShutdownSignal({
      processLike,
      runtime,
      config,
      log,
      setTimeout: setTimer,
      clearTimeout: clearTimer,
    });
    await closeLogFileStream(logFileStream);
    return code;
  } catch (err) {
    await closeLogFileStream(logFileStream);
    throw err;
  }
}

if (require.main === module) {
  main().then((code) => {
    if (Number.isInteger(code)) process.exitCode = code;
  }, (err) => {
    console.error(err && err.stack ? err.stack : String(err));
    process.exitCode = 1;
  });
}

module.exports = {
  LOG_LEVEL_WEIGHT,
  armShutdownWatchdog,
  closeLogFileStream,
  createConsoleLogger,
  createLogFileStream,
  main,
  normalizeLogLevel,
  shouldLog,
  waitForShutdownSignal,
};
