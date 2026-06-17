"use strict";

const {
  isHardwareEligiblePermission,
  sanitizeLine,
  shortHintFor,
  truncateUtf8,
} = require("./eligibility");

const RUNNING_STATES = new Set([
  "working",
  "thinking",
  "juggling",
  "carrying",
  "sweeping",
]);

const DEFAULT_STATE_PRIORITY = Object.freeze({
  sweeping: 6,
  carrying: 4,
  juggling: 4,
  working: 3,
  thinking: 2,
  idle: 1,
  sleeping: 0,
});

function normalizeSessions(sessionSnapshot) {
  if (Array.isArray(sessionSnapshot)) return sessionSnapshot.filter(Boolean);
  if (sessionSnapshot && Array.isArray(sessionSnapshot.sessions)) {
    return sessionSnapshot.sessions.filter(Boolean);
  }
  return [];
}

function numericTime(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function nonNegativeInteger(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

function isVisibleHardwareSession(session) {
  return !!(
    session &&
    session.headless !== true &&
    session.hiddenFromHud !== true &&
    session.state !== "sleeping"
  );
}

function sessionTitle(session) {
  return sanitizeLine(session && (session.displayTitle || session.sessionTitle || session.id));
}

function sessionPriority(session, statePriority = DEFAULT_STATE_PRIORITY) {
  return (statePriority && statePriority[session && session.state]) || 0;
}

function compareRunningSessions(a, b, statePriority = DEFAULT_STATE_PRIORITY) {
  const byPriority = sessionPriority(b, statePriority) - sessionPriority(a, statePriority);
  if (byPriority !== 0) return byPriority;
  const byTime = numericTime(b && b.updatedAt) - numericTime(a && a.updatedAt);
  if (byTime !== 0) return byTime;
  return String(a && a.id).localeCompare(String(b && b.id));
}

function compareNewest(a, b) {
  const byTime = numericTime(b && b.updatedAt) - numericTime(a && a.updatedAt);
  if (byTime !== 0) return byTime;
  return String(a && a.id).localeCompare(String(b && b.id));
}

function comparePermissionsNewest(a, b) {
  const byTime = numericTime(b.entry && b.entry.createdAt) - numericTime(a.entry && a.entry.createdAt);
  if (byTime !== 0) return byTime;
  return String(a.id).localeCompare(String(b.id));
}

function formatEntry(session, maxBytes) {
  const title = sessionTitle(session);
  if (!title) return "";
  const event = session && session.lastEvent
    ? sanitizeLine(session.lastEvent.rawEvent || session.lastEvent.labelKey || "")
    : "";
  const line = event ? `${title} - ${event}` : title;
  return truncateUtf8(line, maxBytes);
}

function buildSessionById(sessions) {
  const map = new Map();
  for (const session of sessions) {
    const id = session && session.id;
    if (id) map.set(id, session);
  }
  return map;
}

function collectHardwarePromptEntries({
  sessionSnapshot,
  pendingPermissions,
  doNotDisturb,
  transportSecure,
  isAgentEnabled,
  isAgentPermissionsEnabled,
}) {
  const sessions = normalizeSessions(sessionSnapshot);
  const sessionById = buildSessionById(sessions);
  const entries = [];
  for (const entry of Array.isArray(pendingPermissions) ? pendingPermissions : []) {
    if (isHardwareEligiblePermission(entry, {
      doNotDisturb: doNotDisturb === true,
      transportSecure: transportSecure === true,
      sessionById,
      isAgentEnabled,
      isAgentPermissionsEnabled,
    })) {
      entries.push(entry);
    }
  }
  return entries;
}

function buildPromptCandidates({
  pendingPermissions,
  sessionById,
  doNotDisturb,
  transportSecure,
  isAgentEnabled,
  isAgentPermissionsEnabled,
  getPromptId,
}) {
  const candidates = [];
  for (const entry of Array.isArray(pendingPermissions) ? pendingPermissions : []) {
    if (!isHardwareEligiblePermission(entry, {
      doNotDisturb,
      transportSecure,
      sessionById,
      isAgentEnabled,
      isAgentPermissionsEnabled,
    })) {
      continue;
    }

    const id = getPromptId(entry);
    if (typeof id !== "string" || !id) continue;
    candidates.push({ entry, id });
  }
  candidates.sort(comparePermissionsNewest);
  return candidates;
}

function buildHardwareBuddyHeartbeat(options = {}) {
  const sessions = normalizeSessions(options.sessionSnapshot);
  const visibleSessions = sessions.filter(isVisibleHardwareSession);
  const statePriority = options.statePriority || DEFAULT_STATE_PRIORITY;
  const runningSessions = visibleSessions
    .filter((session) => RUNNING_STATES.has(session && session.state))
    .sort((a, b) => compareRunningSessions(a, b, statePriority));
  const newestSessions = visibleSessions.slice().sort(compareNewest);
  const sessionById = buildSessionById(sessions);
  const entriesCap = Math.max(0, Math.floor(Number(options.entriesCap) || 8));
  const entriesMaxBytes = Math.max(1, Math.floor(Number(options.entriesMaxBytes) || 60));
  const getPromptId = typeof options.getPromptId === "function"
    ? options.getPromptId
    : () => null;

  const promptCandidates = buildPromptCandidates({
    pendingPermissions: options.pendingPermissions,
    sessionById,
    doNotDisturb: options.doNotDisturb === true,
    transportSecure: options.transportSecure === true,
    isAgentEnabled: options.isAgentEnabled,
    isAgentPermissionsEnabled: options.isAgentPermissionsEnabled,
    getPromptId,
  });

  const heartbeat = {
    total: visibleSessions.length,
    running: runningSessions.length,
    waiting: promptCandidates.length,
    msg: "",
    entries: newestSessions
      .slice(0, entriesCap)
      .map((session) => formatEntry(session, entriesMaxBytes))
      .filter(Boolean),
    tokens: nonNegativeInteger(options.tokens),
    tokens_today: nonNegativeInteger(options.tokensToday),
  };

  const activePrompt = promptCandidates[0] || null;
  if (activePrompt) {
    const tool = sanitizeLine(activePrompt.entry.toolName) || "Unknown";
    heartbeat.msg = `approve: ${tool}`;
    heartbeat.prompt = {
      id: activePrompt.id,
      tool,
      hint: shortHintFor(activePrompt.entry, { maxBytes: 80 }),
    };
    return heartbeat;
  }

  if (runningSessions.length) {
    heartbeat.msg = sessionTitle(runningSessions[0]);
    // Forward the highest-priority session state so the firmware can show
    // the exact clawd expression (juggling, sweeping, etc.) instead of
    // deriving it from session counters alone.
    heartbeat.state = runningSessions[0].state || "working";
  } else if (newestSessions.length) {
    heartbeat.msg = sessionTitle(newestSessions[0]);
    heartbeat.state = newestSessions[0].state || "idle";
  }

  return heartbeat;
}

module.exports = {
  DEFAULT_STATE_PRIORITY,
  RUNNING_STATES,
  buildHardwareBuddyHeartbeat,
  collectHardwarePromptEntries,
  isVisibleHardwareSession,
};
