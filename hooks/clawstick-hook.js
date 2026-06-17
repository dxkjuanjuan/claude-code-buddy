#!/usr/bin/env node
// Clawstick Hook — bridges Claude Code events to clawd-on-desk
// Usage: node clawstick-hook.js <event_name>
// Reads stdin JSON from Claude Code, translates to clawd-on-desk's
// flat /state format, and POSTs to port 23333.
//
// clawd-on-desk loads the clawstick bridge (controller + sidecar)
// internally, so posting to 23333 automatically pushes state to M5
// over BLE — no separate clawstick bridge process needed.
//
// Flat format matches clawd-on-desk's handleStatePost expectations:
//   state, session_id, event, agent_id, tool_name, session_title, cwd

const http = require("http");

const BRIDGE_HOST = "127.0.0.1";
const BRIDGE_PORT = 23333;
const BRIDGE_PATH = "/state";
const BRIDGE_TIMEOUT_MS = 500;

// Same mapping as clawd-on-desk hooks/clawd-hook.js EVENT_TO_STATE
// PermissionRequest is NOT here — it's handled by clawd-on-desk's HTTP hook
// (POST /permission) which is a blocking bidirectional hook for approval.
const EVENT_TO_STATE = {
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

function buildFlatBody(event, payload) {
  const sessionId = payload.session_id || "default";
  let state = EVENT_TO_STATE[event] || "idle";

  // Tool-specific state overrides for richer expressions
  const toolName = payload.tool_name || "";
  if (toolName === "Task" || toolName === "Agent") {
    state = "juggling";
  }

  // Build flat body matching clawd-on-desk's expected format
  const body = {
    state,
    session_id: sessionId,
    event,
    agent_id: "claude-code",
  };

  if (toolName) body.tool_name = toolName;
  if (payload.cwd) body.cwd = payload.cwd;

  // Session title from payload or extracted from prompt
  let title = payload.session_title || "";
  if (!title && event === "UserPromptSubmit" && payload.prompt) {
    const firstLine = payload.prompt.split(/\r?\n/).find((l) => l.trim());
    if (firstLine) {
      title = firstLine.trim().slice(0, 40);
      if (firstLine.trim().length > 40) title += "…";
    }
  }
  if (title) body.session_title = title;

  return body;
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
  if (!EVENT_TO_STATE[event]) process.exit(0);

  readStdinJson().then((payload) => {
    const body = buildFlatBody(event, payload || {});
    postToBridge(body);
  }).catch(() => process.exit(0));
}

if (require.main === module) main();
