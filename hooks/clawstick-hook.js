#!/usr/bin/env node
// Clawstick Hook — bridges Claude Code events to the clawstick bridge runtime
// Usage: node clawstick-hook.js <event_name>
// Reads stdin JSON from Claude Code, translates to clawstick session format,
// and POSTs to the bridge HTTP server on port 27217.

const http = require("http");

const BRIDGE_HOST = "127.0.0.1";
const BRIDGE_PORT = 27217;
const BRIDGE_PATH = "/state";
const BRIDGE_TIMEOUT_MS = 200;

const EVENT_TO_SESSION_STATE = {
  SessionStart: "idle",
  SessionEnd: "sleeping",
  UserPromptSubmit: "thinking",
  PreToolUse: "working",
  PostToolUse: "working",
  PostToolUseFailure: "error",
  Stop: "attention",
  StopFailure: "error",
  SubagentStart: "juggling",
  SubagentStop: "working",
  PreCompact: "sweeping",
  PostCompact: "thinking",
  Notification: "notification",
  Elicitation: "notification",
  WorktreeCreate: "carrying",
  PermissionRequest: "attention",
};

const TOOL_STATE_OVERRIDES = {
  Task: { state: "juggling", label: "delegating" },
  Agent: { state: "juggling", label: "delegating" },
  Read: { state: "reading", label: "reading" },
  Grep: { state: "reading", label: "searching" },
  Glob: { state: "reading", label: "scanning" },
  Bash: { state: "working", label: "executing" },
  Edit: { state: "working", label: "editing" },
  Write: { state: "working", label: "writing" },
  NotebookEdit: { state: "working", label: "editing" },
};

function readStdinJson() {
  return new Promise((resolve) => {
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => { data += chunk; });
    process.stdin.on("end", () => {
      try { resolve(JSON.parse(data)); } catch { resolve({}); }
    });
    process.stdin.on("error", () => resolve({}));
  });
}

function buildSessionFromEvent(event, payload) {
  const sessionId = payload.session_id || "default";
  let state = EVENT_TO_SESSION_STATE[event] || "idle";

  const toolName = payload.tool_name || "";
  if (event === "PreToolUse" && toolName === "Task") {
    state = "juggling";
  } else if (toolName && TOOL_STATE_OVERRIDES[toolName] && state === "working") {
    state = TOOL_STATE_OVERRIDES[toolName].state;
  }

  let displayTitle = payload.session_title || "";
  if (!displayTitle && event === "UserPromptSubmit" && payload.prompt) {
    const firstLine = payload.prompt.split(/\r?\n/).find((l) => l.trim());
    if (firstLine) {
      displayTitle = firstLine.trim().slice(0, 60);
      if (firstLine.trim().length > 60) displayTitle += "…";
    }
  }

  const rawEvent = toolName || event;
  const labelKey = toolName && TOOL_STATE_OVERRIDES[toolName]
    ? TOOL_STATE_OVERRIDES[toolName].label : "";

  const session = {
    id: sessionId,
    state,
    displayTitle: displayTitle || sessionId,
    sessionTitle: displayTitle || sessionId,
    updatedAt: Date.now(),
    agentId: "claude-code",
    headless: false,
    hiddenFromHud: false,
    lastEvent: { rawEvent },
  };
  if (labelKey) session.lastEvent.labelKey = labelKey;
  if (payload.cwd) session.cwd = payload.cwd;

  return session;
}

function buildPermissionFromEvent(event, payload) {
  if (event !== "PermissionRequest") return [];
  const sessionId = payload.session_id || "default";
  const toolName = payload.tool_name || "";
  if (!toolName) return [];

  const entry = {
    sessionId,
    agentId: "claude-code",
    toolName,
    toolInput: payload.tool_input || payload.input || {},
    createdAt: Date.now(),
  };
  return [entry];
}

function postToBridge(body) {
  const payload = JSON.stringify(body);
  const req = http.request(
    {
      hostname: BRIDGE_HOST,
      port: BRIDGE_PORT,
      path: BRIDGE_PATH,
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(payload),
      },
      timeout: BRIDGE_TIMEOUT_MS,
    },
    (res) => {
      res.resume();
      process.exit(0);
    }
  );
  req.on("error", () => process.exit(0));
  req.on("timeout", () => { req.destroy(); process.exit(0); });
  req.end(payload);
}

function main() {
  const event = process.argv[2];
  if (!EVENT_TO_SESSION_STATE[event]) process.exit(0);

  readStdinJson().then((payload) => {
    const session = buildSessionFromEvent(event, payload || {});
    const permissions = buildPermissionFromEvent(event, payload || {});
    const body = {
      sessions: [session],
      permissions,
      doNotDisturb: false,
    };
    postToBridge(body);
  }).catch(() => process.exit(0));
}

if (require.main === module) main();
