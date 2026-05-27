"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert");

const {
  findSidecarContention,
  formatContentionSummary,
  isHardwareBuddySidecar,
  isNoDeviceSidecarError,
  normalizeProcessList,
} = require("../src/runtime/sidecar-contention");

describe("hardware buddy sidecar contention helpers", () => {
  it("normalizes Windows and ps-style process records", () => {
    assert.deepStrictEqual(normalizeProcessList([
      {
        ProcessId: "42",
        ParentProcessId: "7",
        ProcessName: "python.exe",
        CommandLine: "python hardware_buddy_bridge.py --backend bleak",
      },
      {
        pid: 9,
        parentPid: 1,
        processName: "node",
        commandLine: "node bin/claudebuddy.js",
      },
      null,
      { ProcessName: "missing pid" },
    ]), [
      {
        pid: 42,
        parentPid: 7,
        processName: "python.exe",
        commandLine: "python hardware_buddy_bridge.py --backend bleak",
      },
      {
        pid: 9,
        parentPid: 1,
        processName: "node",
        commandLine: "node bin/claudebuddy.js",
      },
    ]);
  });

  it("matches only Hardware Buddy sidecars for the requested backend", () => {
    assert.strictEqual(isHardwareBuddySidecar({
      commandLine: "python C:\\Projects\\ClaudeBuddy\\tools\\hardware_buddy_bridge.py --backend bleak --name-prefix Claude",
    }, { backend: "bleak" }), true);

    assert.strictEqual(isHardwareBuddySidecar({
      commandLine: "python C:\\Projects\\ClaudeBuddy\\tools\\hardware_buddy_bridge.py --backend fake",
    }, { backend: "bleak" }), false);

    assert.strictEqual(isHardwareBuddySidecar({
      commandLine: "python unrelated.py --backend bleak",
    }, { backend: "bleak" }), false);
  });

  it("reports stale Electron-owned BLE sidecars and ignores current runtime pids", () => {
    const report = findSidecarContention([
      {
        ProcessId: 100,
        ParentProcessId: 50,
        ProcessName: "python.exe",
        CommandLine: "python C:\\Projects\\ClaudeBuddy\\tools\\hardware_buddy_bridge.py --backend bleak --name-prefix Claude",
      },
      {
        ProcessId: 101,
        ParentProcessId: 51,
        ProcessName: "python.exe",
        CommandLine: "python C:\\Projects\\ClaudeBuddy\\tools\\hardware_buddy_bridge.py --backend bleak --name-prefix Claude",
      },
      {
        ProcessId: 50,
        ProcessName: "electron.exe",
        CommandLine: "C:\\Projects\\animation\\node_modules\\electron\\dist\\electron.exe .",
      },
    ], {
      backend: "bleak",
      currentPid: 1,
      ignorePids: [101],
    });

    assert.strictEqual(report.hasContention, true);
    assert.strictEqual(report.matches.length, 1);
    assert.strictEqual(report.matches[0].pid, 100);
    assert.strictEqual(report.matches[0].owner, "Clawd Electron");
    assert.strictEqual(report.matches[0].parent.pid, 50);
    assert.match(formatContentionSummary(report), /device not found or devices=0/);
  });

  it("labels another standalone CLI separately from Clawd", () => {
    const report = findSidecarContention([
      {
        ProcessId: 200,
        ParentProcessId: 150,
        ProcessName: "python.exe",
        CommandLine: "python C:\\Projects\\ClaudeBuddy\\tools\\hardware_buddy_bridge.py --backend bleak",
      },
      {
        ProcessId: 150,
        ProcessName: "node.exe",
        CommandLine: "node C:\\Projects\\ClaudeBuddy\\bin\\claudebuddy.js --transport sidecar --backend bleak",
      },
    ], {
      backend: "bleak",
    });

    assert.strictEqual(report.matches[0].owner, "Another ClaudeBuddy CLI");
    assert.doesNotMatch(formatContentionSummary(report), /owner=Clawd/);
  });

  it("does not repeat Clawd-specific guidance for another standalone CLI", () => {
    const report = findSidecarContention([
      {
        ProcessId: 200,
        ParentProcessId: 150,
        ProcessName: "python.exe",
        CommandLine: "python C:\\Projects\\ClaudeBuddy\\tools\\hardware_buddy_bridge.py --backend bleak",
      },
      {
        ProcessId: 150,
        ProcessName: "node.exe",
        CommandLine: "node C:\\Projects\\ClaudeBuddy\\bin\\claudebuddy.js --transport sidecar --backend bleak",
      },
    ], {
      backend: "bleak",
    });

    assert.match(formatContentionSummary(report), /another ClaudeBuddy CLI/i);
  });

  it("classifies NO_DEVICE sidecar errors", () => {
    assert.strictEqual(isNoDeviceSidecarError({ code: "NO_DEVICE", message: "anything" }), true);
    assert.strictEqual(isNoDeviceSidecarError({ message: "device not found" }), true);
    assert.strictEqual(isNoDeviceSidecarError({ code: "AUTH_REQUIRED", message: "pair first" }), false);
  });
});
