"use strict";

const DEFAULT_PASSTHROUGH_TOOLS = Object.freeze([
  "TaskCreate",
  "TaskUpdate",
  "TaskGet",
  "TaskList",
  "TaskStop",
  "TaskOutput",
]);

const DEFAULT_PASSTHROUGH_TOOL_SET = new Set(DEFAULT_PASSTHROUGH_TOOLS);
const NON_APPROVAL_TOOLS = new Set([
  "AskUserQuestion",
  "ExitPlanMode",
  ...DEFAULT_PASSTHROUGH_TOOLS,
]);

const CONTROL_RE = /[\u0000-\u001F\u007F-\u009F]+/g;

function sanitizeLine(value) {
  if (typeof value !== "string") return "";
  return value
    .replace(CONTROL_RE, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function truncateUtf8(value, maxBytes) {
  const limit = Math.max(0, Math.floor(Number(maxBytes) || 0));
  if (limit <= 0) return "";

  const clean = sanitizeLine(value);
  if (Buffer.byteLength(clean, "utf8") <= limit) return clean;
  if (limit <= 3) return ".".repeat(limit);

  const suffix = "...";
  let out = "";
  for (const ch of clean) {
    const next = out + ch;
    if (Buffer.byteLength(next + suffix, "utf8") > limit) break;
    out = next;
  }
  return `${out.trimEnd()}${suffix}`;
}

function basenameLike(value) {
  const clean = sanitizeLine(value);
  if (!clean) return "";
  const parts = clean.split(/[\\/]+/).filter(Boolean);
  return parts.length ? parts[parts.length - 1] : clean;
}

function permissionAgentId(permEntry) {
  if (!permEntry || typeof permEntry !== "object") return "claude-code";
  if (permEntry.isCodex || permEntry.agentId === "codex") return "codex";
  if (permEntry.isPi || permEntry.agentId === "pi") return "pi";
  if (permEntry.isOpencode || permEntry.agentId === "opencode") return "opencode";
  if (permEntry.isKimiNotify || permEntry.agentId === "kimi-cli") return "kimi-cli";
  return sanitizeLine(permEntry.agentId) || "claude-code";
}

function getSessionById(sessionId, options = {}) {
  if (!sessionId) return null;
  if (typeof options.getSessionById === "function") {
    return options.getSessionById(sessionId) || null;
  }
  const map = options.sessionById || options.sessionsById;
  if (map && typeof map.get === "function") return map.get(sessionId) || null;
  if (map && typeof map === "object") return map[sessionId] || null;
  return null;
}

function isPermissionHeadless(permEntry, options = {}) {
  if (permEntry && permEntry.headless === true) return true;
  const sessionId = permEntry && permEntry.sessionId;
  if (!sessionId) return true;
  const session = getSessionById(sessionId, options);
  return !session || session.headless === true;
}

function isEnabledByGate(fn, agentId) {
  if (typeof fn !== "function") return true;
  return fn(agentId) !== false;
}

function getPassthroughToolSet(options = {}) {
  const provided = options.passthroughTools;
  if (!provided) return DEFAULT_PASSTHROUGH_TOOL_SET;
  if (provided instanceof Set) return provided;
  if (Array.isArray(provided)) return new Set(provided);
  return DEFAULT_PASSTHROUGH_TOOL_SET;
}

function isHardwareEligiblePermission(permEntry, options = {}) {
  if (!permEntry || typeof permEntry !== "object") return false;
  if (options.doNotDisturb === true) return false;
  if (options.transportSecure !== true) return false;
  if (permEntry.isElicitation || permEntry.isCodexNotify || permEntry.isKimiNotify) return false;

  const toolName = sanitizeLine(permEntry.toolName);
  const passthroughTools = getPassthroughToolSet(options);
  if (NON_APPROVAL_TOOLS.has(toolName) || passthroughTools.has(toolName)) return false;
  if (isPermissionHeadless(permEntry, options)) return false;

  const agentId = permissionAgentId(permEntry);
  if (!isEnabledByGate(options.isAgentEnabled, agentId)) return false;
  if (!isEnabledByGate(options.isAgentPermissionsEnabled, agentId)) return false;

  return true;
}

function shortHintFor(permEntry, options = {}) {
  const maxBytes = Math.max(1, Math.floor(Number(options.maxBytes) || 80));
  const input = permEntry && permEntry.toolInput;
  let hint = "";

  if (typeof input === "string") {
    hint = input;
  } else if (input && typeof input === "object") {
    if (typeof input.command === "string") hint = input.command;
    else if (typeof input.description === "string") hint = input.description;
    else if (typeof input.query === "string") hint = input.query;
    else if (typeof input.pattern === "string") hint = input.pattern;
    else if (typeof input.file_path === "string") hint = `file: ${basenameLike(input.file_path)}`;
    else if (typeof input.path === "string") hint = `file: ${basenameLike(input.path)}`;
    else {
      const keys = Object.keys(input).filter(Boolean).slice(0, 3);
      if (keys.length) hint = `input: ${keys.join(", ")}`;
    }
  }

  return truncateUtf8(hint, maxBytes);
}

module.exports = {
  DEFAULT_PASSTHROUGH_TOOLS,
  sanitizeLine,
  truncateUtf8,
  permissionAgentId,
  isHardwareEligiblePermission,
  shortHintFor,
};
