"use strict";

const QUICK_COMMAND_EVENT_VERSION = 1;
const QUICK_COMMAND_TARGET_SCOPE = "active_session";
const QUICK_COMMAND_TARGET_RESOLUTION_DEFERRED = "defer_to_adapter";
const QUICK_COMMAND_TARGET_RESOLUTION_CLIENT = "client_provided";
const QUICK_COMMAND_CONSTRAINT_DURATION = "next_turn";

const QUICK_COMMAND_PRESETS = Object.freeze([
  Object.freeze({ id: "continue", label: "继续" }),
  Object.freeze({ id: "correct", label: "不是这样的" }),
  Object.freeze({ id: "no_commit", label: "不要 commit" }),
  Object.freeze({ id: "no_source_edits", label: "不要改源文件" }),
  Object.freeze({ id: "show_diff", label: "show diff" }),
  Object.freeze({ id: "plain_language", label: "说人话" }),
  Object.freeze({ id: "plan_first", label: "先列计划" }),
]);

const PRESETS_BY_ID = new Map(QUICK_COMMAND_PRESETS.map((preset) => [preset.id, preset]));
const QUICK_COMMAND_CONSTRAINT_IDS = new Set(["no_commit", "no_source_edits"]);
const QUICK_COMMAND_SOURCES = new Set(["tray", "hardware", "http", "cli", "test"]);

function cleanString(value) {
  return typeof value === "string" ? value.trim() : "";
}

function plainObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : null;
}

function badRequest(code, message) {
  return Object.assign(new Error(message), {
    statusCode: 400,
    error: code,
    code,
  });
}

function getQuickCommandPreset(id) {
  return PRESETS_BY_ID.get(cleanString(id)) || null;
}

function isQuickCommandPresetId(id) {
  return !!getQuickCommandPreset(id);
}

function assertQuickCommandPresetId(id) {
  const preset = getQuickCommandPreset(id);
  if (!preset) {
    throw badRequest("invalid_quick_command", `unknown quick command preset: ${cleanString(id) || "<empty>"}`);
  }
  return preset;
}

function isConstraintQuickCommand(id) {
  return QUICK_COMMAND_CONSTRAINT_IDS.has(cleanString(id));
}

function normalizeQuickCommandSource(value) {
  const clean = cleanString(value).toLowerCase();
  if (!clean || !QUICK_COMMAND_SOURCES.has(clean)) return "unknown";
  return clean;
}

function normalizeQuickCommandTarget(value) {
  const object = plainObject(value) || {};
  const scope = cleanString(object.scope) || QUICK_COMMAND_TARGET_SCOPE;
  if (scope !== QUICK_COMMAND_TARGET_SCOPE) {
    throw badRequest("invalid_quick_command_target", "quick command target.scope must be active_session");
  }
  const sessionId = cleanString(object.sessionId) || null;
  return {
    scope: QUICK_COMMAND_TARGET_SCOPE,
    sessionId,
    resolution: sessionId
      ? QUICK_COMMAND_TARGET_RESOLUTION_CLIENT
      : QUICK_COMMAND_TARGET_RESOLUTION_DEFERRED,
  };
}

function normalizeQuickCommandDuration(id, value) {
  const clean = cleanString(value);
  if (isConstraintQuickCommand(id)) {
    if (!clean || clean === QUICK_COMMAND_CONSTRAINT_DURATION) {
      return QUICK_COMMAND_CONSTRAINT_DURATION;
    }
    throw badRequest("invalid_quick_command_duration", "constraint quick command duration must be next_turn");
  }
  if (!clean) return null;
  throw badRequest("invalid_quick_command_duration", "message quick command duration must be null");
}

function normalizeQuickCommandUserText(value) {
  if (value == null) return null;
  const clean = cleanString(value);
  return clean || null;
}

function normalizeQuickCommandInput(input = {}) {
  const object = plainObject(input) || {};
  const preset = assertQuickCommandPresetId(object.id);
  const clientRequestId = cleanString(object.clientRequestId);
  if (!clientRequestId) {
    throw badRequest("missing_client_request_id", "clientRequestId is required");
  }
  const targetInput = plainObject(object.target) || {
    scope: object.scope,
    sessionId: object.sessionId,
  };

  return {
    type: "quick_command",
    version: QUICK_COMMAND_EVENT_VERSION,
    id: preset.id,
    label: preset.label,
    target: normalizeQuickCommandTarget(targetInput),
    duration: normalizeQuickCommandDuration(preset.id, object.duration),
    source: normalizeQuickCommandSource(object.source),
    clientRequestId,
    userText: normalizeQuickCommandUserText(object.userText),
  };
}

function createQuickCommandEvent(input = {}, options = {}) {
  const normalized = normalizeQuickCommandInput(input);
  return {
    seq: options.seq,
    ...normalized,
    createdAt: Number.isFinite(Number(options.createdAt)) ? Number(options.createdAt) : Date.now(),
  };
}

module.exports = {
  QUICK_COMMAND_CONSTRAINT_DURATION,
  QUICK_COMMAND_EVENT_VERSION,
  QUICK_COMMAND_PRESETS,
  QUICK_COMMAND_TARGET_RESOLUTION_CLIENT,
  QUICK_COMMAND_TARGET_RESOLUTION_DEFERRED,
  QUICK_COMMAND_TARGET_SCOPE,
  assertQuickCommandPresetId,
  createQuickCommandEvent,
  getQuickCommandPreset,
  isConstraintQuickCommand,
  isQuickCommandPresetId,
  normalizeQuickCommandDuration,
  normalizeQuickCommandInput,
  normalizeQuickCommandSource,
  normalizeQuickCommandTarget,
  normalizeQuickCommandUserText,
};
