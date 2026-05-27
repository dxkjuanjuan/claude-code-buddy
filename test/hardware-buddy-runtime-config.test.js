"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
  DEFAULT_CONFIG_FILENAME,
  createRuntimeConfig,
  formatRuntimeHelp,
  parseRuntimeArgs,
  readRuntimeConfigFile,
} = require("../src/runtime/config");
const {
  buildSidecarArgs,
  connectTargetForConfig,
} = require("../src/runtime/headless-runtime");

describe("hardware buddy runtime config", () => {
  it("defaults to a safe fake standalone runtime", () => {
    const config = createRuntimeConfig({}, {});

    assert.strictEqual(config.source, "static");
    assert.strictEqual(config.sourceFile, "");
    assert.strictEqual(config.sourceMaxBytes, 1024 * 1024);
    assert.strictEqual(config.sourcePollMs, 1000);
    assert.strictEqual(config.transport, "fake");
    assert.strictEqual(config.backend, "fake");
    assert.strictEqual(config.permissionReplies, false);
    assert.strictEqual(config.fakeSecure, true);
    assert.strictEqual(config.pollStatusMs, 0);
    assert.strictEqual(config.diagnoseSidecarContention, true);
    assert.strictEqual(config.sidecarDiagnostics, true);
    assert.strictEqual(config.retryEnabled, true);
    assert.strictEqual(config.retry, true);
    assert.strictEqual(config.retryInitialMs, 1000);
    assert.strictEqual(config.retryMaxMs, 15000);
    assert.strictEqual(config.retryBackoffFactor, 2);
    assert.strictEqual(config.retryMaxAttempts, 0);
    assert.strictEqual(config.logLevel, "info");
    assert.strictEqual(config.logFile, "");
    assert.strictEqual(config.replyMode, "none");
    assert.strictEqual(config.replyFile, "");
    assert.strictEqual(config.replyBufferSize, 100);
    assert.strictEqual(config.quickCommands, false);
    assert.strictEqual(config.quickCommandBufferSize, 100);
    assert.strictEqual(config.quickCommandDedupeMs, 30000);
    assert.strictEqual(config.quickCommandConsumer, "none");
    assert.strictEqual(config.quickCommandConsumerFile, "");
    assert.strictEqual(config.controlServer, false);
    assert.strictEqual(config.controlHost, "127.0.0.1");
    assert.strictEqual(config.controlPort, 27217);
    assert.strictEqual(config.controlToken, "");
    assert.strictEqual(config.controlMaxBodyBytes, 1024 * 1024);
    assert.strictEqual(config.onceMs, 250);
    assert.strictEqual(config.shutdownTimeoutMs, 1500);
    assert.strictEqual(config.sourceTitle, "ClaudeBuddy Standalone");
    assert.strictEqual(config.sidecarScript, path.resolve(__dirname, "..", "tools", "hardware_buddy_bridge.py"));
  });

  it("parses CLI arguments into a sidecar BLE config", () => {
    const config = parseRuntimeArgs([
      "--transport", "sidecar",
      "--source", "json-file",
      "--source-file", "state.json",
      "--source-max-bytes", "2048",
      "--source-poll-ms", "250",
      "--backend=bleak",
      "--python", "python3",
      "--address", "AA:BB:CC:DD:EE:FF",
      "--name-prefix", "Claude",
      "--scan-timeout", "8",
      "--connect-timeout", "12",
      "--pair",
      "--no-fake-secure",
      "--permission-replies",
      "--keepalive-ms", "25",
      "--poll-status-ms", "50",
      "--once-ms", "50",
      "--shutdown-timeout-ms", "75",
      "--title", "Repo task",
      "--state", "thinking",
      "--once",
      "--json",
      "--json-logs", "false",
      "--no-sidecar-diagnostics",
      "--no-retry",
      "--retry-initial-ms", "100",
      "--retry-max-ms", "5000",
      "--retry-backoff-factor", "1.5",
      "--retry-max-attempts", "7",
      "--log-level", "debug",
      "--log-file", "logs/runtime.jsonl",
      "--reply-mode", "jsonl",
      "--reply-file", "logs/replies.jsonl",
      "--reply-buffer-size", "25",
      "--quick-commands",
      "--quick-command-buffer-size", "30",
      "--quick-command-dedupe-ms", "250",
      "--quick-command-consumer", "jsonl",
      "--quick-command-consumer-file", "logs/quick-commands-consumed.jsonl",
      "--control-server",
      "--control-host", "127.0.0.1",
      "--control-port", "0",
      "--control-token", "secret",
      "--control-max-body-bytes", "4096",
    ], {});

    assert.strictEqual(config.transport, "sidecar");
    assert.strictEqual(config.source, "json-file");
    assert.strictEqual(config.sourceFile, path.resolve("state.json"));
    assert.strictEqual(config.sourceMaxBytes, 2048);
    assert.strictEqual(config.sourcePollMs, 250);
    assert.strictEqual(config.backend, "bleak");
    assert.strictEqual(config.pythonCommand, "python3");
    assert.strictEqual(config.address, "AA:BB:CC:DD:EE:FF");
    assert.strictEqual(config.scanTimeout, 8);
    assert.strictEqual(config.connectTimeout, 12);
    assert.strictEqual(config.pair, true);
    assert.strictEqual(config.fakeSecure, false);
    assert.strictEqual(config.permissionReplies, true);
    assert.strictEqual(config.keepaliveMs, 25);
    assert.strictEqual(config.pollStatusMs, 50);
    assert.strictEqual(config.sourceTitle, "Repo task");
    assert.strictEqual(config.sourceState, "thinking");
    assert.strictEqual(config.once, true);
    assert.strictEqual(config.onceMs, 50);
    assert.strictEqual(config.shutdownTimeoutMs, 75);
    assert.strictEqual(config.jsonLogs, false);
    assert.strictEqual(config.diagnoseSidecarContention, false);
    assert.strictEqual(config.sidecarDiagnostics, false);
    assert.strictEqual(config.retryEnabled, false);
    assert.strictEqual(config.retry, false);
    assert.strictEqual(config.retryInitialMs, 100);
    assert.strictEqual(config.retryMaxMs, 5000);
    assert.strictEqual(config.retryBackoffFactor, 1.5);
    assert.strictEqual(config.retryMaxAttempts, 7);
    assert.strictEqual(config.logLevel, "debug");
    assert.strictEqual(config.logFile, path.resolve("logs/runtime.jsonl"));
    assert.strictEqual(config.replyMode, "jsonl");
    assert.strictEqual(config.replyFile, path.resolve("logs/replies.jsonl"));
    assert.strictEqual(config.replyBufferSize, 25);
    assert.strictEqual(config.quickCommands, true);
    assert.strictEqual(config.quickCommandBufferSize, 30);
    assert.strictEqual(config.quickCommandDedupeMs, 250);
    assert.strictEqual(config.quickCommandConsumer, "jsonl");
    assert.strictEqual(config.quickCommandConsumerFile, path.resolve("logs/quick-commands-consumed.jsonl"));
    assert.strictEqual(config.controlServer, true);
    assert.strictEqual(config.controlHost, "127.0.0.1");
    assert.strictEqual(config.controlPort, 0);
    assert.strictEqual(config.controlToken, "secret");
    assert.strictEqual(config.controlMaxBodyBytes, 4096);
  });

  it("loads an explicit config file and lets CLI flags override file values", (t) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "claudebuddy-config-"));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const configPath = path.join(dir, "runtime.json");
    fs.writeFileSync(configPath, JSON.stringify({
      transport: "sidecar",
      source: "json-file",
      sourceFile: "state.json",
      sourcePollMs: 500,
      backend: "bleak",
      address: "11:22:33:44:55:66",
      namePrefix: "Buddy",
      permissionReplies: true,
      keepaliveMs: 9000,
      pollStatusMs: 8000,
      once: true,
      onceMs: 7000,
      jsonLogs: true,
      sidecarDiagnostics: false,
      retry: true,
      retryInitialMs: 250,
      retryMaxMs: 2000,
      retryBackoffFactor: 1.25,
      retryMaxAttempts: 3,
      logLevel: "warn",
      logFile: "logs/daemon.log",
      replyFile: "logs/replies.jsonl",
      quickCommands: true,
      quickCommandBufferSize: 50,
      quickCommandDedupeMs: 5000,
      quickCommandConsumer: "jsonl",
      quickCommandConsumerFile: "logs/quick-commands-consumed.jsonl",
      replyBufferSize: 75,
      controlServer: true,
      controlHost: "localhost",
      controlPort: 32123,
      controlToken: "file-token",
    }), "utf8");

    const config = parseRuntimeArgs([
      "--config",
      configPath,
      "--backend",
      "fake",
      "--address",
      "AA:BB:CC:DD:EE:FF",
      "--no-permission-replies",
      "--once-ms",
      "0",
      "--sidecar-diagnostics=false",
      "--no-retry",
      "--quiet",
      "--log-file",
      "",
      "--reply-file",
      "",
      "--no-control-server",
    ], {}, { cwd: dir });

    assert.strictEqual(config.configPath, configPath);
    assert.strictEqual(config.source, "json-file");
    assert.strictEqual(config.sourceFile, path.join(dir, "state.json"));
    assert.strictEqual(config.sourcePollMs, 500);
    assert.strictEqual(config.transport, "sidecar");
    assert.strictEqual(config.backend, "fake");
    assert.strictEqual(config.address, "AA:BB:CC:DD:EE:FF");
    assert.strictEqual(config.namePrefix, "Buddy");
    assert.strictEqual(config.permissionReplies, false);
    assert.strictEqual(config.keepaliveMs, 9000);
    assert.strictEqual(config.pollStatusMs, 8000);
    assert.strictEqual(config.once, true);
    assert.strictEqual(config.onceMs, 0);
    assert.strictEqual(config.jsonLogs, true);
    assert.strictEqual(config.diagnoseSidecarContention, false);
    assert.strictEqual(config.sidecarDiagnostics, false);
    assert.strictEqual(config.retryEnabled, false);
    assert.strictEqual(config.retryInitialMs, 250);
    assert.strictEqual(config.retryMaxMs, 2000);
    assert.strictEqual(config.retryBackoffFactor, 1.25);
    assert.strictEqual(config.retryMaxAttempts, 3);
    assert.strictEqual(config.logLevel, "warn");
    assert.strictEqual(config.logFile, "");
    assert.strictEqual(config.replyMode, "none");
    assert.strictEqual(config.replyFile, "");
    assert.strictEqual(config.replyBufferSize, 75);
    assert.strictEqual(config.quickCommands, true);
    assert.strictEqual(config.quickCommandBufferSize, 50);
    assert.strictEqual(config.quickCommandDedupeMs, 5000);
    assert.strictEqual(config.quickCommandConsumer, "jsonl");
    assert.strictEqual(config.quickCommandConsumerFile, path.join(dir, "logs", "quick-commands-consumed.jsonl"));
    assert.strictEqual(config.controlServer, false);
    assert.strictEqual(config.controlHost, "localhost");
    assert.strictEqual(config.controlPort, 32123);
    assert.strictEqual(config.controlToken, "file-token");
  });

  it("loads claudebuddy.config.json from the working directory when present", (t) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "claudebuddy-default-config-"));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const configPath = path.join(dir, DEFAULT_CONFIG_FILENAME);
    fs.writeFileSync(configPath, JSON.stringify({
      transport: "fake",
      title: "Config File Task",
      state: "reviewing",
      keepaliveMs: 0,
    }), "utf8");

    const config = parseRuntimeArgs([], {}, { cwd: dir });

    assert.strictEqual(config.configPath, configPath);
    assert.strictEqual(config.sourceTitle, "Config File Task");
    assert.strictEqual(config.sourceState, "reviewing");
    assert.strictEqual(config.keepaliveMs, 0);
  });

  it("keeps checked-in example configs parseable and explicit about permission replies", () => {
    const fakeConfig = parseRuntimeArgs([
      "--config",
      path.resolve(__dirname, "..", "examples", "claudebuddy.fake.config.json"),
    ], {});
    const jsonFileConfig = parseRuntimeArgs([
      "--config",
      path.resolve(__dirname, "..", "examples", "claudebuddy.json-file.config.json"),
    ], {});
    const stdinJsonlConfig = parseRuntimeArgs([
      "--config",
      path.resolve(__dirname, "..", "examples", "claudebuddy.stdin-jsonl.config.json"),
    ], {});
    const httpControlConfig = parseRuntimeArgs([
      "--config",
      path.resolve(__dirname, "..", "examples", "claudebuddy.http-control.config.json"),
    ], {});
    const quickCommandsConfig = parseRuntimeArgs([
      "--config",
      path.resolve(__dirname, "..", "examples", "claudebuddy.quick-commands.config.json"),
    ], {});
    const httpBleExampleConfig = parseRuntimeArgs([
      "--config",
      path.resolve(__dirname, "..", "examples", "claudebuddy.http-ble.example.config.json"),
    ], {});

    assert.strictEqual(fakeConfig.transport, "fake");
    assert.strictEqual(fakeConfig.source, "static");
    assert.strictEqual(fakeConfig.permissionReplies, false);
    assert.match(fakeConfig.logFile, /claudebuddy\.fake\.log$/);
    assert.strictEqual(jsonFileConfig.source, "json-file");
    assert.match(jsonFileConfig.sourceFile, /state\.sample\.json$/);
    assert.strictEqual(jsonFileConfig.permissionReplies, false);
    assert.strictEqual(stdinJsonlConfig.source, "stdin-jsonl");
    assert.strictEqual(stdinJsonlConfig.transport, "fake");
    assert.strictEqual(stdinJsonlConfig.permissionReplies, false);
    assert.strictEqual(stdinJsonlConfig.sourceMaxBytes, 65536);
    assert.strictEqual(httpControlConfig.controlServer, true);
    assert.strictEqual(httpControlConfig.controlHost, "127.0.0.1");
    assert.strictEqual(httpControlConfig.controlPort, 27217);
    assert.strictEqual(httpControlConfig.permissionReplies, false);
    assert.strictEqual(httpControlConfig.quickCommands, false);
    assert.strictEqual(quickCommandsConfig.controlServer, true);
    assert.strictEqual(quickCommandsConfig.quickCommands, true);
    assert.strictEqual(quickCommandsConfig.quickCommandConsumer, "jsonl");
    assert.match(quickCommandsConfig.quickCommandConsumerFile, /logs[\\/]quick-commands-consumed\.jsonl$/);
    assert.strictEqual(quickCommandsConfig.permissionReplies, false);
    assert.strictEqual(httpBleExampleConfig.transport, "sidecar");
    assert.strictEqual(httpBleExampleConfig.backend, "bleak");
    assert.strictEqual(httpBleExampleConfig.controlServer, true);
    assert.strictEqual(httpBleExampleConfig.address, "");
    assert.strictEqual(httpBleExampleConfig.namePrefix, "Claude");
    assert.strictEqual(httpBleExampleConfig.permissionReplies, false);
    assert.match(httpBleExampleConfig.logFile, /claudebuddy\.http-ble\.example\.jsonl$/);
  });

  it("resolves relative sidecar script paths from the config file directory", (t) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "claudebuddy-relative-config-"));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const configPath = path.join(dir, "runtime.json");
    fs.writeFileSync(configPath, JSON.stringify({
      transport: "sidecar",
      backend: "fake",
      sidecarScript: "tools/bridge.py",
      replyFile: "logs/replies.jsonl",
      quickCommandConsumerFile: "logs/quick-commands-consumed.jsonl",
    }), "utf8");

    const loaded = readRuntimeConfigFile(configPath);
    const config = parseRuntimeArgs(["--config", configPath], {}, { cwd: dir });

    assert.strictEqual(loaded.input.sidecarScript, path.join(dir, "tools", "bridge.py"));
    assert.strictEqual(loaded.input.replyFile, path.join(dir, "logs", "replies.jsonl"));
    assert.strictEqual(loaded.input.quickCommandConsumerFile, path.join(dir, "logs", "quick-commands-consumed.jsonl"));
    assert.strictEqual(config.sidecarScript, path.join(dir, "tools", "bridge.py"));
    assert.strictEqual(config.replyFile, path.join(dir, "logs", "replies.jsonl"));
    assert.strictEqual(config.replyMode, "jsonl");
    assert.strictEqual(config.quickCommandConsumerFile, path.join(dir, "logs", "quick-commands-consumed.jsonl"));
    assert.strictEqual(config.quickCommandConsumer, "jsonl");
  });

  it("builds sidecar process args without embedding Clawd assumptions", () => {
    const config = createRuntimeConfig({
      transport: "sidecar",
      backend: "fake",
      sidecarScript: "tools/hardware_buddy_bridge.py",
      fakeSecure: false,
      pair: true,
    }, {});

    assert.deepStrictEqual(buildSidecarArgs(config), [
      path.resolve("tools/hardware_buddy_bridge.py"),
      "--backend",
      "fake",
      "--scan-timeout",
      "5",
      "--connect-timeout",
      "10",
      "--name-prefix",
      "Claude",
      "--fake-secure",
      "false",
      "--pair",
    ]);
    assert.deepStrictEqual(connectTargetForConfig(config), { address: "FAKE:CLAWSTICK" });
  });

  it("uses explicit connect targets before fake defaults", () => {
    assert.deepStrictEqual(connectTargetForConfig(createRuntimeConfig({
      backend: "fake",
      address: "AA:BB",
    }, {})), { address: "AA:BB" });
    assert.deepStrictEqual(connectTargetForConfig(createRuntimeConfig({
      backend: "bleak",
      name: "Claude-TEST",
    }, {})), { name: "Claude-TEST" });
    assert.strictEqual(connectTargetForConfig(createRuntimeConfig({
      backend: "bleak",
    }, {})), null);
  });

  it("rejects unsupported CLI options and choices", () => {
    assert.throws(() => parseRuntimeArgs(["--wat"], {}), /unknown option/);
    assert.throws(() => parseRuntimeArgs(["--backend", "wifi"], {}), /backend/);
    assert.throws(() => parseRuntimeArgs(["--transport"], {}), /requires a value/);
    assert.throws(() => parseRuntimeArgs(["--source", "json-file"], {}), /sourceFile is required/);
    assert.match(formatRuntimeHelp(), /standalone/i);
    assert.match(formatRuntimeHelp(), /--config/);
    assert.match(formatRuntimeHelp(), /stdin-jsonl/);
    assert.match(formatRuntimeHelp(), /--source-file/);
    assert.match(formatRuntimeHelp(), /--source-max-bytes/);
    assert.match(formatRuntimeHelp(), /--sidecar-script/);
    assert.match(formatRuntimeHelp(), /--no-auto-connect/);
    assert.match(formatRuntimeHelp(), /--shutdown-timeout-ms/);
    assert.match(formatRuntimeHelp(), /--retry-initial-ms/);
    assert.match(formatRuntimeHelp(), /--log-level/);
    assert.match(formatRuntimeHelp(), /--log-file/);
    assert.match(formatRuntimeHelp(), /--reply-file/);
    assert.match(formatRuntimeHelp(), /--reply-buffer-size/);
    assert.match(formatRuntimeHelp(), /--quick-commands/);
    assert.match(formatRuntimeHelp(), /--quick-command-consumer/);
    assert.match(formatRuntimeHelp(), /--control-server/);
    assert.match(formatRuntimeHelp(), /--control-port/);
    assert.throws(() => parseRuntimeArgs(["--log-level", "trace"], {}), /logLevel/);
    assert.throws(() => parseRuntimeArgs(["--source", "socket"], {}), /source/);
    assert.throws(() => parseRuntimeArgs(["--reply-mode", "http"], {}), /replyMode/);
    assert.throws(() => parseRuntimeArgs(["--reply-mode", "jsonl"], {}), /replyFile is required/);
    assert.throws(() => parseRuntimeArgs(["--quick-command-consumer", "http"], {}), /quickCommandConsumer/);
  });

  it("rejects missing, malformed, and unknown-key config files", (t) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "claudebuddy-invalid-config-"));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const badJsonPath = path.join(dir, "bad.json");
    const arrayPath = path.join(dir, "array.json");
    const unknownPath = path.join(dir, "unknown.json");

    fs.writeFileSync(badJsonPath, "{", "utf8");
    fs.writeFileSync(arrayPath, "[]", "utf8");
    fs.writeFileSync(unknownPath, JSON.stringify({ transport: "fake", permissionsReply: true }), "utf8");

    assert.throws(() => parseRuntimeArgs(["--config", path.join(dir, "missing.json")], {}, { cwd: dir }), /config file not found/);
    assert.throws(() => parseRuntimeArgs(["--config", badJsonPath], {}, { cwd: dir }), /invalid config JSON/);
    assert.throws(() => parseRuntimeArgs(["--config", arrayPath], {}, { cwd: dir }), /JSON object/);
    assert.throws(() => parseRuntimeArgs(["--config", unknownPath], {}, { cwd: dir }), /unknown config key.*permissionsReply/);
  });

  it("does not require a valid config file for help output", (t) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "claudebuddy-help-config-"));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    fs.writeFileSync(path.join(dir, DEFAULT_CONFIG_FILENAME), "{", "utf8");

    const config = parseRuntimeArgs(["--help"], {}, { cwd: dir });

    assert.strictEqual(config.help, true);
    assert.strictEqual(config.configPath, "");
  });

  it("uses a longer once default for BLE sidecar runs", () => {
    const config = createRuntimeConfig({
      transport: "sidecar",
      backend: "bleak",
    }, {});

    assert.strictEqual(config.onceMs, 3000);
  });
});
