"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert");

const {
  buildHardwareBuddyHeartbeat,
} = require("../src/hardware-buddy/snapshot");
const {
  isHardwareEligiblePermission,
  shortHintFor,
} = require("../src/hardware-buddy/eligibility");
const {
  PromptIdRegistry,
} = require("../src/hardware-buddy/prompt-id-registry");

function session(id, state, overrides = {}) {
  return {
    id,
    state,
    displayTitle: id,
    updatedAt: 1000,
    agentId: "claude-code",
    headless: false,
    hiddenFromHud: false,
    lastEvent: null,
    ...overrides,
  };
}

function snapshot(sessions) {
  return { sessions };
}

function perm(overrides = {}) {
  return {
    sessionId: "s1",
    agentId: "claude-code",
    toolName: "Bash",
    toolInput: { command: "npm test" },
    createdAt: 1000,
    ...overrides,
  };
}

function heartbeatFor(options) {
  return buildHardwareBuddyHeartbeat({
    sessionSnapshot: snapshot([session("s1", "working")]),
    pendingPermissions: [],
    isAgentEnabled: () => true,
    isAgentPermissionsEnabled: () => true,
    getPromptId: () => "hb_test",
    transportSecure: true,
    ...options,
  });
}

describe("hardware buddy snapshot builder", () => {
  it("emits an idle heartbeat for empty state", () => {
    const heartbeat = buildHardwareBuddyHeartbeat({});

    assert.deepStrictEqual(heartbeat, {
      total: 0,
      running: 0,
      waiting: 0,
      msg: "",
      entries: [],
      tokens: 0,
      tokens_today: 0,
    });
  });

  it("counts visible running sessions and uses the highest-priority title", () => {
    const heartbeat = heartbeatFor({
      sessionSnapshot: snapshot([
        session("idle", "idle", { updatedAt: 3000, displayTitle: "Idle repo" }),
        session("working", "working", {
          updatedAt: 1000,
          displayTitle: "Fix login",
          lastEvent: { rawEvent: "PreToolUse" },
        }),
        session("sweeping", "sweeping", { updatedAt: 2000, displayTitle: "Cleanup" }),
      ]),
    });

    assert.strictEqual(heartbeat.total, 3);
    assert.strictEqual(heartbeat.running, 2);
    assert.strictEqual(heartbeat.msg, "Cleanup");
    assert.deepStrictEqual(heartbeat.entries, [
      "Idle repo",
      "Cleanup",
      "Fix login - PreToolUse",
    ]);
  });

  it("excludes headless, hidden, and sleeping sessions from hardware totals", () => {
    const heartbeat = heartbeatFor({
      sessionSnapshot: snapshot([
        session("visible", "idle", { displayTitle: "Visible" }),
        session("headless", "working", { headless: true }),
        session("hidden", "working", { hiddenFromHud: true }),
        session("sleeping", "sleeping"),
      ]),
    });

    assert.strictEqual(heartbeat.total, 1);
    assert.strictEqual(heartbeat.running, 0);
    assert.deepStrictEqual(heartbeat.entries, ["Visible"]);
  });

  it("does not count notification as running", () => {
    const heartbeat = heartbeatFor({
      sessionSnapshot: snapshot([
        session("notify", "notification", { displayTitle: "Needs attention" }),
      ]),
    });

    assert.strictEqual(heartbeat.total, 1);
    assert.strictEqual(heartbeat.running, 0);
    assert.strictEqual(heartbeat.msg, "Needs attention");
  });

  it("exposes one actionable Claude permission prompt", () => {
    const entry = perm({ toolInput: { command: "git status" } });
    const heartbeat = heartbeatFor({
      pendingPermissions: [entry],
      getPromptId: (candidate) => candidate === entry ? "hb_1" : null,
    });

    assert.strictEqual(heartbeat.waiting, 1);
    assert.strictEqual(heartbeat.msg, "approve: Bash");
    assert.deepStrictEqual(heartbeat.prompt, {
      id: "hb_1",
      tool: "Bash",
      hint: "git status",
    });
  });

  it("does not expose prompts unless transport security is explicitly confirmed", () => {
    const heartbeat = buildHardwareBuddyHeartbeat({
      sessionSnapshot: snapshot([session("s1", "working")]),
      pendingPermissions: [perm()],
      getPromptId: () => "hb_1",
      isAgentEnabled: () => true,
      isAgentPermissionsEnabled: () => true,
    });

    assert.strictEqual(heartbeat.waiting, 0);
    assert.ok(!Object.prototype.hasOwnProperty.call(heartbeat, "prompt"));
  });

  it("does not expose prompts without a matching session context", () => {
    const missingSession = heartbeatFor({
      sessionSnapshot: snapshot([]),
      pendingPermissions: [perm()],
      getPromptId: () => "hb_missing",
    });
    const noSessionId = heartbeatFor({
      pendingPermissions: [perm({ sessionId: "" })],
      getPromptId: () => "hb_missing",
    });

    assert.strictEqual(missingSession.waiting, 0);
    assert.ok(!Object.prototype.hasOwnProperty.call(missingSession, "prompt"));
    assert.strictEqual(noSessionId.waiting, 0);
    assert.ok(!Object.prototype.hasOwnProperty.call(noSessionId, "prompt"));
  });

  it("supports Codex, Pi, and opencode once/deny-capable entries", () => {
    const cases = [
      perm({ agentId: "codex", isCodex: true }),
      perm({ agentId: "pi", isPi: true }),
      perm({ agentId: "opencode", isOpencode: true, opencodeAlwaysCandidates: ["Bash"] }),
    ];

    for (const [index, entry] of cases.entries()) {
      const heartbeat = heartbeatFor({
        pendingPermissions: [entry],
        getPromptId: () => `hb_${index + 1}`,
      });
      assert.strictEqual(heartbeat.waiting, 1);
      assert.strictEqual(heartbeat.prompt.id, `hb_${index + 1}`);
    }
  });

  it("suppresses prompts during DND and disabled agent gates", () => {
    const entry = perm();

    assert.strictEqual(heartbeatFor({
      pendingPermissions: [entry],
      doNotDisturb: true,
    }).waiting, 0);

    assert.strictEqual(heartbeatFor({
      pendingPermissions: [entry],
      isAgentEnabled: () => false,
    }).waiting, 0);

    assert.strictEqual(heartbeatFor({
      pendingPermissions: [entry],
      isAgentPermissionsEnabled: () => false,
    }).waiting, 0);
  });

  it("does not expose prompts on an insecure transport", () => {
    const heartbeat = heartbeatFor({
      pendingPermissions: [perm()],
      transportSecure: false,
    });

    assert.strictEqual(heartbeat.waiting, 0);
    assert.ok(!Object.prototype.hasOwnProperty.call(heartbeat, "prompt"));
  });

  it("excludes non-approval permission entry types from hardware prompts", () => {
    const excluded = [
      ["elicitation", perm({ isElicitation: true })],
      ["codex notify", perm({ isCodexNotify: true, agentId: "codex" })],
      ["kimi notify", perm({ isKimiNotify: true, agentId: "kimi-cli" })],
      ["ExitPlanMode", perm({ toolName: "ExitPlanMode" })],
      ["AskUserQuestion", perm({ toolName: "AskUserQuestion" })],
      ["passthrough", perm({ toolName: "TaskCreate" })],
    ];

    for (const [name, entry] of excluded) {
      const heartbeat = heartbeatFor({ pendingPermissions: [entry] });
      assert.strictEqual(heartbeat.waiting, 0, name);
      assert.ok(!Object.prototype.hasOwnProperty.call(heartbeat, "prompt"), name);
    }
  });

  it("excludes permissions whose session context is headless", () => {
    const entry = perm({ sessionId: "headless-session" });
    const heartbeat = heartbeatFor({
      sessionSnapshot: snapshot([
        session("headless-session", "working", { headless: true }),
      ]),
      pendingPermissions: [entry],
    });

    assert.strictEqual(heartbeat.waiting, 0);
    assert.ok(!Object.prototype.hasOwnProperty.call(heartbeat, "prompt"));
  });

  it("selects the newest eligible permission as the active prompt", () => {
    const older = perm({ toolName: "Read", createdAt: 1000, toolInput: { path: "a.txt" } });
    const newer = perm({ toolName: "Bash", createdAt: 2000, toolInput: { command: "npm test" } });
    const heartbeat = heartbeatFor({
      pendingPermissions: [older, newer],
      getPromptId: (entry) => entry === older ? "hb_old" : "hb_new",
    });

    assert.strictEqual(heartbeat.waiting, 2);
    assert.deepStrictEqual(heartbeat.prompt, {
      id: "hb_new",
      tool: "Bash",
      hint: "npm test",
    });
  });

  it("skips eligible permissions when no stable prompt id is available", () => {
    const heartbeat = heartbeatFor({
      pendingPermissions: [perm()],
      getPromptId: () => null,
    });

    assert.strictEqual(heartbeat.waiting, 0);
    assert.ok(!Object.prototype.hasOwnProperty.call(heartbeat, "prompt"));
  });

  it("caps and sanitizes entries before leaving the process", () => {
    const longTitle = `Repo\n${"x".repeat(80)}`;
    const heartbeat = heartbeatFor({
      sessionSnapshot: snapshot([
        session("old", "idle", { updatedAt: 1000, displayTitle: "Old" }),
        session("middle", "idle", { updatedAt: 2000, displayTitle: longTitle }),
        session("new", "idle", { updatedAt: 3000, displayTitle: "New\tProject" }),
      ]),
      entriesCap: 2,
      entriesMaxBytes: 20,
    });

    assert.strictEqual(heartbeat.entries.length, 2);
    assert.deepStrictEqual(heartbeat.entries[0], "New Project");
    assert.ok(Buffer.byteLength(heartbeat.entries[1], "utf8") <= 20);
    assert.ok(!/[\u0000-\u001F\u007F-\u009F]/.test(heartbeat.entries[1]));
  });

  it("defaults token counters to zero and accepts explicit non-negative values", () => {
    assert.strictEqual(heartbeatFor({ tokens: -1, tokensToday: "bad" }).tokens, 0);
    const heartbeat = heartbeatFor({ tokens: 12.7, tokensToday: 99 });
    assert.strictEqual(heartbeat.tokens, 12);
    assert.strictEqual(heartbeat.tokens_today, 99);
  });

  it("accepts an injected state priority table", () => {
    const heartbeat = heartbeatFor({
      sessionSnapshot: snapshot([
        session("working", "working", { displayTitle: "Working", updatedAt: 3000 }),
        session("thinking", "thinking", { displayTitle: "Thinking", updatedAt: 1000 }),
      ]),
      statePriority: {
        working: 1,
        thinking: 9,
      },
    });

    assert.strictEqual(heartbeat.msg, "Thinking");
  });
});

describe("hardware permission eligibility helpers", () => {
  it("keeps short hints bounded and control-character free", () => {
    const hint = shortHintFor(perm({
      toolInput: { command: `echo ok\n${"x".repeat(100)}` },
    }), { maxBytes: 30 });

    assert.ok(Buffer.byteLength(hint, "utf8") <= 30);
    assert.ok(!hint.includes("\n"));
    assert.match(hint, /\.\.\.$/);
  });

  it("fails closed for invalid permission entries", () => {
    assert.strictEqual(isHardwareEligiblePermission(null), false);
    assert.strictEqual(isHardwareEligiblePermission("bad"), false);
  });

  it("requires explicit transport security for direct eligibility checks", () => {
    const entry = perm();
    const sessionById = new Map([["s1", session("s1", "working")]]);

    assert.strictEqual(isHardwareEligiblePermission(entry, { sessionById }), false);
    assert.strictEqual(isHardwareEligiblePermission(entry, {
      sessionById,
      transportSecure: false,
    }), false);
    assert.strictEqual(isHardwareEligiblePermission(entry, {
      sessionById,
      transportSecure: true,
    }), true);
  });
});

describe("hardware prompt id registry", () => {
  it("keeps weak entry-to-id and strong id-to-entry mappings in sync", () => {
    const registry = new PromptIdRegistry();
    const first = {};
    const second = {};

    const firstId = registry.getPromptId(first);
    assert.strictEqual(firstId, "hb_1");
    assert.strictEqual(registry.getPromptId(first), firstId);
    assert.strictEqual(registry.resolvePromptId(firstId), first);

    const secondId = registry.getPromptId(second);
    assert.strictEqual(secondId, "hb_2");
    assert.strictEqual(registry.size, 2);

    assert.strictEqual(registry.syncActiveEntries([second]), 1);
    assert.strictEqual(registry.resolvePromptId(firstId), null);
    assert.strictEqual(registry.resolvePromptId(secondId), second);

    const newFirstId = registry.getPromptId(first);
    assert.strictEqual(newFirstId, "hb_3");
    assert.notStrictEqual(newFirstId, firstId);
  });
});
