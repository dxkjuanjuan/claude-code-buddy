"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");

const repoRoot = path.resolve(__dirname, "..");

function findPowerShell() {
  for (const command of ["pwsh.exe", "powershell.exe"]) {
    const result = spawnSync(command, [
      "-NoProfile",
      "-Command",
      "$PSVersionTable.PSVersion.ToString()",
    ], {
      encoding: "utf8",
      windowsHide: true,
    });
    if (!result.error && result.status === 0) return command;
  }
  return null;
}

function runPowerShell(command, scriptName, args = [], options = {}) {
  return spawnSync(command, [
    "-NoProfile",
    "-ExecutionPolicy",
    "Bypass",
    "-File",
    path.join(repoRoot, "scripts", scriptName),
    ...args,
  ], {
    cwd: repoRoot,
    encoding: "utf8",
    timeout: options.timeout || 30000,
    windowsHide: true,
  });
}

function runPowerShellCommand(command, psCommand, options = {}) {
  return spawnSync(command, [
    "-NoProfile",
    "-ExecutionPolicy",
    "Bypass",
    "-Command",
    psCommand,
  ], {
    cwd: repoRoot,
    encoding: "utf8",
    timeout: options.timeout || 30000,
    windowsHide: true,
  });
}

function hasScheduledTaskCmdlets(command) {
  const result = spawnSync(command, [
    "-NoProfile",
    "-Command",
    "Get-Command Get-ScheduledTask,Get-ScheduledTaskInfo,Register-ScheduledTask,Unregister-ScheduledTask -ErrorAction Stop | Out-Null",
  ], {
    encoding: "utf8",
    windowsHide: true,
  });
  return !result.error && result.status === 0;
}

function hasWScriptShell(command) {
  const result = spawnSync(command, [
    "-NoProfile",
    "-Command",
    "try { New-Object -ComObject WScript.Shell | Out-Null; exit 0 } catch { exit 1 }",
  ], {
    encoding: "utf8",
    windowsHide: true,
  });
  return !result.error && result.status === 0;
}

function parseJsonOutput(output) {
  const start = output.indexOf("{");
  const end = output.lastIndexOf("}");
  assert.notStrictEqual(start, -1, `expected JSON object in output:\n${output}`);
  assert.ok(end > start, `expected complete JSON object in output:\n${output}`);
  return JSON.parse(output.slice(start, end + 1));
}

function readPid(pidFile) {
  try {
    const raw = fs.readFileSync(pidFile, "utf8").trim();
    const pid = Number(raw);
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

function writeJson(file, value) {
  fs.writeFileSync(file, JSON.stringify(value, null, 2), "utf8");
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close((err) => {
        if (err) reject(err);
        else resolve(port);
      });
    });
    server.on("error", reject);
  });
}

describe("claudebuddy Windows daemon scripts", () => {
  it("start, report, avoid duplicate start, and stop a fake daemon", {
    skip: process.platform !== "win32",
  }, async (t) => {
    const powerShell = findPowerShell();
    if (!powerShell) {
      t.skip("PowerShell is required for Windows daemon script tests");
      return;
    }

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "claudebuddy-daemon-scripts-"));
    const configPath = path.join(dir, "daemon.config.json");
    const pidFile = path.join(dir, "daemon.pid");
    const logFile = path.join(dir, "daemon.log");
    const port = await freePort();

    writeJson(configPath, {
      transport: "fake",
      sourceTitle: "Daemon Script Test",
      sourceState: "working",
      keepaliveMs: 0,
      permissionReplies: false,
      controlServer: true,
      controlHost: "127.0.0.1",
      controlPort: port,
      logFile,
      logLevel: "warn",
    });

    t.after(() => {
      runPowerShell(powerShell, "stop-claudebuddy-daemon.ps1", [
        "-Config",
        configPath,
        "-PidFile",
        pidFile,
        "-TimeoutSec",
        "5",
      ]);
      fs.rmSync(dir, { recursive: true, force: true });
    });

    const start = runPowerShell(powerShell, "start-claudebuddy-daemon.ps1", [
      "-Config",
      configPath,
      "-PidFile",
      pidFile,
      "-Node",
      process.execPath,
      "-ReadyTimeoutSec",
      "10",
    ]);
    assert.strictEqual(start.status, 0, `${start.stdout}\n${start.stderr}`);
    assert.match(start.stdout, /Started ClaudeBuddy daemon/);
    assert.match(start.stdout, /Transport: connected=True secure=True/);

    const daemonPid = readPid(pidFile);
    assert.ok(daemonPid, "expected daemon PID file to contain a live PID");

    const status = runPowerShell(powerShell, "status-claudebuddy-daemon.ps1", [
      "-Config",
      configPath,
      "-PidFile",
      pidFile,
      "-Json",
    ]);
    assert.strictEqual(status.status, 0, `${status.stdout}\n${status.stderr}`);
    const body = parseJsonOutput(status.stdout);
    assert.strictEqual(body.running, true);
    assert.strictEqual(body.pid, daemonPid);
    assert.strictEqual(body.control.enabled, true);
    assert.strictEqual(body.control.ok, true);
    assert.strictEqual(body.health.ok, true);
    assert.strictEqual(body.status.started, true);
    assert.strictEqual(body.status.transport.type, "fake");
    assert.strictEqual(body.status.transport.connected, true);
    assert.strictEqual(body.status.transport.secure, true);

    const duplicate = runPowerShell(powerShell, "start-claudebuddy-daemon.ps1", [
      "-Config",
      configPath,
      "-PidFile",
      pidFile,
      "-Node",
      process.execPath,
      "-ReadyTimeoutSec",
      "10",
    ]);
    assert.strictEqual(duplicate.status, 0, `${duplicate.stdout}\n${duplicate.stderr}`);
    assert.match(duplicate.stdout, /already running/);
    assert.strictEqual(readPid(pidFile), daemonPid);

    const stop = runPowerShell(powerShell, "stop-claudebuddy-daemon.ps1", [
      "-Config",
      configPath,
      "-PidFile",
      pidFile,
      "-TimeoutSec",
      "5",
    ]);
    assert.strictEqual(stop.status, 0, `${stop.stdout}\n${stop.stderr}`);
    assert.match(stop.stdout, /ClaudeBuddy daemon stopped/);
    assert.strictEqual(readPid(pidFile), null);

    const stoppedStatus = runPowerShell(powerShell, "status-claudebuddy-daemon.ps1", [
      "-Config",
      configPath,
      "-PidFile",
      pidFile,
      "-Json",
    ]);
    assert.strictEqual(stoppedStatus.status, 1, `${stoppedStatus.stdout}\n${stoppedStatus.stderr}`);
    const stopped = parseJsonOutput(stoppedStatus.stdout);
    assert.strictEqual(stopped.running, false);
    assert.strictEqual(stopped.control.ok, false);
  });

  it("stops and reports a daemon even when the config is missing", {
    skip: process.platform !== "win32",
  }, async (t) => {
    const powerShell = findPowerShell();
    if (!powerShell) {
      t.skip("PowerShell is required for Windows daemon script tests");
      return;
    }

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "claudebuddy-daemon-missing-config-"));
    const configPath = path.join(dir, "daemon.config.json");
    const pidFile = path.join(dir, "daemon.pid");
    const logFile = path.join(dir, "daemon.log");
    const port = await freePort();

    writeJson(configPath, {
      transport: "fake",
      sourceTitle: "Missing Config Stop Test",
      keepaliveMs: 0,
      permissionReplies: false,
      controlServer: true,
      controlHost: "127.0.0.1",
      controlPort: port,
      logFile,
      logLevel: "warn",
    });

    t.after(() => {
      runPowerShell(powerShell, "stop-claudebuddy-daemon.ps1", [
        "-Config",
        configPath,
        "-PidFile",
        pidFile,
        "-Node",
        process.execPath,
        "-TimeoutSec",
        "5",
      ]);
      fs.rmSync(dir, { recursive: true, force: true });
    });

    const start = runPowerShell(powerShell, "start-claudebuddy-daemon.ps1", [
      "-Config",
      configPath,
      "-PidFile",
      pidFile,
      "-Node",
      process.execPath,
      "-ReadyTimeoutSec",
      "10",
    ]);
    assert.strictEqual(start.status, 0, `${start.stdout}\n${start.stderr}`);
    const daemonPid = readPid(pidFile);
    assert.ok(daemonPid, "expected daemon PID file to contain a live PID");

    fs.unlinkSync(configPath);

    const status = runPowerShell(powerShell, "status-claudebuddy-daemon.ps1", [
      "-Config",
      configPath,
      "-PidFile",
      pidFile,
      "-Json",
    ]);
    assert.strictEqual(status.status, 2, `${status.stdout}\n${status.stderr}`);
    const body = parseJsonOutput(status.stdout);
    assert.strictEqual(body.running, true);
    assert.strictEqual(body.pid, daemonPid);
    assert.strictEqual(body.configOk, false);
    assert.match(body.configError, /Config file not found/);
    assert.strictEqual(body.control.enabled, false);

    const stop = runPowerShell(powerShell, "stop-claudebuddy-daemon.ps1", [
      "-Config",
      configPath,
      "-PidFile",
      pidFile,
      "-Node",
      process.execPath,
      "-TimeoutSec",
      "5",
    ]);
    assert.strictEqual(stop.status, 0, `${stop.stdout}\n${stop.stderr}`);
    assert.match(stop.stdout, /ClaudeBuddy daemon stopped/);
    assert.strictEqual(readPid(pidFile), null);
  });

  it("round-trips quoted daemon arguments with trailing slashes and quotes", {
    skip: process.platform !== "win32",
  }, (t) => {
    const powerShell = findPowerShell();
    if (!powerShell) {
      t.skip("PowerShell is required for Windows quoting tests");
      return;
    }

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "claudebuddy-quote-roundtrip-"));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const echoScript = path.join(dir, "echo-args.js");
    const outputFile = path.join(dir, "args.json");
    fs.writeFileSync(
      echoScript,
      "const fs = require('node:fs'); fs.writeFileSync(process.argv[2], JSON.stringify(process.argv.slice(3)), 'utf8');\n",
      "utf8",
    );

    const escapePowerShellString = (value) => `'${value.replace(/'/g, "''")}'`;
    const psCommand = `
. ${escapePowerShellString(path.join(repoRoot, "scripts", "claudebuddy-daemon-lib.ps1"))}
$arguments = Join-ClaudeBuddyArguments -Arguments @(
  ${escapePowerShellString(echoScript)},
  ${escapePowerShellString(outputFile)},
  'C:\\Path With Space\\',
  'name with "quotes"',
  'trailing\\\\',
  ''
)
$process = Start-Process -FilePath ${escapePowerShellString(process.execPath)} -ArgumentList $arguments -WorkingDirectory ${escapePowerShellString(dir)} -WindowStyle Hidden -Wait -PassThru
exit $process.ExitCode
`;
    const result = runPowerShellCommand(powerShell, psCommand);
    assert.strictEqual(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.deepStrictEqual(JSON.parse(fs.readFileSync(outputFile, "utf8")), [
      "C:\\Path With Space\\",
      'name with "quotes"',
      "trailing\\\\",
      "",
    ]);
  });

  it("reports unified control status as JSON when the daemon is stopped", {
    skip: process.platform !== "win32",
  }, (t) => {
    const powerShell = findPowerShell();
    if (!powerShell) {
      t.skip("PowerShell is required for Windows control script tests");
      return;
    }

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "claudebuddy-control-status-"));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const configPath = path.join(dir, "daemon.config.json");
    const pidFile = path.join(dir, "daemon.pid");
    const logFile = path.join(dir, "daemon.log");
    const taskName = `ClaudeBuddyControlMissing-${process.pid}-${Date.now()}`;
    writeJson(configPath, {
      transport: "fake",
      controlServer: "true",
      controlHost: "127.0.0.1",
      controlPort: 0,
      permissionReplies: false,
      logFile,
    });

    const status = runPowerShell(powerShell, "claudebuddy-control.ps1", [
      "-Action",
      "status",
      "-Config",
      configPath,
      "-PidFile",
      pidFile,
      "-TaskName",
      taskName,
      "-Json",
    ]);

    assert.strictEqual(status.status, 0, `${status.stdout}\n${status.stderr}`);
    const body = parseJsonOutput(status.stdout);
    assert.strictEqual(body.configOk, true);
    assert.strictEqual(body.config, configPath);
    assert.strictEqual(body.pidFile, pidFile);
    assert.strictEqual(body.logFile, logFile);
    assert.strictEqual(body.daemon.running, false);
    assert.strictEqual(body.daemon.control.enabled, true);
    assert.strictEqual(body.daemon.control.ok, false);
    assert.strictEqual(body.autostart.taskName, taskName);
  });

  it("validates the resident tray wrapper without launching the tray UI", {
    skip: process.platform !== "win32",
  }, (t) => {
    const powerShell = findPowerShell();
    if (!powerShell) {
      t.skip("PowerShell is required for Windows tray script tests");
      return;
    }

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "claudebuddy-tray-validate-"));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const configPath = path.join(dir, "daemon.config.json");
    const pidFile = path.join(dir, "daemon.pid");
    const logFile = path.join(dir, "daemon.log");
    const taskName = `ClaudeBuddyTrayValidate-${process.pid}-${Date.now()}`;
    writeJson(configPath, {
      transport: "fake",
      controlServer: true,
      controlHost: "127.0.0.1",
      controlPort: 0,
      permissionReplies: false,
      logFile,
    });

    const status = runPowerShell(powerShell, "claudebuddy-tray.ps1", [
      "-ValidateOnly",
      "-Json",
      "-Config",
      configPath,
      "-PidFile",
      pidFile,
      "-TaskName",
      taskName,
      "-Node",
      process.execPath,
    ]);

    assert.strictEqual(status.status, 0, `${status.stdout}\n${status.stderr}`);
    const body = parseJsonOutput(status.stdout);
    assert.strictEqual(body.quickCommands.menuText, "Quick Commands");
    assert.strictEqual(body.quickCommands.source, "tray");
    assert.strictEqual(body.quickCommands.presetIdsValid, true);
    assert.strictEqual(body.quickCommands.hasStop, false);
    assert.deepStrictEqual(body.quickCommands.presets.map((preset) => preset.id), [
      "continue",
      "correct",
      "no_commit",
      "no_source_edits",
      "show_diff",
      "plain_language",
      "plan_first",
    ]);
    assert.deepStrictEqual(body.quickCommands.presets.map((preset) => preset.label), [
      "继续",
      "不是这样的",
      "不要 commit",
      "不要改源文件",
      "show diff",
      "说人话",
      "先列计划",
    ]);
    assert.strictEqual(body.quickCommands.config.controlServerEnabled, true);
    assert.strictEqual(body.quickCommands.config.quickCommandsEnabled, false);
    assert.strictEqual(body.quickCommands.taskStateAffordance.endpoint, "/task-state");
    assert.strictEqual(body.quickCommands.taskStateAffordance.timeoutMs, 30000);
    assert.strictEqual(body.quickCommands.taskStateAffordance.explicitSignal, true);
    assert.strictEqual(body.quickCommands.taskStateAffordance.inferFromSnapshot, false);
    assert.strictEqual(body.quickCommands.taskStateAffordance.autoSend, false);
    assert.strictEqual(body.quickCommandRuntime.enabled, false);
    assert.strictEqual(body.quickCommandRuntime.reason, "Daemon stopped");
    assert.strictEqual(body.quickCommands.requestPreviews.length, 7);
    for (const preview of body.quickCommands.requestPreviews) {
      assert.strictEqual(preview.source, "tray");
      assert.match(preview.clientRequestId, /^validate-only-/);
      assert.strictEqual(preview.target.scope, "active_session");
      assert.strictEqual(preview.target.sessionId, null);
      assert.strictEqual(Object.prototype.hasOwnProperty.call(preview, "label"), false);
      assert.strictEqual(Object.prototype.hasOwnProperty.call(preview, "text"), false);
      assert.strictEqual(Object.prototype.hasOwnProperty.call(preview, "mode"), false);
      const matchingPreset = body.quickCommands.presets.find((preset) => preset.id === preview.id);
      assert.ok(matchingPreset, `expected request preview to use stable preset id: ${preview.id}`);
      assert.notStrictEqual(preview.id, matchingPreset.label);
    }
    if (body.windowsFormsAvailable !== true) {
      t.skip("Windows Forms is required for the tray UI");
      return;
    }
    assert.strictEqual(body.ok, true);
    assert.strictEqual(body.config, configPath);
    assert.strictEqual(body.pidFile, pidFile);
    assert.strictEqual(body.taskName, taskName);
    assert.strictEqual(body.controlStatus.configOk, true);
    assert.strictEqual(body.controlStatus.daemon.running, false);
    assert.strictEqual(body.controlStatus.daemon.control.enabled, true);
  });

  it("validates the tray quick-command menu when the control server is disabled", {
    skip: process.platform !== "win32",
  }, (t) => {
    const powerShell = findPowerShell();
    if (!powerShell) {
      t.skip("PowerShell is required for Windows tray script tests");
      return;
    }

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "claudebuddy-tray-quick-disabled-"));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const configPath = path.join(dir, "daemon.config.json");
    const pidFile = path.join(dir, "daemon.pid");
    const taskName = `ClaudeBuddyTrayQuickDisabled-${process.pid}-${Date.now()}`;
    writeJson(configPath, {
      transport: "fake",
      controlServer: false,
      quickCommands: true,
      permissionReplies: false,
      logFile: path.join(dir, "daemon.log"),
    });

    const status = runPowerShell(powerShell, "claudebuddy-tray.ps1", [
      "-ValidateOnly",
      "-Json",
      "-Config",
      configPath,
      "-PidFile",
      pidFile,
      "-TaskName",
      taskName,
      "-Node",
      process.execPath,
    ]);

    assert.strictEqual(status.status, 0, `${status.stdout}\n${status.stderr}`);
    const body = parseJsonOutput(status.stdout);
    if (body.windowsFormsAvailable !== true) {
      t.skip("Windows Forms is required for the tray UI");
      return;
    }
    assert.strictEqual(body.ok, true);
    assert.strictEqual(body.controlStatus.daemon.control.enabled, false);
    assert.strictEqual(body.quickCommands.config.controlServerEnabled, false);
    assert.strictEqual(body.quickCommands.config.quickCommandsEnabled, true);
    assert.strictEqual(body.quickCommandRuntime.enabled, false);
    assert.strictEqual(body.quickCommands.presetIdsValid, true);
    assert.strictEqual(body.quickCommands.hasStop, false);
  });

  it("reports enabled tray quick commands when a fake daemon supports them", {
    skip: process.platform !== "win32",
  }, async (t) => {
    const powerShell = findPowerShell();
    if (!powerShell) {
      t.skip("PowerShell is required for Windows tray script tests");
      return;
    }

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "claudebuddy-tray-quick-enabled-"));
    const configPath = path.join(dir, "daemon.config.json");
    const pidFile = path.join(dir, "daemon.pid");
    const logFile = path.join(dir, "daemon.log");
    const taskName = `ClaudeBuddyTrayQuickEnabled-${process.pid}-${Date.now()}`;
    const port = await freePort();
    writeJson(configPath, {
      transport: "fake",
      controlServer: true,
      controlHost: "127.0.0.1",
      controlPort: port,
      quickCommands: true,
      permissionReplies: false,
      keepaliveMs: 0,
      logFile,
    });

    t.after(() => {
      runPowerShell(powerShell, "stop-claudebuddy-daemon.ps1", [
        "-Config",
        configPath,
        "-PidFile",
        pidFile,
        "-Node",
        process.execPath,
        "-TimeoutSec",
        "5",
      ]);
      fs.rmSync(dir, { recursive: true, force: true });
    });

    const start = runPowerShell(powerShell, "start-claudebuddy-daemon.ps1", [
      "-Config",
      configPath,
      "-PidFile",
      pidFile,
      "-Node",
      process.execPath,
      "-ReadyTimeoutSec",
      "10",
    ]);
    assert.strictEqual(start.status, 0, `${start.stdout}\n${start.stderr}`);

    const taskStateResponse = await fetch(`http://127.0.0.1:${port}/task-state`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        sessionId: "tray-session",
        state: "finished",
        title: "Tray Task Done",
        source: "test",
      }),
    });
    const taskState = await taskStateResponse.json();
    assert.strictEqual(taskStateResponse.status, 200, JSON.stringify(taskState));

    const status = runPowerShell(powerShell, "claudebuddy-tray.ps1", [
      "-ValidateOnly",
      "-Json",
      "-Config",
      configPath,
      "-PidFile",
      pidFile,
      "-TaskName",
      taskName,
      "-Node",
      process.execPath,
    ]);
    assert.strictEqual(status.status, 0, `${status.stdout}\n${status.stderr}`);
    const body = parseJsonOutput(status.stdout);
    if (body.windowsFormsAvailable !== true) {
      t.skip("Windows Forms is required for the tray UI");
      return;
    }
    assert.strictEqual(body.ok, true);
    assert.strictEqual(body.controlStatus.daemon.running, true);
    assert.strictEqual(body.controlStatus.daemon.control.ok, true);
    assert.strictEqual(body.quickCommandRuntime.available, true);
    assert.strictEqual(body.quickCommandRuntime.enabled, true);
    assert.strictEqual(body.quickCommandRuntime.reason, "");
    assert.strictEqual(body.quickCommandRuntime.presets.length, 7);
    assert.strictEqual(body.quickCommandRuntime.taskAffordanceTimeoutMs, 30000);
    assert.strictEqual(body.quickCommandRuntime.recentTask.sessionId, "tray-session");
    assert.strictEqual(body.quickCommandRuntime.recentTask.state, "finished");
    assert.strictEqual(body.quickCommandRuntime.recentTask.title, "Tray Task Done");
  });

  it("installs and uninstalls tray shortcuts in explicit directories", {
    skip: process.platform !== "win32",
  }, (t) => {
    const powerShell = findPowerShell();
    if (!powerShell) {
      t.skip("PowerShell is required for Windows shortcut script tests");
      return;
    }
    if (!hasWScriptShell(powerShell)) {
      t.skip("WScript.Shell COM is required for shortcut script tests");
      return;
    }

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "claudebuddy-tray-shortcuts-"));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const startMenuDir = path.join(dir, "Programs");
    const startupDir = path.join(dir, "Startup");
    const configPath = path.join(dir, "daemon.config.json");
    const pidFile = path.join(dir, "daemon.pid");
    const shortcutName = `ClaudeBuddy Test ${process.pid}`;
    const startMenuLink = path.join(startMenuDir, `${shortcutName}.lnk`);
    const startupLink = path.join(startupDir, `${shortcutName}.lnk`);

    writeJson(configPath, {
      transport: "fake",
      controlServer: true,
      permissionReplies: false,
      logFile: path.join(dir, "daemon.log"),
    });

    const install = runPowerShell(powerShell, "install-claudebuddy-tray-shortcuts.ps1", [
      "-ShortcutName",
      shortcutName,
      "-Config",
      configPath,
      "-PidFile",
      pidFile,
      "-TaskName",
      "ClaudeBuddyShortcutTest",
      "-Node",
      process.execPath,
      "-PowerShell",
      powerShell,
      "-PollSeconds",
      "3",
      "-All",
      "-StartMenuDir",
      startMenuDir,
      "-StartupDir",
      startupDir,
      "-Json",
    ]);
    assert.strictEqual(install.status, 0, `${install.stdout}\n${install.stderr}`);
    const installed = parseJsonOutput(install.stdout);
    assert.strictEqual(installed.ok, true);
    assert.strictEqual(installed.items.length, 2);
    assert.ok(installed.items.every((item) => item.created === true));
    assert.ok(installed.items.every((item) => item.arguments.includes("-WindowStyle Hidden")));
    assert.ok(installed.items.every((item) => item.arguments.includes("claudebuddy-tray.ps1")));
    assert.strictEqual(fs.existsSync(startMenuLink), true);
    assert.strictEqual(fs.existsSync(startupLink), true);

    const uninstall = runPowerShell(powerShell, "uninstall-claudebuddy-tray-shortcuts.ps1", [
      "-ShortcutName",
      shortcutName,
      "-All",
      "-StartMenuDir",
      startMenuDir,
      "-StartupDir",
      startupDir,
      "-Json",
    ]);
    assert.strictEqual(uninstall.status, 0, `${uninstall.stdout}\n${uninstall.stderr}`);
    const removed = parseJsonOutput(uninstall.stdout);
    assert.strictEqual(removed.ok, true);
    assert.strictEqual(removed.items.length, 2);
    assert.ok(removed.items.every((item) => item.existed === true));
    assert.ok(removed.items.every((item) => item.removed === true));
    assert.strictEqual(fs.existsSync(startMenuLink), false);
    assert.strictEqual(fs.existsSync(startupLink), false);
  });

  it("starts and stops a fake daemon through the control shell", {
    skip: process.platform !== "win32",
  }, async (t) => {
    const powerShell = findPowerShell();
    if (!powerShell) {
      t.skip("PowerShell is required for Windows control script tests");
      return;
    }

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "claudebuddy-control-daemon-"));
    const configPath = path.join(dir, "daemon.config.json");
    const pidFile = path.join(dir, "daemon.pid");
    const logFile = path.join(dir, "daemon.log");
    const taskName = `ClaudeBuddyControl-${process.pid}-${Date.now()}`;
    const port = await freePort();

    writeJson(configPath, {
      transport: "fake",
      sourceTitle: "Control Script Test",
      keepaliveMs: 0,
      permissionReplies: false,
      controlServer: true,
      controlHost: "127.0.0.1",
      controlPort: port,
      logFile,
      logLevel: "warn",
    });

    t.after(() => {
      runPowerShell(powerShell, "claudebuddy-control.ps1", [
        "-Action",
        "stop",
        "-Config",
        configPath,
        "-PidFile",
        pidFile,
        "-TimeoutSec",
        "5",
      ]);
      fs.rmSync(dir, { recursive: true, force: true });
    });

    const start = runPowerShell(powerShell, "claudebuddy-control.ps1", [
      "-Action",
      "start",
      "-Config",
      configPath,
      "-PidFile",
      pidFile,
      "-TaskName",
      taskName,
      "-Node",
      process.execPath,
      "-ReadyTimeoutSec",
      "10",
    ]);
    assert.strictEqual(start.status, 0, `${start.stdout}\n${start.stderr}`);
    assert.match(start.stdout, /Started ClaudeBuddy daemon/);

    const status = runPowerShell(powerShell, "claudebuddy-control.ps1", [
      "-Action",
      "status",
      "-Config",
      configPath,
      "-PidFile",
      pidFile,
      "-TaskName",
      taskName,
      "-Json",
    ]);
    assert.strictEqual(status.status, 0, `${status.stdout}\n${status.stderr}`);
    const body = parseJsonOutput(status.stdout);
    assert.strictEqual(body.daemon.running, true);
    assert.strictEqual(body.daemon.control.ok, true);
    assert.strictEqual(body.daemon.status.started, true);
    assert.strictEqual(body.daemon.status.transport.type, "fake");
    assert.strictEqual(body.daemon.status.transport.connected, true);
    assert.strictEqual(body.daemon.status.transport.secure, true);

    const stop = runPowerShell(powerShell, "claudebuddy-control.ps1", [
      "-Action",
      "stop",
      "-Config",
      configPath,
      "-PidFile",
      pidFile,
      "-TimeoutSec",
      "5",
    ]);
    assert.strictEqual(stop.status, 0, `${stop.stdout}\n${stop.stderr}`);
    assert.match(stop.stdout, /ClaudeBuddy daemon stopped/);
    assert.strictEqual(readPid(pidFile), null);
  });

  it("uninstalls autostart while stopping a daemon launched with a custom Node path", {
    skip: process.platform !== "win32",
  }, async (t) => {
    const powerShell = findPowerShell();
    if (!powerShell) {
      t.skip("PowerShell is required for Windows daemon script tests");
      return;
    }

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "claudebuddy-custom-node-uninstall-"));
    const configPath = path.join(dir, "daemon.config.json");
    const pidFile = path.join(dir, "daemon.pid");
    const logFile = path.join(dir, "daemon.log");
    const customNode = path.join(dir, "claudebuddy-node-alias.exe");
    const taskName = `ClaudeBuddyCustomNodeMissing-${process.pid}-${Date.now()}`;
    const port = await freePort();

    fs.copyFileSync(process.execPath, customNode);
    writeJson(configPath, {
      transport: "fake",
      sourceTitle: "Custom Node Uninstall Test",
      keepaliveMs: 0,
      permissionReplies: false,
      controlServer: true,
      controlHost: "127.0.0.1",
      controlPort: port,
      logFile,
      logLevel: "warn",
    });

    t.after(() => {
      runPowerShell(powerShell, "stop-claudebuddy-daemon.ps1", [
        "-Config",
        configPath,
        "-PidFile",
        pidFile,
        "-Node",
        customNode,
        "-TimeoutSec",
        "5",
      ]);
      fs.rmSync(dir, { recursive: true, force: true });
    });

    const start = runPowerShell(powerShell, "start-claudebuddy-daemon.ps1", [
      "-Config",
      configPath,
      "-PidFile",
      pidFile,
      "-Node",
      customNode,
      "-ReadyTimeoutSec",
      "10",
    ]);
    assert.strictEqual(start.status, 0, `${start.stdout}\n${start.stderr}`);
    assert.ok(readPid(pidFile), "expected daemon PID file to contain a live PID");

    const uninstall = runPowerShell(powerShell, "uninstall-claudebuddy-scheduled-task.ps1", [
      "-TaskName",
      taskName,
      "-Config",
      configPath,
      "-PidFile",
      pidFile,
      "-Node",
      customNode,
      "-TimeoutSec",
      "5",
      "-Json",
    ]);
    assert.strictEqual(uninstall.status, 0, `${uninstall.stdout}\n${uninstall.stderr}`);
    const uninstallBody = parseJsonOutput(uninstall.stdout);
    assert.strictEqual(uninstallBody.ok, true);
    assert.strictEqual(uninstallBody.taskFound, false);
    assert.strictEqual(uninstallBody.removed, false);
    assert.strictEqual(uninstallBody.stopAttempted, true);
    assert.strictEqual(uninstallBody.stopExitCode, 0);
    assert.match(uninstallBody.stopOutput.join("\n"), /ClaudeBuddy daemon stopped/);
    assert.strictEqual(readPid(pidFile), null);
  });

  it("removes autostart through the control shell while preserving a custom Node path", {
    skip: process.platform !== "win32",
  }, async (t) => {
    const powerShell = findPowerShell();
    if (!powerShell) {
      t.skip("PowerShell is required for Windows daemon script tests");
      return;
    }

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "claudebuddy-custom-node-control-"));
    const configPath = path.join(dir, "daemon.config.json");
    const pidFile = path.join(dir, "daemon.pid");
    const logFile = path.join(dir, "daemon.log");
    const customNode = path.join(dir, "claudebuddy-node-control.exe");
    const taskName = `ClaudeBuddyControlCustomNodeMissing-${process.pid}-${Date.now()}`;
    const port = await freePort();

    fs.copyFileSync(process.execPath, customNode);
    writeJson(configPath, {
      transport: "fake",
      sourceTitle: "Control Custom Node Test",
      keepaliveMs: 0,
      permissionReplies: false,
      controlServer: true,
      controlHost: "127.0.0.1",
      controlPort: port,
      logFile,
      logLevel: "warn",
    });

    t.after(() => {
      runPowerShell(powerShell, "stop-claudebuddy-daemon.ps1", [
        "-Config",
        configPath,
        "-PidFile",
        pidFile,
        "-Node",
        customNode,
        "-TimeoutSec",
        "5",
      ]);
      fs.rmSync(dir, { recursive: true, force: true });
    });

    const start = runPowerShell(powerShell, "start-claudebuddy-daemon.ps1", [
      "-Config",
      configPath,
      "-PidFile",
      pidFile,
      "-Node",
      customNode,
      "-ReadyTimeoutSec",
      "10",
    ]);
    assert.strictEqual(start.status, 0, `${start.stdout}\n${start.stderr}`);
    assert.ok(readPid(pidFile), "expected daemon PID file to contain a live PID");

    const remove = runPowerShell(powerShell, "claudebuddy-control.ps1", [
      "-Action",
      "remove-autostart",
      "-TaskName",
      taskName,
      "-Config",
      configPath,
      "-PidFile",
      pidFile,
      "-Node",
      customNode,
      "-TimeoutSec",
      "5",
    ]);
    assert.strictEqual(remove.status, 0, `${remove.stdout}\n${remove.stderr}`);
    assert.match(remove.stdout, /ClaudeBuddy daemon stopped/);
    assert.match(remove.stdout, /Scheduled task not found/);
    assert.strictEqual(readPid(pidFile), null);
  });

  it("reports a missing scheduled task without side effects", {
    skip: process.platform !== "win32",
  }, (t) => {
    const powerShell = findPowerShell();
    if (!powerShell) {
      t.skip("PowerShell is required for Windows scheduled task script tests");
      return;
    }
    if (!hasScheduledTaskCmdlets(powerShell)) {
      t.skip("ScheduledTasks cmdlets are required for this test");
      return;
    }

    const taskName = `ClaudeBuddyMissing-${process.pid}-${Date.now()}`;
    const status = runPowerShell(powerShell, "status-claudebuddy-scheduled-task.ps1", [
      "-TaskName",
      taskName,
      "-Json",
    ]);

    assert.strictEqual(status.status, 1, `${status.stdout}\n${status.stderr}`);
    const body = parseJsonOutput(status.stdout);
    assert.strictEqual(body.installed, false);
    assert.strictEqual(body.taskName, taskName);
    assert.strictEqual(body.state, "Missing");
    assert.strictEqual(body.error, "");
  });

  it("supports scheduled task install and uninstall dry runs", {
    skip: process.platform !== "win32",
  }, (t) => {
    const powerShell = findPowerShell();
    if (!powerShell) {
      t.skip("PowerShell is required for Windows scheduled task script tests");
      return;
    }
    if (!hasScheduledTaskCmdlets(powerShell)) {
      t.skip("ScheduledTasks cmdlets are required for this test");
      return;
    }

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "claudebuddy-task-scripts-"));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

    const taskName = `ClaudeBuddyDryRun-${process.pid}-${Date.now()}`;
    const configPath = path.join(dir, "daemon.config.json");
    const pidFile = path.join(dir, "daemon.pid");
    writeJson(configPath, {
      transport: "fake",
      controlServer: true,
      controlHost: "127.0.0.1",
      controlPort: 0,
      permissionReplies: false,
      logFile: path.join(dir, "daemon.log"),
    });

    const install = runPowerShell(powerShell, "install-claudebuddy-scheduled-task.ps1", [
      "-TaskName",
      taskName,
      "-Config",
      configPath,
      "-PidFile",
      pidFile,
      "-Node",
      process.execPath,
      "-WhatIf",
      "-Json",
    ]);
    assert.strictEqual(install.status, 0, `${install.stdout}\n${install.stderr}`);
    const installBody = parseJsonOutput(install.stdout);
    assert.strictEqual(installBody.ok, true);
    assert.strictEqual(installBody.taskName, taskName);
    assert.strictEqual(installBody.config, configPath);
    assert.strictEqual(installBody.pidFile, pidFile);
    assert.strictEqual(installBody.node, process.execPath);
    assert.strictEqual(installBody.registered, false);
    assert.match(installBody.taskArguments, /start-claudebuddy-daemon\.ps1/);

    const uninstall = runPowerShell(powerShell, "uninstall-claudebuddy-scheduled-task.ps1", [
      "-TaskName",
      taskName,
      "-Config",
      configPath,
      "-PidFile",
      pidFile,
      "-KeepDaemon",
      "-WhatIf",
      "-Json",
    ]);
    assert.strictEqual(uninstall.status, 0, `${uninstall.stdout}\n${uninstall.stderr}`);
    const uninstallBody = parseJsonOutput(uninstall.stdout);
    assert.strictEqual(uninstallBody.ok, true);
    assert.strictEqual(uninstallBody.taskName, taskName);
    assert.strictEqual(uninstallBody.taskFound, false);
    assert.strictEqual(uninstallBody.removed, false);
    assert.strictEqual(uninstallBody.keepDaemon, true);

    const missingConfigUninstall = runPowerShell(powerShell, "uninstall-claudebuddy-scheduled-task.ps1", [
      "-TaskName",
      taskName,
      "-Config",
      path.join(dir, "missing.config.json"),
      "-PidFile",
      pidFile,
      "-TimeoutSec",
      "0",
      "-Json",
    ]);
    assert.strictEqual(
      missingConfigUninstall.status,
      0,
      `${missingConfigUninstall.stdout}\n${missingConfigUninstall.stderr}`,
    );
    const missingConfigUninstallBody = parseJsonOutput(missingConfigUninstall.stdout);
    assert.strictEqual(missingConfigUninstallBody.taskFound, false);
    assert.strictEqual(missingConfigUninstallBody.removed, false);
    assert.strictEqual(missingConfigUninstallBody.stopAttempted, true);
    assert.strictEqual(typeof missingConfigUninstallBody.stopExitCode, "number");

    const status = runPowerShell(powerShell, "status-claudebuddy-scheduled-task.ps1", [
      "-TaskName",
      taskName,
      "-Json",
    ]);
    assert.strictEqual(status.status, 1, `${status.stdout}\n${status.stderr}`);
    assert.strictEqual(parseJsonOutput(status.stdout).installed, false);
  });

  it("supports autostart dry runs through the control shell", {
    skip: process.platform !== "win32",
  }, (t) => {
    const powerShell = findPowerShell();
    if (!powerShell) {
      t.skip("PowerShell is required for Windows control script tests");
      return;
    }
    if (!hasScheduledTaskCmdlets(powerShell)) {
      t.skip("ScheduledTasks cmdlets are required for this test");
      return;
    }

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "claudebuddy-control-task-"));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const taskName = `ClaudeBuddyControlDryRun-${process.pid}-${Date.now()}`;
    const configPath = path.join(dir, "daemon.config.json");
    const pidFile = path.join(dir, "daemon.pid");
    writeJson(configPath, {
      transport: "fake",
      controlServer: true,
      permissionReplies: false,
      logFile: path.join(dir, "daemon.log"),
    });

    const install = runPowerShell(powerShell, "claudebuddy-control.ps1", [
      "-Action",
      "install-autostart",
      "-TaskName",
      taskName,
      "-Config",
      configPath,
      "-PidFile",
      pidFile,
      "-Node",
      process.execPath,
      "-WhatIf",
      "-Json",
    ]);
    assert.strictEqual(install.status, 0, `${install.stdout}\n${install.stderr}`);
    const installBody = parseJsonOutput(install.stdout);
    assert.strictEqual(installBody.ok, true);
    assert.strictEqual(installBody.taskName, taskName);
    assert.strictEqual(installBody.registered, false);
    assert.match(installBody.taskArguments, /start-claudebuddy-daemon\.ps1/);

    const remove = runPowerShell(powerShell, "claudebuddy-control.ps1", [
      "-Action",
      "remove-autostart",
      "-TaskName",
      taskName,
      "-Config",
      configPath,
      "-PidFile",
      pidFile,
      "-KeepDaemon",
      "-WhatIf",
      "-Json",
    ]);
    assert.strictEqual(remove.status, 0, `${remove.stdout}\n${remove.stderr}`);
    const removeBody = parseJsonOutput(remove.stdout);
    assert.strictEqual(removeBody.ok, true);
    assert.strictEqual(removeBody.taskName, taskName);
    assert.strictEqual(removeBody.taskFound, false);
    assert.strictEqual(removeBody.removed, false);
    assert.strictEqual(removeBody.keepDaemon, true);

    const status = runPowerShell(powerShell, "status-claudebuddy-scheduled-task.ps1", [
      "-TaskName",
      taskName,
      "-Json",
    ]);
    assert.strictEqual(status.status, 1, `${status.stdout}\n${status.stderr}`);
    assert.strictEqual(parseJsonOutput(status.stdout).installed, false);

    const controlTaskStatus = runPowerShell(powerShell, "claudebuddy-control.ps1", [
      "-Action",
      "task-status",
      "-TaskName",
      taskName,
      "-Json",
    ]);
    assert.strictEqual(controlTaskStatus.status, 1, `${controlTaskStatus.stdout}\n${controlTaskStatus.stderr}`);
    assert.strictEqual(parseJsonOutput(controlTaskStatus.stdout).installed, false);
  });
});
