"use strict";

const {
  assertQuickCommandPresetId,
  isConstraintQuickCommand,
} = require("../runtime/quick-command-presets");

const MESSAGE_TEXT_BY_ID = Object.freeze({
  continue: "继续",
  correct: "不是这样的",
  plain_language: "说人话",
  plan_first: "先列计划",
});

const CONSTRAINT_BY_ID = Object.freeze({
  no_commit: Object.freeze({
    id: "no_commit",
    kind: "safety",
    policy: "no_commits",
    duration: "next_turn",
  }),
  no_source_edits: Object.freeze({
    id: "no_source_edits",
    kind: "workspace",
    policy: "no_source_edits",
    duration: "next_turn",
  }),
});

function cleanString(value) {
  return typeof value === "string" ? value.trim() : "";
}

function plainObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : null;
}

function isoTime(value) {
  if (value instanceof Date && Number.isFinite(value.getTime())) return value.toISOString();
  const n = Number(value);
  const date = new Date(Number.isFinite(n) ? n : Date.now());
  return Number.isFinite(date.getTime()) ? date.toISOString() : new Date().toISOString();
}

function clonePlainObject(value, fallback = null) {
  const object = plainObject(value);
  return object ? { ...object } : fallback;
}

function commandBase(command, options = {}) {
  const object = plainObject(command) || {};
  const preset = assertQuickCommandPresetId(object.id);
  return {
    type: "quick_command_action",
    version: 1,
    commandSeq: Number.isFinite(Number(object.seq)) ? Number(object.seq) : null,
    commandId: preset.id,
    label: cleanString(object.label) || preset.label,
    target: clonePlainObject(object.target, {
      scope: "active_session",
      sessionId: null,
      resolution: "defer_to_adapter",
    }),
    source: cleanString(object.source) || "unknown",
    clientRequestId: cleanString(object.clientRequestId),
    createdAt: Number.isFinite(Number(object.createdAt)) ? Number(object.createdAt) : null,
    mappedAt: isoTime(typeof options.now === "function" ? options.now() : options.now),
  };
}

function messageTextForCommand(command) {
  const object = plainObject(command) || {};
  const id = cleanString(object.id);
  if (id === "correct") {
    return cleanString(object.userText) || MESSAGE_TEXT_BY_ID.correct;
  }
  return MESSAGE_TEXT_BY_ID[id] || "";
}

function mapQuickCommandToAdapterAction(command, options = {}) {
  const object = plainObject(command) || {};
  const preset = assertQuickCommandPresetId(object.id);
  const base = commandBase(command, options);

  if (Object.prototype.hasOwnProperty.call(MESSAGE_TEXT_BY_ID, preset.id)) {
    return {
      ...base,
      action: "message",
      message: {
        text: messageTextForCommand(object),
      },
    };
  }

  if (isConstraintQuickCommand(preset.id)) {
    const duration = cleanString(object.duration) || CONSTRAINT_BY_ID[preset.id].duration;
    if (duration !== "next_turn") {
      throw new Error(`unsupported quick command constraint duration: ${duration}`);
    }
    return {
      ...base,
      action: "constraint",
      constraint: {
        ...CONSTRAINT_BY_ID[preset.id],
        duration,
      },
    };
  }

  if (preset.id === "show_diff") {
    return {
      ...base,
      action: "local_action",
      localAction: {
        id: "show_diff",
        runShell: false,
      },
    };
  }

  throw new Error(`quick command preset has no adapter action mapping: ${preset.id}`);
}

module.exports = {
  CONSTRAINT_BY_ID,
  MESSAGE_TEXT_BY_ID,
  mapQuickCommandToAdapterAction,
};
