"use strict";

const {
  HardwareBuddyController,
} = require("./hardware-buddy/controller");
const {
  mapQuickCommandToAdapterAction,
} = require("./adapters/quick-command-actions");
const {
  consumeQuickCommandsOnce,
  controlUrlFromConfig,
  readQuickCommands,
  runQuickCommandJsonlConsumer,
} = require("./adapters/quick-command-http-jsonl-consumer");
const {
  SidecarClient,
} = require("./hardware-buddy/sidecar-client");
const {
  buildHardwareBuddyHeartbeat,
} = require("./hardware-buddy/snapshot");
const {
  createRuntimeConfig,
  formatRuntimeHelp,
  parseRuntimeArgs,
} = require("./runtime/config");
const {
  HeadlessHardwareBuddyRuntime,
} = require("./runtime/headless-runtime");
const {
  HttpControlServer,
  createHttpControlServer,
} = require("./runtime/http-control-server");
const {
  JsonlQuickCommandConsumer,
  createJsonlQuickCommandConsumer,
  createQuickCommandConsumedRecord,
} = require("./runtime/jsonl-quick-command-consumer");
const {
  JsonFileHardwareBuddySource,
  createJsonFileHardwareBuddySource,
} = require("./runtime/json-file-source");
const {
  JsonlPermissionReplySink,
  createJsonlPermissionReplySink,
} = require("./runtime/jsonl-reply-sink");
const {
  MemoryQuickCommandSink,
  createMemoryQuickCommandSink,
} = require("./runtime/memory-quick-command-sink");
const {
  CompositePermissionReplySink,
  MemoryPermissionReplySink,
  createCompositePermissionReplySink,
  createMemoryPermissionReplySink,
} = require("./runtime/memory-reply-sink");
const {
  QUICK_COMMAND_PRESETS,
  getQuickCommandPreset,
  isConstraintQuickCommand,
  isQuickCommandPresetId,
  normalizeQuickCommandInput,
} = require("./runtime/quick-command-presets");
const {
  StaticHardwareBuddySource,
  createStaticHardwareBuddySource,
} = require("./runtime/static-source");
const {
  StdinJsonlHardwareBuddySource,
  createStdinJsonlHardwareBuddySource,
} = require("./runtime/stdin-jsonl-source");
const {
  MemoryTaskStateStore,
  createMemoryTaskStateStore,
  normalizeTaskStateInput,
} = require("./runtime/task-state");

module.exports = {
  HardwareBuddyController,
  HeadlessHardwareBuddyRuntime,
  HttpControlServer,
  JsonFileHardwareBuddySource,
  JsonlQuickCommandConsumer,
  JsonlPermissionReplySink,
  CompositePermissionReplySink,
  MemoryTaskStateStore,
  MemoryQuickCommandSink,
  MemoryPermissionReplySink,
  QUICK_COMMAND_PRESETS,
  SidecarClient,
  StaticHardwareBuddySource,
  StdinJsonlHardwareBuddySource,
  buildHardwareBuddyHeartbeat,
  createHttpControlServer,
  consumeQuickCommandsOnce,
  controlUrlFromConfig,
  createJsonFileHardwareBuddySource,
  createJsonlQuickCommandConsumer,
  createJsonlPermissionReplySink,
  createMemoryQuickCommandSink,
  createCompositePermissionReplySink,
  createMemoryPermissionReplySink,
  createMemoryTaskStateStore,
  createQuickCommandConsumedRecord,
  createRuntimeConfig,
  createStaticHardwareBuddySource,
  createStdinJsonlHardwareBuddySource,
  formatRuntimeHelp,
  getQuickCommandPreset,
  isConstraintQuickCommand,
  isQuickCommandPresetId,
  mapQuickCommandToAdapterAction,
  normalizeQuickCommandInput,
  normalizeTaskStateInput,
  parseRuntimeArgs,
  readQuickCommands,
  runQuickCommandJsonlConsumer,
};
