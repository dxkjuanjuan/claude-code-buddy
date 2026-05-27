"use strict";

const fs = require("node:fs");
const path = require("node:path");

const DEFAULT_CONFIG_FILENAME = "claudebuddy.config.json";
const VALID_TRANSPORTS = new Set(["fake", "sidecar"]);
const VALID_BACKENDS = new Set(["fake", "bleak"]);
const VALID_LOG_LEVELS = new Set(["debug", "info", "warn", "error", "silent"]);
const VALID_SOURCES = new Set(["static", "json-file", "stdin-jsonl"]);
const VALID_REPLY_MODES = new Set(["none", "jsonl"]);
const VALID_QUICK_COMMAND_CONSUMERS = new Set(["none", "jsonl"]);
const VALID_CONFIG_KEYS = new Set([
  "$schema",
  "source",
  "sourceFile",
  "sourceMaxBytes",
  "sourcePollMs",
  "transport",
  "backend",
  "python",
  "pythonCommand",
  "sidecarScript",
  "address",
  "id",
  "name",
  "namePrefix",
  "scanTimeout",
  "connectTimeout",
  "pair",
  "fakeSecure",
  "permissionReplies",
  "autoConnect",
  "keepaliveMs",
  "pollStatusMs",
  "sourceTitle",
  "title",
  "sourceState",
  "state",
  "doNotDisturb",
  "dnd",
  "once",
  "onceMs",
  "shutdownTimeoutMs",
  "json",
  "jsonLogs",
  "logFile",
  "replyMode",
  "replyFile",
  "replyBufferSize",
  "quickCommands",
  "quickCommandBufferSize",
  "quickCommandDedupeMs",
  "quickCommandConsumer",
  "quickCommandConsumerFile",
  "control",
  "controlServer",
  "httpControl",
  "controlHost",
  "controlPort",
  "controlToken",
  "controlMaxBodyBytes",
  "diagnoseSidecarContention",
  "sidecarDiagnostics",
  "retry",
  "retryEnabled",
  "retryInitialMs",
  "retryMaxMs",
  "retryBackoffFactor",
  "retryMaxAttempts",
  "logLevel",
]);

function cleanString(value) {
  return typeof value === "string" ? value.trim() : "";
}

function choice(value, allowed, fallback, label) {
  const clean = cleanString(value) || fallback;
  if (!allowed.has(clean)) {
    throw new Error(`${label} must be one of: ${[...allowed].join(", ")}`);
  }
  return clean;
}

function boolValue(value, fallback = false) {
  if (value == null) return fallback;
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0;
  const clean = cleanString(value).toLowerCase();
  if (["1", "true", "yes", "on"].includes(clean)) return true;
  if (["0", "false", "no", "off"].includes(clean)) return false;
  return fallback;
}

function numberValue(value, fallback, { min = -Infinity } = {}) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, n);
}

function integerValue(value, fallback, { min = -Infinity } = {}) {
  return Math.floor(numberValue(value, fallback, { min }));
}

function defaultSidecarScript() {
  return path.resolve(__dirname, "..", "..", "tools", "hardware_buddy_bridge.py");
}

function inputHas(input, key) {
  return Object.prototype.hasOwnProperty.call(input, key);
}

function firstDefined(input, keys, fallback) {
  for (const key of keys) {
    if (inputHas(input, key) && input[key] !== undefined) return input[key];
  }
  return fallback;
}

function normalizeRuntimeInput(input = {}, { baseDir } = {}) {
  const normalized = { ...input };
  if (inputHas(normalized, "python") && !inputHas(normalized, "pythonCommand")) {
    normalized.pythonCommand = normalized.python;
  }
  if (inputHas(normalized, "title") && !inputHas(normalized, "sourceTitle")) {
    normalized.sourceTitle = normalized.title;
  }
  if (inputHas(normalized, "state") && !inputHas(normalized, "sourceState")) {
    normalized.sourceState = normalized.state;
  }
  if (inputHas(normalized, "dnd") && !inputHas(normalized, "doNotDisturb")) {
    normalized.doNotDisturb = normalized.dnd;
  }
  if (inputHas(normalized, "json") && !inputHas(normalized, "jsonLogs")) {
    normalized.jsonLogs = normalized.json;
  }
  if (inputHas(normalized, "sidecarDiagnostics") && !inputHas(normalized, "diagnoseSidecarContention")) {
    normalized.diagnoseSidecarContention = normalized.sidecarDiagnostics;
  }
  if (inputHas(normalized, "httpControl") && !inputHas(normalized, "controlServer")) {
    normalized.controlServer = normalized.httpControl;
  }
  if (inputHas(normalized, "control") && !inputHas(normalized, "controlServer")) {
    normalized.controlServer = normalized.control;
  }
  if (baseDir && cleanString(normalized.sidecarScript) && !path.isAbsolute(normalized.sidecarScript)) {
    normalized.sidecarScript = path.resolve(baseDir, normalized.sidecarScript);
  }
  if (baseDir && cleanString(normalized.logFile) && !path.isAbsolute(normalized.logFile)) {
    normalized.logFile = path.resolve(baseDir, normalized.logFile);
  }
  if (baseDir && cleanString(normalized.replyFile) && !path.isAbsolute(normalized.replyFile)) {
    normalized.replyFile = path.resolve(baseDir, normalized.replyFile);
  }
  if (baseDir && cleanString(normalized.quickCommandConsumerFile) && !path.isAbsolute(normalized.quickCommandConsumerFile)) {
    normalized.quickCommandConsumerFile = path.resolve(baseDir, normalized.quickCommandConsumerFile);
  }
  if (baseDir && cleanString(normalized.sourceFile) && !path.isAbsolute(normalized.sourceFile)) {
    normalized.sourceFile = path.resolve(baseDir, normalized.sourceFile);
  }
  return normalized;
}

function createRuntimeConfig(input = {}, env = process.env) {
  const normalizedInput = normalizeRuntimeInput(input);
  const source = choice(normalizedInput.source, VALID_SOURCES, "static", "source");
  const transport = choice(normalizedInput.transport, VALID_TRANSPORTS, "fake", "transport");
  const backend = choice(normalizedInput.backend, VALID_BACKENDS, "fake", "backend");
  const sourceFile = cleanString(normalizedInput.sourceFile)
    ? path.resolve(normalizedInput.sourceFile)
    : "";
  if (source === "json-file" && !sourceFile) {
    throw new Error("sourceFile is required when source is json-file");
  }
  const sidecarScript = cleanString(normalizedInput.sidecarScript)
    ? path.resolve(normalizedInput.sidecarScript)
    : defaultSidecarScript();
  const replyFile = cleanString(normalizedInput.replyFile)
    ? path.resolve(normalizedInput.replyFile)
    : "";
  const replyMode = choice(normalizedInput.replyMode, VALID_REPLY_MODES, replyFile ? "jsonl" : "none", "replyMode");
  if (replyMode === "jsonl" && !replyFile) {
    throw new Error("replyFile is required when replyMode is jsonl");
  }
  const diagnoseSidecarContention = boolValue(firstDefined(
    normalizedInput,
    ["sidecarDiagnostics", "diagnoseSidecarContention"],
    undefined,
  ), true);
  const retryEnabled = boolValue(firstDefined(
    normalizedInput,
    ["retryEnabled", "retry"],
    undefined,
  ), true);
  const controlServer = boolValue(firstDefined(
    normalizedInput,
    ["controlServer", "httpControl", "control"],
    undefined,
  ), false);
  const quickCommands = boolValue(normalizedInput.quickCommands, false);
  const quickCommandConsumerFileInput = cleanString(normalizedInput.quickCommandConsumerFile);
  const quickCommandConsumer = choice(
    normalizedInput.quickCommandConsumer,
    VALID_QUICK_COMMAND_CONSUMERS,
    quickCommandConsumerFileInput ? "jsonl" : "none",
    "quickCommandConsumer",
  );
  const quickCommandConsumerFile = quickCommandConsumer === "jsonl"
    ? path.resolve(quickCommandConsumerFileInput || path.join("logs", "quick-commands-consumed.jsonl"))
    : "";

  return {
    source,
    sourceFile,
    sourceMaxBytes: integerValue(normalizedInput.sourceMaxBytes, 1024 * 1024, { min: 1 }),
    sourcePollMs: integerValue(normalizedInput.sourcePollMs, 1000, { min: 0 }),
    transport,
    backend,
    pythonCommand: cleanString(normalizedInput.pythonCommand || env.PYTHON) || "python",
    sidecarScript,
    address: cleanString(normalizedInput.address),
    id: cleanString(normalizedInput.id),
    name: cleanString(normalizedInput.name),
    namePrefix: cleanString(normalizedInput.namePrefix) || "Claude",
    scanTimeout: numberValue(normalizedInput.scanTimeout, 5, { min: 0.5 }),
    connectTimeout: numberValue(normalizedInput.connectTimeout, 10, { min: 1 }),
    pair: boolValue(normalizedInput.pair, false),
    fakeSecure: boolValue(normalizedInput.fakeSecure, true),
    permissionReplies: boolValue(normalizedInput.permissionReplies, false),
    autoConnect: boolValue(normalizedInput.autoConnect, true),
    keepaliveMs: integerValue(normalizedInput.keepaliveMs, 10000, { min: 0 }),
    pollStatusMs: integerValue(normalizedInput.pollStatusMs, transport === "sidecar" ? 5000 : 0, { min: 0 }),
    sourceTitle: cleanString(normalizedInput.sourceTitle) || "ClaudeBuddy Standalone",
    sourceState: cleanString(normalizedInput.sourceState) || "working",
    doNotDisturb: boolValue(normalizedInput.doNotDisturb, false),
    once: boolValue(normalizedInput.once, false),
    onceMs: integerValue(normalizedInput.onceMs, transport === "sidecar" && backend === "bleak" ? 3000 : 250, { min: 0 }),
    shutdownTimeoutMs: integerValue(normalizedInput.shutdownTimeoutMs, 1500, { min: 0 }),
    jsonLogs: boolValue(normalizedInput.jsonLogs, false),
    logFile: cleanString(normalizedInput.logFile)
      ? path.resolve(normalizedInput.logFile)
      : "",
    replyMode,
    replyFile,
    replyBufferSize: integerValue(normalizedInput.replyBufferSize, 100, { min: 1 }),
    quickCommands,
    quickCommandBufferSize: integerValue(normalizedInput.quickCommandBufferSize, 100, { min: 1 }),
    quickCommandDedupeMs: integerValue(normalizedInput.quickCommandDedupeMs, 30000, { min: 0 }),
    quickCommandConsumer,
    quickCommandConsumerFile,
    controlServer,
    control: controlServer,
    httpControl: controlServer,
    controlHost: cleanString(normalizedInput.controlHost) || "127.0.0.1",
    controlPort: integerValue(normalizedInput.controlPort, 27217, { min: 0 }),
    controlToken: cleanString(normalizedInput.controlToken),
    controlMaxBodyBytes: integerValue(normalizedInput.controlMaxBodyBytes, 1024 * 1024, { min: 1 }),
    diagnoseSidecarContention,
    sidecarDiagnostics: diagnoseSidecarContention,
    retryEnabled,
    retry: retryEnabled,
    retryInitialMs: integerValue(normalizedInput.retryInitialMs, 1000, { min: 0 }),
    retryMaxMs: integerValue(normalizedInput.retryMaxMs, 15000, { min: 0 }),
    retryBackoffFactor: numberValue(normalizedInput.retryBackoffFactor, 2, { min: 1 }),
    retryMaxAttempts: integerValue(normalizedInput.retryMaxAttempts, 0, { min: 0 }),
    logLevel: choice(normalizedInput.logLevel, VALID_LOG_LEVELS, "info", "logLevel"),
    help: boolValue(normalizedInput.help, false),
    configPath: cleanString(normalizedInput.configPath),
  };
}

function splitArg(arg) {
  const idx = arg.indexOf("=");
  if (idx === -1) return { name: arg, value: undefined };
  return { name: arg.slice(0, idx), value: arg.slice(idx + 1) };
}

function parseRuntimeArgInput(argv = process.argv.slice(2)) {
  const input = {};
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
      case "--source":
        input.source = takeValue();
        break;
      case "--source-file":
        input.sourceFile = takeValue();
        break;
      case "--source-max-bytes":
        input.sourceMaxBytes = takeValue();
        break;
      case "--source-poll-ms":
        input.sourcePollMs = takeValue();
        break;
      case "--transport":
        input.transport = takeValue();
        break;
      case "--backend":
        input.backend = takeValue();
        break;
      case "--python":
        input.pythonCommand = takeValue();
        break;
      case "--sidecar-script":
        input.sidecarScript = takeValue();
        break;
      case "--address":
        input.address = takeValue();
        break;
      case "--id":
        input.id = takeValue();
        break;
      case "--name":
        input.name = takeValue();
        break;
      case "--name-prefix":
        input.namePrefix = takeValue();
        break;
      case "--scan-timeout":
        input.scanTimeout = takeValue();
        break;
      case "--connect-timeout":
        input.connectTimeout = takeValue();
        break;
      case "--pair":
        input.pair = true;
        break;
      case "--fake-secure":
        input.fakeSecure = takeValue();
        break;
      case "--no-fake-secure":
        input.fakeSecure = false;
        break;
      case "--permission-replies":
        input.permissionReplies = true;
        break;
      case "--no-permission-replies":
        input.permissionReplies = false;
        break;
      case "--auto-connect":
        input.autoConnect = true;
        break;
      case "--no-auto-connect":
        input.autoConnect = false;
        break;
      case "--keepalive-ms":
        input.keepaliveMs = takeValue();
        break;
      case "--poll-status-ms":
        input.pollStatusMs = takeValue();
        break;
      case "--title":
        input.sourceTitle = takeValue();
        break;
      case "--state":
        input.sourceState = takeValue();
        break;
      case "--dnd":
        input.doNotDisturb = true;
        break;
      case "--no-dnd":
        input.doNotDisturb = false;
        break;
      case "--once":
        input.once = true;
        break;
      case "--no-once":
        input.once = false;
        break;
      case "--once-ms":
        input.onceMs = takeValue();
        break;
      case "--shutdown-timeout-ms":
        input.shutdownTimeoutMs = takeValue();
        break;
      case "--json":
        input.jsonLogs = true;
        break;
      case "--json-logs":
        if (value !== undefined) input.jsonLogs = value;
        else if (i + 1 < args.length && !String(args[i + 1]).startsWith("-")) input.jsonLogs = takeValue();
        else input.jsonLogs = true;
        break;
      case "--no-json":
      case "--no-json-logs":
        input.jsonLogs = false;
        break;
      case "--log-file":
        input.logFile = takeValue();
        break;
      case "--reply-mode":
        input.replyMode = takeValue();
        break;
      case "--reply-file":
        input.replyFile = takeValue();
        break;
      case "--reply-buffer-size":
        input.replyBufferSize = takeValue();
        break;
      case "--quick-commands":
        input.quickCommands = true;
        break;
      case "--no-quick-commands":
        input.quickCommands = false;
        break;
      case "--quick-command-buffer-size":
        input.quickCommandBufferSize = takeValue();
        break;
      case "--quick-command-dedupe-ms":
        input.quickCommandDedupeMs = takeValue();
        break;
      case "--quick-command-consumer":
        input.quickCommandConsumer = takeValue();
        break;
      case "--quick-command-consumer-file":
        input.quickCommandConsumerFile = takeValue();
        break;
      case "--control":
      case "--control-server":
      case "--http-control":
        input.controlServer = true;
        break;
      case "--no-control":
      case "--no-control-server":
      case "--no-http-control":
        input.controlServer = false;
        break;
      case "--control-host":
        input.controlHost = takeValue();
        break;
      case "--control-port":
        input.controlPort = takeValue();
        break;
      case "--control-token":
        input.controlToken = takeValue();
        break;
      case "--control-max-body-bytes":
        input.controlMaxBodyBytes = takeValue();
        break;
      case "--sidecar-diagnostics":
        input.sidecarDiagnostics = takeValue();
        input.diagnoseSidecarContention = input.sidecarDiagnostics;
        break;
      case "--no-sidecar-diagnostics":
        input.sidecarDiagnostics = false;
        input.diagnoseSidecarContention = false;
        break;
      case "--retry":
        input.retryEnabled = true;
        break;
      case "--no-retry":
        input.retryEnabled = false;
        break;
      case "--retry-initial-ms":
        input.retryInitialMs = takeValue();
        break;
      case "--retry-max-ms":
        input.retryMaxMs = takeValue();
        break;
      case "--retry-backoff-factor":
        input.retryBackoffFactor = takeValue();
        break;
      case "--retry-max-attempts":
        input.retryMaxAttempts = takeValue();
        break;
      case "--log-level":
        input.logLevel = takeValue();
        break;
      case "--verbose":
        input.logLevel = "debug";
        break;
      case "--quiet":
        input.logLevel = "warn";
        break;
      default:
        throw new Error(`unknown option: ${name}`);
    }
  }

  return input;
}

function resolveConfigPath(configPath, { cwd = process.cwd() } = {}) {
  const clean = cleanString(configPath);
  if (!clean) throw new Error("--config requires a value");
  return path.resolve(cwd, clean);
}

function readRuntimeConfigFile(configPath, options = {}) {
  const resolved = resolveConfigPath(configPath, options);
  let raw;
  try {
    raw = fs.readFileSync(resolved, "utf8");
  } catch (err) {
    if (err && err.code === "ENOENT") {
      throw new Error(`config file not found: ${resolved}`);
    }
    const message = err && err.message ? err.message : String(err);
    throw new Error(`failed to read config file ${resolved}: ${message}`);
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    const message = err && err.message ? err.message : String(err);
    throw new Error(`invalid config JSON in ${resolved}: ${message}`);
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`config file must contain a JSON object: ${resolved}`);
  }

  const unknownKeys = Object.keys(parsed).filter((key) => !VALID_CONFIG_KEYS.has(key));
  if (unknownKeys.length > 0) {
    throw new Error(`unknown config key${unknownKeys.length === 1 ? "" : "s"} in ${resolved}: ${unknownKeys.join(", ")}`);
  }

  return {
    path: resolved,
    input: normalizeRuntimeInput(parsed, { baseDir: path.dirname(resolved) }),
  };
}

function findDefaultRuntimeConfig({ cwd = process.cwd() } = {}) {
  const configPath = path.resolve(cwd, DEFAULT_CONFIG_FILENAME);
  return fs.existsSync(configPath) ? configPath : null;
}

function parseRuntimeArgs(argv = process.argv.slice(2), env = process.env, options = {}) {
  const cliInput = parseRuntimeArgInput(argv);
  if (cliInput.help) return createRuntimeConfig(cliInput, env);

  const cwd = options.cwd || process.cwd();
  const explicitConfigPath = inputHas(cliInput, "configPath");
  const configPath = explicitConfigPath
    ? resolveConfigPath(cliInput.configPath, { cwd })
    : findDefaultRuntimeConfig({ cwd });
  let fileInput = {};
  let loadedConfigPath = "";

  if (configPath) {
    const loaded = readRuntimeConfigFile(configPath, { cwd });
    fileInput = loaded.input;
    loadedConfigPath = loaded.path;
  }

  const mergedInput = {
    ...fileInput,
    ...cliInput,
    configPath: loadedConfigPath,
  };

  return createRuntimeConfig(mergedInput, env);
}

function formatRuntimeHelp() {
  return [
    "Usage: claudebuddy [options]",
    "",
    "Standalone/headless Hardware Buddy runtime.",
    "",
    "Options:",
    `  --config <path>               Config file (default: ./${DEFAULT_CONFIG_FILENAME} if present)`,
    "  --source static|json-file|stdin-jsonl",
    "                                Source input mode (default: static)",
    "  --source-file <path>           JSON source file for --source json-file",
    "  --source-max-bytes <bytes>     Maximum JSON source file size or JSONL line size",
    "  --source-poll-ms <ms>          JSON source file poll interval",
    "  --transport fake|sidecar       Runtime transport (default: fake)",
    "  --backend fake|bleak           Python sidecar backend (default: fake)",
    "  --python <command>             Python command for the sidecar",
    "  --sidecar-script <path>        Python sidecar script path",
    "  --address <addr>               Device address for sidecar connect",
    "  --id <id>                      Device id for sidecar connect",
    "  --name <name>                  Device name for sidecar connect",
    "  --name-prefix <prefix>         BLE scan name prefix (default: Claude)",
    "  --scan-timeout <sec>           BLE scan timeout",
    "  --connect-timeout <sec>        BLE connect timeout",
    "  --pair                         Ask bleak to initiate best-effort pairing",
    "  --fake-secure true|false       Fake backend secure-link state",
    "  --no-fake-secure               Make the fake backend report insecure",
    "  --permission-replies           Allow hardware permission replies",
    "  --no-permission-replies        Disable hardware permission replies",
    "  --auto-connect                 Start with scan/connect enabled",
    "  --no-auto-connect              Start without scan/connect",
    "  --keepalive-ms <ms>            Controller keepalive interval",
    "  --poll-status-ms <ms>          Sidecar status poll interval",
    "  --title <text>                 Fake source session title",
    "  --state <state>                Fake source session state",
    "  --dnd                          Suppress hardware prompts",
    "  --no-dnd                       Allow hardware prompts when otherwise eligible",
    "  --once                         Start briefly, emit, then stop",
    "  --no-once                      Disable one-shot mode from config",
    "  --once-ms <ms>                 Runtime duration for --once",
    "  --shutdown-timeout-ms <ms>     Signal shutdown watchdog timeout",
    "  --json                         Emit JSON logs",
    "  --no-json                      Disable JSON logs from config",
    "  --log-file <path>              Append emitted logs to a file",
    "  --reply-mode none|jsonl        Permission reply output mode",
    "  --reply-file <path>            Append permission replies as JSONL",
    "  --reply-buffer-size <n>        In-memory HTTP reply buffer size",
    "  --quick-commands               Enable quick-command control endpoints",
    "  --no-quick-commands            Disable quick-command control endpoints",
    "  --quick-command-buffer-size <n>",
    "                                In-memory quick-command buffer size",
    "  --quick-command-dedupe-ms <ms> Quick-command clientRequestId de-dupe window",
    "  --quick-command-consumer none|jsonl",
    "                                Minimal local quick-command consumer mode",
    "  --quick-command-consumer-file <path>",
    "                                Append consumed quick commands as JSONL",
    "  --control-server               Enable local HTTP control server",
    "  --no-control-server            Disable local HTTP control server",
    "  --control-host <host>          Control server bind host (default: 127.0.0.1)",
    "  --control-port <port>          Control server port (default: 27217)",
    "  --control-token <token>        Require Bearer or X-ClaudeBuddy-Token auth",
    "  --control-max-body-bytes <n>   Maximum HTTP request body size",
    "  --sidecar-diagnostics true|false",
    "                                Enable/disable stale BLE sidecar diagnostics",
    "  --no-sidecar-diagnostics       Disable stale BLE sidecar diagnostics",
    "  --retry                       Enable sidecar retry/backoff",
    "  --no-retry                    Disable sidecar retry/backoff",
    "  --retry-initial-ms <ms>       First retry delay (default: 1000)",
    "  --retry-max-ms <ms>           Maximum retry delay (default: 15000)",
    "  --retry-backoff-factor <n>    Retry backoff multiplier (default: 2)",
    "  --retry-max-attempts <n>      Maximum retries after the first attempt; 0 means unlimited",
    "  --log-level <level>           debug|info|warn|error|silent (default: info)",
    "  --verbose                     Emit debug logs",
    "  --quiet                       Emit warn/error logs only",
    "  -h, --help                     Show this help",
  ].join("\n");
}

module.exports = {
  DEFAULT_CONFIG_FILENAME,
  VALID_BACKENDS,
  VALID_CONFIG_KEYS,
  VALID_LOG_LEVELS,
  VALID_QUICK_COMMAND_CONSUMERS,
  VALID_REPLY_MODES,
  VALID_SOURCES,
  VALID_TRANSPORTS,
  createRuntimeConfig,
  findDefaultRuntimeConfig,
  formatRuntimeHelp,
  parseRuntimeArgInput,
  parseRuntimeArgs,
  readRuntimeConfigFile,
};
