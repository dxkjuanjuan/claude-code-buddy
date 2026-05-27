"use strict";

const { HardwareBuddyController } = require("../hardware-buddy/controller");
const { FakeHardwareBuddyTransport } = require("../hardware-buddy/fake-transport");
const { SidecarClient } = require("../hardware-buddy/sidecar-client");
const { createRuntimeConfig } = require("./config");
const {
  defaultListProcesses,
  findSidecarContention,
  formatContentionSummary,
  isNoDeviceSidecarError,
} = require("./sidecar-contention");
const { createHttpControlServer } = require("./http-control-server");
const { createJsonlQuickCommandConsumer } = require("./jsonl-quick-command-consumer");
const { createJsonlPermissionReplySink } = require("./jsonl-reply-sink");
const { createJsonFileHardwareBuddySource } = require("./json-file-source");
const { createMemoryQuickCommandSink } = require("./memory-quick-command-sink");
const {
  createCompositePermissionReplySink,
  createMemoryPermissionReplySink,
} = require("./memory-reply-sink");
const { QUICK_COMMAND_PRESETS } = require("./quick-command-presets");
const { createStaticHardwareBuddySource } = require("./static-source");
const { createStdinJsonlHardwareBuddySource } = require("./stdin-jsonl-source");
const { createMemoryTaskStateStore } = require("./task-state");

function callback(fn, ...args) {
  if (typeof fn === "function") fn(...args);
}

function defaultDefer(fn) {
  if (typeof setImmediate === "function") return setImmediate(fn);
  return setTimeout(fn, 0);
}

function buildSidecarArgs(config) {
  const args = [
    config.sidecarScript,
    "--backend",
    config.backend,
    "--scan-timeout",
    String(config.scanTimeout),
    "--connect-timeout",
    String(config.connectTimeout),
    "--name-prefix",
    config.namePrefix,
  ];

  if (config.backend === "fake") {
    args.push("--fake-secure", config.fakeSecure ? "true" : "false");
  }
  if (config.pair) args.push("--pair");
  return args;
}

function connectTargetForConfig(config) {
  if (config.address) return { address: config.address };
  if (config.id) return { id: config.id };
  if (config.name) return { name: config.name };
  if (config.backend === "fake") return { address: "FAKE:CLAWSTICK" };
  return null;
}

function targetFromDeviceItem(item) {
  if (!item || typeof item !== "object") return null;
  if (typeof item.address === "string" && item.address) return { address: item.address };
  if (typeof item.id === "string" && item.id) return { id: item.id };
  if (typeof item.name === "string" && item.name) return { name: item.name };
  return null;
}

class HeadlessHardwareBuddyRuntime {
  constructor(options = {}) {
    this.config = createRuntimeConfig(options.config || options);
    this.source = options.source || null;
    this.createSource = options.createSource;
    this.stdin = options.stdin || options.inputStream || process.stdin;
    this.permissionReplySink = options.permissionReplySink || null;
    this.createPermissionReplySink = options.createPermissionReplySink;
    this.quickCommandSink = options.quickCommandSink || null;
    this.createQuickCommandSink = options.createQuickCommandSink;
    this.quickCommandConsumer = options.quickCommandConsumer || null;
    this.createQuickCommandConsumer = options.createQuickCommandConsumer;
    this.taskStateStore = options.taskStateStore || null;
    this.createTaskStateStore = options.createTaskStateStore;
    this.controlServer = options.controlServer || null;
    this.createControlServer = options.createControlServer;
    this.transport = options.transport || null;
    this.sidecarClient = options.sidecarClient || null;
    this.createSidecarClient = options.createSidecarClient;
    this.sidecarClientOptions = options.sidecarClientOptions && typeof options.sidecarClientOptions === "object"
      ? { ...options.sidecarClientOptions }
      : {};
    this.setInterval = options.setInterval || setInterval;
    this.clearInterval = options.clearInterval || clearInterval;
    this.setTimeout = options.setTimeout || setTimeout;
    this.clearTimeout = options.clearTimeout || clearTimeout;
    this.defer = typeof options.defer === "function" ? options.defer : defaultDefer;
    this.now = typeof options.now === "function" ? options.now : () => Date.now();
    this.failureContentionDiagnosticsMinIntervalMs = Number.isFinite(options.failureContentionDiagnosticsMinIntervalMs)
      ? Math.max(0, Math.floor(options.failureContentionDiagnosticsMinIntervalMs))
      : 30000;
    this.listProcesses = typeof options.listProcesses === "function"
      ? options.listProcesses
      : defaultListProcesses;
    this.log = typeof options.log === "function" ? options.log : () => {};

    this.controller = null;
    this.started = false;
    this.pollTimer = null;
    this.unsubscribeSource = null;
    this.lastSnapshot = null;
    this.lastStatus = null;
    this.lastDevices = [];
    this.lastError = null;
    this.sidecarContention = { hasContention: false, matches: [] };
    this.contentionWarningEmitted = false;
    this.failureContentionHintEmitted = false;
    this.failureContentionDiagnosticsRanAt = 0;
    this.connectIssued = false;
    this.unsubscribeEarlyCommand = null;
    this.retryTimer = null;
    this.retryAttempts = 0;
    this.retryExhausted = false;
  }

  start() {
    if (this.started) return this.lastSnapshot;
    this.started = true;
    this.connectIssued = false;
    this.contentionWarningEmitted = false;
    this.failureContentionHintEmitted = false;
    this.failureContentionDiagnosticsRanAt = 0;
    this.sidecarContention = { hasContention: false, matches: [] };
    this.#clearRetryTimer();
    this.retryAttempts = 0;
    this.retryExhausted = false;
    try {
      this.source = this.source || this.#createSource();
      this.#startSource();
      this.permissionReplySink = this.permissionReplySink || this.#createPermissionReplySink();
      this.quickCommandSink = this.quickCommandSink || this.#createQuickCommandSink();
      this.taskStateStore = this.taskStateStore || this.#createTaskStateStore();
      this.quickCommandConsumer = this.quickCommandConsumer || this.#createQuickCommandConsumer();
      this.#startQuickCommandConsumer();
      this.transport = this.transport || this.#createTransport();
      this.controller = this.#createController();
      this.#subscribeSource();

      this.#installEarlyCommandForwarder();
      const sidecarStarted = this.#startSidecarProcess("start");

      this.lastSnapshot = this.controller.start();
      this.#clearEarlyCommandForwarder();
      this.#scheduleContentionDiagnostics("preflight");
      if (sidecarStarted) this.#startSidecarConnect();
      this.#startStatusPolling();
      this.#startControlServer();
      return this.lastSnapshot;
    } catch (err) {
      this.stop();
      throw err;
    }
  }

  stop() {
    this.started = false;
    const pendingStops = [];
    this.#clearRetryTimer();

    if (this.pollTimer != null && typeof this.clearInterval === "function") {
      this.clearInterval(this.pollTimer);
    }
    this.pollTimer = null;

    if (typeof this.unsubscribeSource === "function") {
      this.unsubscribeSource();
    }
    this.unsubscribeSource = null;

    if (this.source && typeof this.source.stop === "function") {
      this.source.stop();
    }

    if (this.permissionReplySink && typeof this.permissionReplySink.stop === "function") {
      this.permissionReplySink.stop();
    }

    if (this.quickCommandConsumer && typeof this.quickCommandConsumer.stop === "function") {
      this.quickCommandConsumer.stop();
    }

    if (this.quickCommandSink && typeof this.quickCommandSink.stop === "function") {
      this.quickCommandSink.stop();
    }

    if (this.taskStateStore && typeof this.taskStateStore.stop === "function") {
      this.taskStateStore.stop();
    }

    if (this.controlServer && typeof this.controlServer.stop === "function") {
      pendingStops.push(Promise.resolve(this.controlServer.stop()));
    }

    this.#clearEarlyCommandForwarder();

    if (this.controller) this.controller.stop();
    this.controller = null;

    if (this.sidecarClient && typeof this.sidecarClient.stop === "function") {
      this.sidecarClient.stop();
    }

    if (pendingStops.length) {
      return Promise.allSettled(pendingStops).then(() => undefined);
    }
    return undefined;
  }

  emitSnapshot(reason = "manual") {
    if (!this.controller) return null;
    this.lastSnapshot = this.controller.emitSnapshot(reason);
    return this.lastSnapshot;
  }

  notifyStateChanged() {
    if (!this.controller) return null;
    this.lastSnapshot = this.controller.notifyStateChanged();
    return this.lastSnapshot;
  }

  notifyPermissionsChanged() {
    if (!this.controller) return null;
    this.lastSnapshot = this.controller.notifyPermissionsChanged();
    return this.lastSnapshot;
  }

  isTransportSecure() {
    if (this.transport && typeof this.transport.isSecure === "function") {
      return this.transport.isSecure() === true;
    }
    if (this.transport && Object.prototype.hasOwnProperty.call(this.transport, "secure")) {
      return this.transport.secure === true;
    }
    return false;
  }

  getStatus() {
    const transport = this.transport || {};
    const child = this.sidecarClient && this.sidecarClient.child;
    return {
      started: this.started === true,
      source: this.config.source,
      transport: {
        type: this.config.transport,
        backend: this.config.backend,
        connected: transport.connected === true,
        secure: this.isTransportSecure(),
      },
      sidecar: {
        pid: child && Number.isFinite(Number(child.pid)) ? Number(child.pid) : null,
        started: this.sidecarClient ? this.sidecarClient.started === true : false,
        lastStatus: this.lastStatus,
        lastDevices: this.lastDevices.slice(),
        lastError: serializeError(this.lastError),
      },
      retry: {
        scheduled: this.retryTimer != null,
        attempts: this.retryAttempts,
        exhausted: this.retryExhausted,
      },
      replies: this.permissionReplySink && typeof this.permissionReplySink.status === "function"
        ? this.permissionReplySink.status()
        : { type: "none" },
      quickCommands: {
        enabled: this.config.quickCommands === true,
        presets: QUICK_COMMAND_PRESETS.length,
        sink: this.quickCommandSink && typeof this.quickCommandSink.status === "function"
          ? this.quickCommandSink.status()
          : { type: "none" },
        consumer: this.quickCommandConsumer && typeof this.quickCommandConsumer.status === "function"
          ? this.quickCommandConsumer.status()
          : { type: "none" },
      },
      taskState: this.taskStateStore && typeof this.taskStateStore.status === "function"
        ? this.taskStateStore.status()
        : { type: "none" },
      snapshot: this.lastSnapshot,
      controlServer: this.controlServer && typeof this.controlServer.status === "function"
        ? this.controlServer.status()
        : { enabled: false },
    };
  }

  listPermissionReplies(options = {}) {
    if (this.permissionReplySink && typeof this.permissionReplySink.list === "function") {
      return this.permissionReplySink.list(options);
    }
    const after = Number.isFinite(Number(options.after)) ? Math.max(0, Math.floor(Number(options.after))) : 0;
    return {
      cursor: after,
      nextCursor: after,
      latestSeq: 0,
      oldestSeq: 0,
      hasMore: false,
      items: [],
    };
  }

  waitForPermissionReplies(options = {}) {
    if (this.permissionReplySink && typeof this.permissionReplySink.wait === "function") {
      return this.permissionReplySink.wait(options);
    }
    return Promise.resolve(this.listPermissionReplies(options));
  }

  subscribePermissionReplies(listener) {
    if (this.permissionReplySink && typeof this.permissionReplySink.subscribe === "function") {
      return this.permissionReplySink.subscribe(listener);
    }
    return () => {};
  }

  getQuickCommandPresets() {
    return {
      enabled: this.config.quickCommands === true,
      presets: QUICK_COMMAND_PRESETS.map((preset) => ({ ...preset })),
    };
  }

  createQuickCommand(input = {}) {
    this.#assertQuickCommandsEnabled();
    if (!this.quickCommandSink || typeof this.quickCommandSink.write !== "function") {
      throw Object.assign(new Error("quick commands are not configured"), {
        statusCode: 409,
        error: "quick_commands_unavailable",
        code: "quick_commands_unavailable",
      });
    }
    return this.quickCommandSink.write(input);
  }

  listQuickCommands(options = {}) {
    this.#assertQuickCommandsEnabled();
    if (this.quickCommandSink && typeof this.quickCommandSink.list === "function") {
      return this.quickCommandSink.list(options);
    }
    const after = Number.isFinite(Number(options.after)) ? Math.max(0, Math.floor(Number(options.after))) : 0;
    return {
      cursor: after,
      nextCursor: after,
      latestSeq: 0,
      oldestSeq: 0,
      hasMore: false,
      items: [],
    };
  }

  waitForQuickCommands(options = {}) {
    this.#assertQuickCommandsEnabled();
    if (this.quickCommandSink && typeof this.quickCommandSink.wait === "function") {
      return this.quickCommandSink.wait(options);
    }
    return Promise.resolve(this.listQuickCommands(options));
  }

  subscribeQuickCommands(listener) {
    if (this.quickCommandSink && typeof this.quickCommandSink.subscribe === "function") {
      return this.quickCommandSink.subscribe(listener);
    }
    return () => {};
  }

  createTaskState(input = {}) {
    this.#assertQuickCommandsEnabled();
    if (!this.taskStateStore || typeof this.taskStateStore.write !== "function") {
      throw Object.assign(new Error("task state is not configured"), {
        statusCode: 409,
        error: "task_state_unavailable",
        code: "task_state_unavailable",
      });
    }
    return this.taskStateStore.write(input);
  }

  getTaskState(options = {}) {
    this.#assertQuickCommandsEnabled();
    const latest = this.taskStateStore && typeof this.taskStateStore.latest === "function"
      ? this.taskStateStore.latest({ ...options, now: this.now })
      : null;
    return {
      latest,
    };
  }

  #createTransport() {
    if (this.config.transport === "fake") {
      return new FakeHardwareBuddyTransport({
        secure: this.config.fakeSecure,
        connected: true,
      });
    }

    this.sidecarClient = this.sidecarClient || this.#createSidecarClient();
    if (!this.sidecarClient || !this.sidecarClient.transport) {
      throw new Error("sidecar client must expose a transport");
    }
    return this.sidecarClient.transport;
  }

  #createSource() {
    if (typeof this.createSource === "function") {
      return this.createSource(this.config, this);
    }
    if (this.config.source === "json-file") {
      return createJsonFileHardwareBuddySource({
        file: this.config.sourceFile,
        pollMs: this.config.sourcePollMs,
        maxBytes: this.config.sourceMaxBytes,
        title: this.config.sourceTitle,
        state: this.config.sourceState,
        doNotDisturb: this.config.doNotDisturb,
        setInterval: this.setInterval,
        clearInterval: this.clearInterval,
        log: (level, message, meta) => this.#log(level, message, meta),
      });
    }
    if (this.config.source === "stdin-jsonl") {
      return createStdinJsonlHardwareBuddySource({
        stream: this.stdin,
        maxBytes: this.config.sourceMaxBytes,
        title: this.config.sourceTitle,
        state: this.config.sourceState,
        doNotDisturb: this.config.doNotDisturb,
        now: this.now,
        log: (level, message, meta) => this.#log(level, message, meta),
      });
    }
    return createStaticHardwareBuddySource({
      title: this.config.sourceTitle,
      state: this.config.sourceState,
      doNotDisturb: this.config.doNotDisturb,
    });
  }

  #startSource() {
    if (this.source && typeof this.source.start === "function") {
      this.source.start();
    }
  }

  #createPermissionReplySink() {
    if (typeof this.createPermissionReplySink === "function") {
      return this.createPermissionReplySink(this.config, this);
    }
    const sinks = [];
    if (this.config.replyMode === "jsonl") {
      sinks.push(createJsonlPermissionReplySink({
        file: this.config.replyFile,
        now: this.now,
        log: (level, message, meta) => this.#log(level, message, meta),
      }));
    }
    if (this.config.controlServer === true) {
      sinks.push(createMemoryPermissionReplySink({
        maxRecords: this.config.replyBufferSize,
        now: this.now,
        log: (level, message, meta) => this.#log(level, message, meta),
      }));
    }
    if (sinks.length === 0) return null;
    if (sinks.length === 1) return sinks[0];
    return createCompositePermissionReplySink(sinks);
  }

  #createQuickCommandSink() {
    if (typeof this.createQuickCommandSink === "function") {
      return this.createQuickCommandSink(this.config, this);
    }
    if (this.config.quickCommands !== true) return null;
    return createMemoryQuickCommandSink({
      maxRecords: this.config.quickCommandBufferSize,
      dedupeMs: this.config.quickCommandDedupeMs,
      now: this.now,
      log: (level, message, meta) => this.#log(level, message, meta),
    });
  }

  #createTaskStateStore() {
    if (typeof this.createTaskStateStore === "function") {
      return this.createTaskStateStore(this.config, this);
    }
    if (this.config.quickCommands !== true) return null;
    return createMemoryTaskStateStore({
      maxRecords: this.config.quickCommandBufferSize,
      now: this.now,
    });
  }

  #createQuickCommandConsumer() {
    if (typeof this.createQuickCommandConsumer === "function") {
      return this.createQuickCommandConsumer(this.config, this);
    }
    if (this.config.quickCommands !== true || this.config.quickCommandConsumer !== "jsonl") return null;
    return createJsonlQuickCommandConsumer({
      file: this.config.quickCommandConsumerFile,
      now: this.now,
      log: (level, message, meta) => this.#log(level, message, meta),
    });
  }

  #startQuickCommandConsumer() {
    if (this.quickCommandConsumer && typeof this.quickCommandConsumer.start === "function") {
      this.quickCommandConsumer.start(this.quickCommandSink);
    }
  }

  #createSidecarClient() {
    if (typeof this.createSidecarClient === "function") {
      return this.createSidecarClient(this.config, this);
    }

    return new SidecarClient({
      ...this.sidecarClientOptions,
      command: this.config.pythonCommand,
      args: buildSidecarArgs(this.config),
      spawnOptions: {
        windowsHide: true,
        ...(this.sidecarClientOptions.spawnOptions || {}),
      },
      onStatus: (status) => this.#handleStatus(status),
      onDevices: (items, message) => this.#handleDevices(items, message),
      onError: (err) => this.#handleError(err),
      onExit: (info) => this.#handleSidecarExit(info),
      onTransportStateChanged: (state) => this.#handleTransportStateChanged(state),
      log: (level, message, meta) => this.#log(level, message, meta),
    });
  }

  #createController() {
    const source = this.source;
    return new HardwareBuddyController({
      transport: this.transport,
      getSessionSnapshot: () => callbackValue(source, "getSessionSnapshot", { sessions: [] }),
      getPendingPermissions: () => callbackValue(source, "getPendingPermissions", []),
      getDoNotDisturb: () => {
        if (source && typeof source.getDoNotDisturb === "function") {
          return source.getDoNotDisturb() === true;
        }
        return this.config.doNotDisturb === true;
      },
      isAgentEnabled: () => true,
      isAgentPermissionsEnabled: () => this.#canAcceptPermissionReplies(),
      resolvePermissionEntry: (entry, behavior, meta) => this.#resolvePermissionEntry(entry, behavior, meta),
      keepaliveMs: this.config.keepaliveMs,
      onSnapshot: (snapshot) => {
        this.lastSnapshot = snapshot;
      },
      log: (message) => this.#log("warn", message),
    });
  }

  #canAcceptPermissionReplies() {
    return !!(
      this.config.permissionReplies === true &&
      this.permissionReplySink &&
      typeof this.permissionReplySink.write === "function"
    );
  }

  #resolvePermissionEntry(entry, behavior, meta = {}) {
    let delivered = false;
    if (this.permissionReplySink && typeof this.permissionReplySink.write === "function") {
      delivered = this.permissionReplySink.write(entry, behavior, meta) === true;
    } else {
      this.#log("warn", "hardware permission reply accepted but no reply sink is configured", {
        behavior,
        promptId: meta && meta.promptId,
      });
    }

    if (delivered && this.source && typeof this.source.resolvePermissionEntry === "function") {
      this.source.resolvePermissionEntry(entry, behavior, meta);
    }
  }

  #subscribeSource() {
    if (!this.source || typeof this.source.onChange !== "function") return;
    this.unsubscribeSource = this.source.onChange((reason) => {
      if (reason === "permission-change") this.notifyPermissionsChanged();
      else this.notifyStateChanged();
    });
  }

  #installEarlyCommandForwarder() {
    if (!this.transport || typeof this.transport.onCommand !== "function") return;
    this.#clearEarlyCommandForwarder();
    this.unsubscribeEarlyCommand = this.transport.onCommand((command) => {
      if (this.controller) this.controller.handleCommand(command);
    });
  }

  #clearEarlyCommandForwarder() {
    if (typeof this.unsubscribeEarlyCommand === "function") {
      this.unsubscribeEarlyCommand();
    }
    this.unsubscribeEarlyCommand = null;
  }

  #startSidecarProcess(reason) {
    if (!this.sidecarClient || typeof this.sidecarClient.start !== "function") return true;
    try {
      this.sidecarClient.start();
      return true;
    } catch (err) {
      this.lastError = err;
      const message = err && err.message ? err.message : String(err);
      this.#log("error", message, err);
      this.#scheduleRetry(`sidecar start failed during ${reason}`);
      return false;
    }
  }

  #startSidecarConnect() {
    if (!this.sidecarClient || this.config.autoConnect !== true) return false;
    const target = connectTargetForConfig(this.config);
    if (target) {
      this.connectIssued = true;
      const ok = this.sidecarClient.connect(target);
      if (!ok) this.#scheduleRetry("sidecar connect command failed");
      return ok;
    }
    if (typeof this.sidecarClient.scan === "function") {
      const ok = this.sidecarClient.scan();
      if (!ok) this.#scheduleRetry("sidecar scan command failed");
      return ok;
    }
    return false;
  }

  #startStatusPolling() {
    if (!this.sidecarClient || this.config.pollStatusMs <= 0 || typeof this.setInterval !== "function") {
      return;
    }
    this.pollTimer = this.setInterval(() => {
      if (this.sidecarClient && typeof this.sidecarClient.pollStatus === "function") {
        this.sidecarClient.pollStatus();
      }
    }, this.config.pollStatusMs);
  }

  #createControlServer() {
    if (typeof this.createControlServer === "function") {
      return this.createControlServer(this.config, this);
    }
    if (this.config.controlServer !== true) return null;
    return createHttpControlServer({
      runtime: this,
      host: this.config.controlHost,
      port: this.config.controlPort,
      token: this.config.controlToken,
      maxBodyBytes: this.config.controlMaxBodyBytes,
      now: this.now,
      log: (level, message, meta) => this.#log(level, message, meta),
    });
  }

  #startControlServer() {
    this.controlServer = this.controlServer || this.#createControlServer();
    if (this.controlServer && typeof this.controlServer.start === "function") {
      this.controlServer.start();
    }
  }

  #handleStatus(status) {
    this.lastStatus = status;
    this.#log("info", `status connected=${status.connected === true} secure=${status.secure === true}`, status);
    if (status.connected === true) {
      this.#resetRetryState();
    } else if (this.config.transport === "sidecar" && this.config.autoConnect === true) {
      this.#scheduleRetry("sidecar status reported disconnected");
    }
  }

  #handleDevices(items, message) {
    this.lastDevices = Array.isArray(items) ? items.slice() : [];
    this.#log("info", `scan devices=${this.lastDevices.length}`, message);
    if (this.lastDevices.length === 0) {
      this.#logContentionFailureHint("scan returned devices=0");
      this.#scheduleRetry("sidecar scan returned devices=0");
    }
    if (this.connectIssued || this.config.autoConnect !== true || !this.sidecarClient) return;
    const target = targetFromDeviceItem(this.lastDevices[0]);
    if (!target) return;
    this.connectIssued = true;
    const ok = this.sidecarClient.connect(target);
    if (!ok) this.#scheduleRetry("sidecar connect command failed");
  }

  #handleError(err) {
    this.lastError = err;
    const message = err && err.message ? err.message : String(err);
    this.#log("error", message, err);
    if (isNoDeviceSidecarError(err)) {
      this.#logContentionFailureHint("sidecar reported device not found");
      this.#scheduleRetry("sidecar reported device not found");
    }
  }

  #handleTransportStateChanged(state) {
    this.#log("info", `transport connected=${state.connected === true} secure=${state.secure === true}`, state);
    this.notifyStateChanged();
    if (state.connected === true) {
      this.#resetRetryState();
      // Hardware buddy's BM8563 RTC starts uncalibrated on cold boot
      // (no battery → 2000-01-01) and even with the coin cell intact the
      // firmware can't trust it without a sidecar-pushed reference (plan
      // §3.3 cold-start strategy). Push set_time on the secure-rising
      // edge so the firmware's status-bar mini clock leaves the "--:--"
      // placeholder state and the mood/energy time windows in stats.cpp
      // start using real epoch deltas instead of millis() fallbacks.
      const wasSecure = state.previous && state.previous.secure === true;
      if (state.secure === true && !wasSecure) {
        this.#pushTimeSync();
      }
      return;
    }
    if (
      this.config.transport === "sidecar" &&
      this.config.autoConnect === true &&
      state.previous &&
      state.previous.connected === true
    ) {
      this.#scheduleRetry("sidecar transport disconnected");
    }
  }

  #pushTimeSync() {
    if (!this.sidecarClient || typeof this.sidecarClient.setTime !== "function") return;
    // epoch in seconds since UNIX. offset is local-minus-UTC in seconds so
    // the firmware's gmtime_r(local) call yields correct local components.
    // getTimezoneOffset() returns UTC-local in minutes, so negate and ×60.
    const epoch = Math.floor(Date.now() / 1000);
    const offset = -new Date().getTimezoneOffset() * 60;
    Promise.resolve()
      .then(() => this.sidecarClient.setTime(epoch, offset))
      .catch((err) => {
        const msg = err && err.message ? err.message : String(err);
        this.#log("warn", `time sync push failed: ${msg}`);
      });
  }

  #handleSidecarExit(info = {}) {
    if (!this.started || info.stopping === true) return;
    this.connectIssued = false;
    this.#scheduleRetry("sidecar exited");
  }

  #log(level, message, meta) {
    if (typeof message === "undefined") {
      callback(this.log, "info", String(level));
      return;
    }
    callback(this.log, level, message, meta);
  }

  #assertQuickCommandsEnabled() {
    if (this.config.quickCommands === true) return;
    throw Object.assign(new Error("quick commands are disabled"), {
      statusCode: 409,
      error: "quick_commands_disabled",
      code: "quick_commands_disabled",
    });
  }

  #runContentionDiagnostics(phase) {
    if (
      this.config.diagnoseSidecarContention !== true ||
      this.config.transport !== "sidecar" ||
      this.config.backend !== "bleak"
    ) {
      return this.sidecarContention;
    }

    try {
      const processes = this.listProcesses();
      this.sidecarContention = findSidecarContention(processes, {
        backend: "bleak",
        sidecarScript: this.config.sidecarScript,
        currentPid: process.pid,
        ignorePids: this.#currentSidecarPids(),
      });
    } catch (err) {
      const message = err && err.message ? err.message : String(err);
      this.#log("debug", `sidecar contention diagnostics unavailable: ${message}`, err);
      this.sidecarContention = { hasContention: false, matches: [] };
      return this.sidecarContention;
    }

    if (this.sidecarContention.hasContention && !this.contentionWarningEmitted) {
      this.contentionWarningEmitted = true;
      this.#log("warn", formatContentionSummary(this.sidecarContention), {
        phase,
        matches: this.sidecarContention.matches,
      });
    }
    return this.sidecarContention;
  }

  #scheduleContentionDiagnostics(phase) {
    if (
      this.config.diagnoseSidecarContention !== true ||
      this.config.transport !== "sidecar" ||
      this.config.backend !== "bleak"
    ) {
      return;
    }
    this.defer(() => {
      if (!this.started) return;
      this.#runContentionDiagnostics(phase);
    });
  }

  #logContentionFailureHint(reason) {
    if (this.failureContentionHintEmitted) return;
    let report = this.sidecarContention;
    if (!report || report.hasContention !== true) {
      const now = this.now();
      if (
        this.failureContentionDiagnosticsRanAt > 0 &&
        now - this.failureContentionDiagnosticsRanAt < this.failureContentionDiagnosticsMinIntervalMs
      ) {
        return;
      }
      this.failureContentionDiagnosticsRanAt = now;
      report = this.#runContentionDiagnostics("failure");
    }
    if (!report || report.hasContention !== true) return;
    this.failureContentionHintEmitted = true;
    this.#log("warn", `possible sidecar contention after ${reason}: ${formatContentionSummary(report)}`, {
      reason,
      matches: report.matches,
    });
  }

  #currentSidecarPids() {
    const child = this.sidecarClient && this.sidecarClient.child;
    const pid = child && Number(child.pid);
    return Number.isFinite(pid) ? [pid] : [];
  }

  #clearRetryTimer() {
    if (this.retryTimer != null && typeof this.clearTimeout === "function") {
      this.clearTimeout(this.retryTimer);
    }
    this.retryTimer = null;
  }

  #resetRetryState() {
    this.#clearRetryTimer();
    this.retryAttempts = 0;
    this.retryExhausted = false;
  }

  #retryDelayMs() {
    const initial = Math.max(0, this.config.retryInitialMs);
    const max = Math.max(0, this.config.retryMaxMs);
    const factor = Math.max(1, this.config.retryBackoffFactor);
    const delay = Math.floor(initial * (factor ** this.retryAttempts));
    return max > 0 ? Math.min(max, delay) : delay;
  }

  #scheduleRetry(reason) {
    if (
      !this.started ||
      this.config.transport !== "sidecar" ||
      this.config.autoConnect !== true ||
      this.config.retryEnabled !== true ||
      !this.sidecarClient ||
      typeof this.setTimeout !== "function"
    ) {
      return false;
    }
    if (this.retryTimer != null) return false;
    if (this.config.retryMaxAttempts > 0 && this.retryAttempts >= this.config.retryMaxAttempts) {
      if (!this.retryExhausted) {
        this.retryExhausted = true;
        this.#log("warn", `sidecar retry exhausted after ${this.retryAttempts} attempt(s)`, { reason });
      }
      return false;
    }

    const attempt = this.retryAttempts + 1;
    const delayMs = this.#retryDelayMs();
    this.retryTimer = this.setTimeout(() => {
      this.retryTimer = null;
      if (!this.started) return;
      this.retryAttempts = attempt;
      this.#runSidecarRetry(reason);
    }, delayMs);
    this.#log("warn", `sidecar retry scheduled in ${delayMs}ms`, { reason, attempt, delayMs });
    return true;
  }

  #runSidecarRetry(reason) {
    if (!this.started || !this.sidecarClient) return;
    this.connectIssued = false;
    const sidecarStarted = this.#startSidecarProcess("retry");
    if (!sidecarStarted) return;
    this.#scheduleContentionDiagnostics("retry");
    const issued = this.#startSidecarConnect();
    if (!issued) {
      this.#scheduleRetry(`sidecar retry command failed after ${reason}`);
    }
  }
}

function callbackValue(target, method, fallback) {
  if (!target || typeof target[method] !== "function") return fallback;
  const value = target[method]();
  return value == null ? fallback : value;
}

module.exports = {
  HeadlessHardwareBuddyRuntime,
  buildSidecarArgs,
  connectTargetForConfig,
};

function serializeError(err) {
  if (!err) return null;
  return {
    message: err && err.message ? err.message : String(err),
    ...(typeof err.code === "string" && err.code ? { code: err.code } : {}),
  };
}
