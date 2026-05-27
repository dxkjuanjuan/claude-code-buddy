"use strict";

const { execFileSync } = require("node:child_process");
const path = require("node:path");

function cleanString(value) {
  return typeof value === "string" ? value.trim() : "";
}

function numberOrNull(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function normalizeProcessRecord(record) {
  if (!record || typeof record !== "object") return null;
  const pid = numberOrNull(record.pid ?? record.PID ?? record.ProcessId ?? record.Id);
  if (pid == null) return null;
  return {
    pid,
    parentPid: numberOrNull(record.parentPid ?? record.PPID ?? record.ParentProcessId),
    processName: cleanString(record.processName ?? record.ProcessName ?? record.Name),
    commandLine: cleanString(record.commandLine ?? record.CommandLine ?? record.args),
  };
}

function normalizeProcessList(records) {
  if (!Array.isArray(records)) return [];
  return records.map(normalizeProcessRecord).filter(Boolean);
}

function lowerCommand(processInfo) {
  return cleanString(processInfo && processInfo.commandLine).toLowerCase();
}

function commandHasBackend(commandLine, backend) {
  const escaped = backend.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`--backend(?:\\s+|=)${escaped}(?:\\s|$)`, "i").test(commandLine);
}

function commandLooksLikeSidecar(commandLine, sidecarScript) {
  const lower = cleanString(commandLine).toLowerCase();
  if (!lower) return false;
  if (lower.includes("hardware_buddy_bridge.py")) return true;
  const basename = path.basename(cleanString(sidecarScript)).toLowerCase();
  return !!(basename && lower.includes(basename));
}

function isHardwareBuddySidecar(processInfo, options = {}) {
  const commandLine = cleanString(processInfo && processInfo.commandLine);
  if (!commandLooksLikeSidecar(commandLine, options.sidecarScript)) return false;
  if (options.backend && !commandHasBackend(commandLine, options.backend)) return false;
  return true;
}

function buildProcessMap(processes) {
  const map = new Map();
  for (const processInfo of normalizeProcessList(processes)) {
    map.set(processInfo.pid, processInfo);
  }
  return map;
}

function parentSummary(parent) {
  if (!parent) return "";
  const name = parent.processName || "unknown";
  const command = parent.commandLine || "";
  return command ? `${name} ${command}` : name;
}

function describeOwner(parent) {
  const text = `${parent && parent.processName ? parent.processName : ""} ${parent && parent.commandLine ? parent.commandLine : ""}`.toLowerCase();
  if (
    text.includes("claudebuddy.js") ||
    text.includes("bin\\claudebuddy") ||
    text.includes("bin/claudebuddy")
  ) {
    return "Another ClaudeBuddy CLI";
  }
  // These are diagnostic labels only. The standalone runtime must not import
  // Clawd/Electron or depend on their process model.
  if (text.includes("electron") && text.includes("\\animation")) return "Clawd Electron";
  if (text.includes("electron")) return "Electron";
  if (text.includes("\\animation")) return "Clawd";
  return parent && parent.processName ? parent.processName : "unknown";
}

function findSidecarContention(processes, options = {}) {
  const normalized = normalizeProcessList(processes);
  const processMap = buildProcessMap(normalized);
  const ignored = new Set([
    ...(Array.isArray(options.ignorePids) ? options.ignorePids : []),
    options.currentPid,
  ].filter((pid) => Number.isFinite(Number(pid))).map((pid) => Number(pid)));

  const matches = [];
  for (const processInfo of normalized) {
    if (ignored.has(processInfo.pid)) continue;
    if (!isHardwareBuddySidecar(processInfo, {
      backend: options.backend || "bleak",
      sidecarScript: options.sidecarScript,
    })) {
      continue;
    }
    const parent = processInfo.parentPid == null ? null : processMap.get(processInfo.parentPid) || null;
    matches.push({
      ...processInfo,
      owner: describeOwner(parent),
      parent: parent ? {
        pid: parent.pid,
        processName: parent.processName,
        commandLine: parent.commandLine,
      } : null,
    });
  }

  return {
    hasContention: matches.length > 0,
    matches,
  };
}

function formatContentionSummary(report) {
  const matches = report && Array.isArray(report.matches) ? report.matches : [];
  if (!matches.length) return "";
  const owners = new Set(matches.map((match) => match.owner));
  const details = matches
    .slice(0, 3)
    .map((match) => {
      const parent = match.parent ? ` parent=${match.parent.pid} ${parentSummary(match.parent)}` : "";
      return `pid=${match.pid} owner=${match.owner}${parent}`;
    })
    .join("; ");
  const guidance = owners.has("Another ClaudeBuddy CLI") && !owners.has("Clawd Electron") && !owners.has("Clawd")
    ? "Stop the other ClaudeBuddy CLI or old sidecar for isolated standalone BLE runs."
    : "Stop Clawd or the old sidecar for isolated standalone BLE runs.";
  return `existing Hardware Buddy BLE sidecar detected (${details}); this can make bleak report device not found or devices=0. ${guidance}`;
}

function isNoDeviceSidecarError(err) {
  if (!err) return false;
  const code = typeof err.code === "string" ? err.code.toUpperCase() : "";
  const message = typeof err.message === "string" ? err.message.toLowerCase() : String(err).toLowerCase();
  return code === "NO_DEVICE" || /device not found/.test(message);
}

function defaultListProcesses() {
  if (process.platform === "win32") {
    const script = [
      "Get-CimInstance Win32_Process",
      "Select-Object ProcessId,ParentProcessId,ProcessName,CommandLine",
      "ConvertTo-Json -Compress",
    ].join(" | ");
    const stdout = execFileSync("powershell.exe", [
      "-NoProfile",
      "-ExecutionPolicy",
      "Bypass",
      "-Command",
      script,
    ], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 5000,
      windowsHide: true,
    });
    if (!stdout.trim()) return [];
    const parsed = JSON.parse(stdout);
    return Array.isArray(parsed) ? parsed : [parsed];
  }

  const stdout = execFileSync("ps", ["-axo", "pid=,ppid=,comm=,args="], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 5000,
  });
  return stdout
    .split(/\r?\n/)
    .map((line) => {
      const match = line.match(/^\s*(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/);
      if (!match) return null;
      return {
        pid: Number(match[1]),
        parentPid: Number(match[2]),
        processName: match[3],
        commandLine: match[4],
      };
    })
    .filter(Boolean);
}

module.exports = {
  defaultListProcesses,
  findSidecarContention,
  formatContentionSummary,
  isHardwareBuddySidecar,
  isNoDeviceSidecarError,
  normalizeProcessList,
};
