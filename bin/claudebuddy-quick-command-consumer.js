#!/usr/bin/env node
"use strict";

const path = require("node:path");
const {
  controlUrlFromConfig,
  runQuickCommandJsonlConsumer,
} = require("../src/adapters/quick-command-http-jsonl-consumer");
const {
  createRuntimeConfig,
  parseRuntimeArgs,
} = require("../src/runtime/config");

function cleanString(value) {
  return typeof value === "string" ? value.trim() : "";
}

function splitArg(arg) {
  const idx = arg.indexOf("=");
  if (idx === -1) return { name: arg, value: undefined };
  return { name: arg.slice(0, idx), value: arg.slice(idx + 1) };
}

function parseConsumerArgs(argv = process.argv.slice(2)) {
  const input = {
    configPath: "",
    controlUrl: "",
    controlToken: "",
    actionFile: path.join("logs", "quick-command-actions.jsonl"),
    after: 0,
    limit: 100,
    waitMs: 30000,
    idleMs: null,
    once: false,
    maxEvents: 0,
    json: false,
    help: false,
  };
  const args = Array.from(argv);

  for (let i = 0; i < args.length; i += 1) {
    const { name, value } = splitArg(args[i]);
    const takeValue = () => {
      if (value !== undefined) return value;
      i += 1;
      if (i >= args.length) throw new Error(`${name} requires a value`);
      return args[i];
    };

    switch (name) {
      case "--help":
      case "-h":
        input.help = true;
        break;
      case "--config":
        input.configPath = takeValue();
        break;
      case "--control-url":
        input.controlUrl = takeValue();
        break;
      case "--control-token":
        input.controlToken = takeValue();
        break;
      case "--action-file":
        input.actionFile = path.resolve(takeValue());
        break;
      case "--after":
        input.after = takeValue();
        break;
      case "--limit":
        input.limit = takeValue();
        break;
      case "--wait-ms":
        input.waitMs = takeValue();
        break;
      case "--idle-ms":
        input.idleMs = takeValue();
        break;
      case "--once":
        input.once = true;
        break;
      case "--max-events":
        input.maxEvents = takeValue();
        break;
      case "--json":
        input.json = true;
        break;
      default:
        throw new Error(`unknown option: ${name}`);
    }
  }

  return input;
}

function formatConsumerHelp() {
  return [
    "Usage: claudebuddy-quick-command-consumer [options]",
    "",
    "Reference Quick Commands adapter consumer.",
    "",
    "Consumes /quick-commands over loopback HTTP and appends adapter-owned",
    "message, constraint, or local_action records as JSONL. It does not run",
    "workspace commands or inject text into any agent by itself.",
    "",
    "Options:",
    "  --config <path>          ClaudeBuddy runtime config for control URL/token",
    "  --control-url <url>      Override control URL",
    "  --control-token <token>  Override Bearer token",
    "  --action-file <path>     JSONL output file (default: logs/quick-command-actions.jsonl)",
    "  --after <seq>            Initial cursor (default: 0)",
    "  --limit <n>              Batch size (default: 100)",
    "  --wait-ms <ms>           Long-poll wait time (default: 30000)",
    "  --idle-ms <ms>           Delay after empty non-long-poll batches",
    "  --once                   Consume one batch and exit",
    "  --max-events <n>         Stop after at least n events; 0 means unlimited",
    "  --json                   Emit JSON summary",
    "  -h, --help               Show this help",
  ].join("\n");
}

function numberValue(value, fallback, { min = -Infinity, max = Infinity } = {}) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(n)));
}

async function main(argv = process.argv.slice(2), options = {}) {
  let args;
  try {
    args = parseConsumerArgs(argv);
  } catch (err) {
    const message = err && err.message ? err.message : String(err);
    (options.stderr || process.stderr).write(`${message}\n${formatConsumerHelp()}\n`);
    return 2;
  }

  if (args.help) {
    (options.stdout || process.stdout).write(`${formatConsumerHelp()}\n`);
    return 0;
  }

  let config = createRuntimeConfig({}, options.env || process.env);
  try {
    config = parseRuntimeArgs(cleanString(args.configPath) ? ["--config", args.configPath] : [], options.env || process.env, {
      cwd: options.cwd || process.cwd(),
    });
  } catch (err) {
    const message = err && err.message ? err.message : String(err);
    (options.stderr || process.stderr).write(`${message}\n`);
    return 2;
  }

  const controlUrl = cleanString(args.controlUrl) || controlUrlFromConfig(config);
  const token = cleanString(args.controlToken) || cleanString(config.controlToken);
  const actionFile = path.resolve(options.cwd || process.cwd(), args.actionFile);

  try {
    const result = await runQuickCommandJsonlConsumer({
      baseUrl: controlUrl,
      token,
      actionFile,
      after: numberValue(args.after, 0, { min: 0 }),
      limit: numberValue(args.limit, 100, { min: 1, max: 1000 }),
      waitMs: numberValue(args.waitMs, 30000, { min: 0, max: 60000 }),
      idleMs: args.idleMs === null ? undefined : numberValue(args.idleMs, 0, { min: 0 }),
      once: args.once,
      maxEvents: numberValue(args.maxEvents, 0, { min: 0 }),
      fetch: options.fetch,
      fs: options.fs,
      now: options.now,
    });
    if (args.json) {
      (options.stdout || process.stdout).write(`${JSON.stringify({
        ok: true,
        controlUrl,
        actionFile,
        after: result.after,
        total: result.total,
        batches: result.batches.map((batch) => ({
          cursor: batch.cursor,
          nextCursor: batch.nextCursor,
          count: batch.count,
          written: batch.written,
        })),
      })}\n`);
    } else {
      (options.stdout || process.stdout).write(`Consumed ${result.total} quick command(s); cursor=${result.after}\n`);
    }
    return 0;
  } catch (err) {
    const message = err && err.message ? err.message : String(err);
    (options.stderr || process.stderr).write(`${message}\n`);
    return 1;
  }
}

if (require.main === module) {
  main().then((code) => {
    process.exitCode = code;
  }, (err) => {
    console.error(err && err.stack ? err.stack : String(err));
    process.exitCode = 1;
  });
}

module.exports = {
  formatConsumerHelp,
  main,
  parseConsumerArgs,
};
