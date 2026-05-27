"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const repoRoot = path.join(__dirname, "..");

describe("claudebuddy package entry", () => {
  it("exports the bridge core and standalone runtime API", () => {
    const api = require("..");

    assert.strictEqual(typeof api.buildHardwareBuddyHeartbeat, "function");
    assert.strictEqual(typeof api.HardwareBuddyController, "function");
    assert.strictEqual(typeof api.SidecarClient, "function");
    assert.strictEqual(typeof api.HeadlessHardwareBuddyRuntime, "function");
    assert.strictEqual(typeof api.createHttpControlServer, "function");
    assert.strictEqual(typeof api.createMemoryPermissionReplySink, "function");
    assert.strictEqual(typeof api.createRuntimeConfig, "function");
    assert.strictEqual(typeof api.createJsonFileHardwareBuddySource, "function");
    assert.strictEqual(typeof api.createJsonlPermissionReplySink, "function");
    assert.strictEqual(typeof api.consumeQuickCommandsOnce, "function");
    assert.strictEqual(typeof api.mapQuickCommandToAdapterAction, "function");
    assert.strictEqual(typeof api.createMemoryTaskStateStore, "function");
    assert.strictEqual(typeof api.normalizeTaskStateInput, "function");
    assert.strictEqual(typeof api.createStaticHardwareBuddySource, "function");
    assert.strictEqual(typeof api.createStdinJsonlHardwareBuddySource, "function");
    assert.strictEqual(api.findSidecarContention, undefined);
  });

  it("loads the CLI help path", () => {
    const result = spawnSync(process.execPath, [
      path.join(repoRoot, "bin", "claudebuddy.js"),
      "--help",
    ], {
      encoding: "utf8",
      timeout: 5000,
      windowsHide: true,
    });

    assert.strictEqual(result.status, 0, result.stderr || result.stdout);
    assert.match(result.stdout, /Usage: claudebuddy/);
    assert.match(result.stdout, /standalone/i);
  });

  it("returns exit code 2 for invalid CLI arguments", () => {
    const result = spawnSync(process.execPath, [
      path.join(repoRoot, "bin", "claudebuddy.js"),
      "--wat",
    ], {
      encoding: "utf8",
      timeout: 5000,
      windowsHide: true,
    });

    assert.strictEqual(result.status, 2);
    assert.match(result.stderr, /unknown option/);
  });

  it("keeps the npm package payload scoped to standalone runtime files", () => {
    const packageJson = require("../package.json");
    const files = new Set(packageJson.files);
    assert.match(packageJson.description, /Hardware Buddy bridge runtime/);
    assert.strictEqual(packageJson.private, true);
    assert.strictEqual(packageJson.license, "MIT");
    assert.ok(packageJson.keywords.includes("clawstick"));
    assert.ok(packageJson.keywords.includes("hardware-buddy"));
    assert.strictEqual(packageJson.bin.claudebuddy, "./bin/claudebuddy.js");
    assert.strictEqual(
      packageJson.bin["claudebuddy-quick-command-consumer"],
      "./bin/claudebuddy-quick-command-consumer.js",
    );
    assert.match(fs.readFileSync(path.join(repoRoot, "LICENSE"), "utf8"), /MIT License/);

    for (const expected of [
      "bin/",
      "src/",
      "scripts/",
      "tools/backends/__init__.py",
      "tools/backends/bleak_backend.py",
      "tools/hardware_buddy_bridge.py",
      "tools/hardware_buddy_common.py",
      "tools/requirements-sidecar.txt",
      "examples/claudebuddy.http-ble.example.config.json",
      "examples/claudebuddy.fake.config.json",
      "examples/claudebuddy.http-control.config.json",
      "examples/claudebuddy.json-file.config.json",
      "examples/claudebuddy.quick-commands.config.json",
      "examples/claudebuddy.stdin-jsonl.config.json",
      "examples/state.sample.json",
      "docs/standalone-daemon-windows.md",
      "docs/contracts/",
    ]) {
      assert.ok(files.has(expected), `expected package to include ${expected}`);
    }

    for (const forbidden of [
      "AGENTS.md",
      "CLAUDE.md",
      ".gitmodules",
      "docs/project-roadmap.zh.md",
    ]) {
      assert.strictEqual(files.has(forbidden), false, `expected package to exclude ${forbidden}`);
    }

    for (const prefix of [
      "test/",
      "firmware/",
      "upstream/",
      "experiments/",
      "tools/backends/__pycache__/",
    ]) {
      assert.strictEqual(
        packageJson.files.some((file) => file.startsWith(prefix)),
        false,
        `expected package to exclude ${prefix}`,
      );
    }
  });

  it("does not point packaged docs at local-only fixed-address examples", () => {
    const packagedDocs = [
      path.join(repoRoot, "README.md"),
      path.join(repoRoot, "docs", "standalone-daemon-windows.md"),
    ];
    const forbiddenPatterns = [
      /fixed-address/i,
      /Claude-[0-9A-F]{4}/i,
      /[0-9A-F]{2}(?::[0-9A-F]{2}){5}/i,
      /COM\d+/i,
      /D:\\/,
      /AGENTS\.md/,
      /upstream\/claude-desktop-buddy/,
      /test\/claudebuddy-daemon-scripts\.test\.js/,
    ];
    for (const docPath of packagedDocs) {
      const body = fs.readFileSync(docPath, "utf8");
      for (const pattern of forbiddenPatterns) {
        assert.doesNotMatch(body, pattern);
      }
    }
  });

  it("plans local release artifacts without creating them", () => {
    const powerShell = process.platform === "win32" ? findPowerShellForReleaseTest() : null;
    if (!powerShell) return;

    const result = spawnSync(powerShell, [
      "-NoProfile",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      path.join(repoRoot, "scripts", "package-claudebuddy-local-release.ps1"),
      "-OutputDir",
      path.join(repoRoot, "dist-test-whatif"),
      "-SkipTests",
      "-Json",
      "-WhatIf",
    ], {
      encoding: "utf8",
      timeout: 10000,
      windowsHide: true,
    });

    assert.strictEqual(result.status, 0, result.stderr || result.stdout);
    const body = parseJsonObject(result.stdout);
    assert.strictEqual(body.ok, true);
    assert.strictEqual(body.package.name, "claudebuddy");
    assert.strictEqual(body.package.version, require("../package.json").version);
    assert.strictEqual(body.tests.skipped, true);
    assert.strictEqual(body.tests.ran, false);
    assert.strictEqual(body.artifact.filename, "");
    assert.match(body.outputDir, /dist-test-whatif$/);
    assert.strictEqual(fs.existsSync(path.join(repoRoot, "dist-test-whatif")), false);
  });

  it("plans local artifact install smokes without creating a temp install", () => {
    const powerShell = process.platform === "win32" ? findPowerShellForReleaseTest() : null;
    if (!powerShell) return;

    const result = spawnSync(powerShell, [
      "-NoProfile",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      path.join(repoRoot, "scripts", "smoke-claudebuddy-local-artifact.ps1"),
      "-ArtifactPath",
      path.join(repoRoot, "dist", "missing-for-whatif.tgz"),
      "-WorkDir",
      path.join(repoRoot, "artifact-smoke-test-whatif"),
      "-Json",
      "-WhatIf",
    ], {
      encoding: "utf8",
      timeout: 10000,
      windowsHide: true,
    });

    assert.strictEqual(result.status, 0, result.stderr || result.stdout);
    const body = parseJsonObject(result.stdout);
    assert.strictEqual(body.ok, true);
    assert.strictEqual(body.artifactExists, false);
    assert.strictEqual(body.steps.install, false);
    assert.strictEqual(body.steps.quickCommandConsumerHelp, false);
    assert.strictEqual(body.cleanup.attempted, false);
    assert.match(body.workDir, /artifact-smoke-test-whatif$/);
    assert.strictEqual(fs.existsSync(path.join(repoRoot, "artifact-smoke-test-whatif")), false);
  });

  it("plans local installs without creating an install directory", () => {
    const powerShell = process.platform === "win32" ? findPowerShellForReleaseTest() : null;
    if (!powerShell) return;

    const result = spawnSync(powerShell, [
      "-NoProfile",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      path.join(repoRoot, "scripts", "install-claudebuddy-local.ps1"),
      "-ArtifactPath",
      path.join(repoRoot, "dist", "missing-for-whatif.tgz"),
      "-InstallDir",
      path.join(repoRoot, "local-install-test-whatif"),
      "-Config",
      path.join(repoRoot, "local-install-test-whatif", "claudebuddy.config.json"),
      "-PidFile",
      path.join(repoRoot, "local-install-test-whatif", "logs", "daemon.pid"),
      "-TaskName",
      "ClaudeBuddyLocalInstallWhatIf",
      "-ShortcutName",
      "ClaudeBuddy Local Install WhatIf",
      "-AllShortcuts",
      "-Json",
      "-WhatIf",
    ], {
      encoding: "utf8",
      timeout: 10000,
      windowsHide: true,
    });

    assert.strictEqual(result.status, 0, result.stderr || result.stdout);
    const body = parseJsonObject(result.stdout);
    assert.strictEqual(body.ok, true);
    assert.strictEqual(body.artifactExists, false);
    assert.match(body.installDir, /local-install-test-whatif$/);
    assert.strictEqual(body.steps.installDirectory, false);
    assert.strictEqual(body.steps.npmInstall, false);
    assert.strictEqual(body.steps.config, false);
    assert.strictEqual(body.steps.shortcuts, false);
    assert.strictEqual(fs.existsSync(path.join(repoRoot, "local-install-test-whatif")), false);
  });

  it("plans local uninstalls without touching install directories", () => {
    const powerShell = process.platform === "win32" ? findPowerShellForReleaseTest() : null;
    if (!powerShell) return;

    const installDir = path.join(repoRoot, "local-uninstall-test-whatif");
    const result = spawnSync(powerShell, [
      "-NoProfile",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      path.join(repoRoot, "scripts", "uninstall-claudebuddy-local.ps1"),
      "-InstallDir",
      installDir,
      "-Config",
      path.join(installDir, "claudebuddy.config.json"),
      "-PidFile",
      path.join(installDir, "logs", "daemon.pid"),
      "-TaskName",
      "ClaudeBuddyLocalUninstallWhatIf",
      "-ShortcutName",
      "ClaudeBuddy Local Uninstall WhatIf",
      "-RemoveConfig",
      "-RemoveLogs",
      "-RemoveInstallDir",
      "-Json",
      "-WhatIf",
    ], {
      encoding: "utf8",
      timeout: 10000,
      windowsHide: true,
    });

    assert.strictEqual(result.status, 0, result.stderr || result.stdout);
    const body = parseJsonObject(result.stdout);
    assert.strictEqual(body.ok, true);
    assert.match(body.installDir, /local-uninstall-test-whatif$/);
    assert.strictEqual(body.steps.daemon, false);
    assert.strictEqual(body.steps.autostart, false);
    assert.strictEqual(body.steps.shortcuts, false);
    assert.strictEqual(body.steps.package, false);
    assert.strictEqual(body.steps.config, true);
    assert.strictEqual(body.steps.logs, true);
    assert.strictEqual(body.steps.installDir, true);
    assert.strictEqual(body.outputs.config.removed, false);
    assert.strictEqual(body.outputs.logs.removed, false);
    assert.strictEqual(body.outputs.installDir.removed, false);
    assert.strictEqual(fs.existsSync(installDir), false);
  });

  it("installs a local artifact into isolated directories when one exists", () => {
    const powerShell = process.platform === "win32" ? findPowerShellForReleaseTest() : null;
    const npm = process.platform === "win32" ? findNpmForReleaseTest() : null;
    const artifact = path.join(repoRoot, "dist", "claudebuddy-0.0.0.tgz");
    if (!powerShell || !npm || !fs.existsSync(artifact)) return;

    const workDir = path.join(repoRoot, `local-install-test-${process.pid}-${Date.now()}`);
    const installDir = path.join(workDir, "install");
    const startMenuDir = path.join(workDir, "shortcuts", "start-menu");
    const startupDir = path.join(workDir, "shortcuts", "startup");
    const shortcutName = `ClaudeBuddy Local Install Test ${process.pid}`;

    try {
      fs.mkdirSync(workDir, { recursive: true });
      const result = spawnSync(powerShell, [
        "-NoProfile",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        path.join(repoRoot, "scripts", "install-claudebuddy-local.ps1"),
        "-ArtifactPath",
        artifact,
        "-InstallDir",
        installDir,
        "-Config",
        path.join(installDir, "claudebuddy.config.json"),
        "-PidFile",
        path.join(installDir, "logs", "daemon.pid"),
        "-TaskName",
        `ClaudeBuddyLocalInstallTest${process.pid}`,
        "-ShortcutName",
        shortcutName,
        "-Node",
        process.execPath,
        "-Npm",
        npm,
        "-PowerShell",
        powerShell,
        "-AllShortcuts",
        "-StartMenuDir",
        startMenuDir,
        "-StartupDir",
        startupDir,
        "-Json",
      ], {
        encoding: "utf8",
        env: {
          ...process.env,
          npm_config_cache: path.join(workDir, "npm-cache"),
        },
        timeout: 60000,
        windowsHide: true,
      });

      assert.strictEqual(result.status, 0, result.stderr || result.stdout);
      const body = parseJsonObject(result.stdout);
      assert.strictEqual(body.ok, true);
      assert.strictEqual(body.steps.npmInstall, true);
      assert.strictEqual(body.steps.config, true);
      assert.strictEqual(body.steps.trayValidate, true);
      assert.strictEqual(body.steps.shortcuts, true);
      assert.strictEqual(body.steps.autostart, false);
      assert.strictEqual(body.steps.daemon, false);
      assert.strictEqual(fs.existsSync(path.join(installDir, "node_modules", "claudebuddy", "package.json")), true);
      assert.strictEqual(fs.existsSync(path.join(installDir, "claudebuddy.config.json")), true);
      assert.strictEqual(fs.existsSync(path.join(startMenuDir, `${shortcutName}.lnk`)), true);
      assert.strictEqual(fs.existsSync(path.join(startupDir, `${shortcutName}.lnk`)), true);
    } finally {
      fs.rmSync(workDir, { recursive: true, force: true });
    }
  });

  it("uninstalls a local artifact from isolated directories when one exists", () => {
    const powerShell = process.platform === "win32" ? findPowerShellForReleaseTest() : null;
    const npm = process.platform === "win32" ? findNpmForReleaseTest() : null;
    const artifact = path.join(repoRoot, "dist", "claudebuddy-0.0.0.tgz");
    if (!powerShell || !npm || !fs.existsSync(artifact)) return;

    const workDir = path.join(repoRoot, `local-uninstall-test-${process.pid}-${Date.now()}`);
    const installDir = path.join(workDir, "install");
    const startMenuDir = path.join(workDir, "shortcuts", "start-menu");
    const startupDir = path.join(workDir, "shortcuts", "startup");
    const shortcutName = `ClaudeBuddy Local Uninstall Test ${process.pid}`;
    const configPath = path.join(installDir, "claudebuddy.config.json");
    const pidFile = path.join(installDir, "logs", "daemon.pid");

    try {
      fs.mkdirSync(workDir, { recursive: true });
      const install = spawnSync(powerShell, [
        "-NoProfile",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        path.join(repoRoot, "scripts", "install-claudebuddy-local.ps1"),
        "-ArtifactPath",
        artifact,
        "-InstallDir",
        installDir,
        "-Config",
        configPath,
        "-PidFile",
        pidFile,
        "-TaskName",
        `ClaudeBuddyLocalUninstallTest${process.pid}`,
        "-ShortcutName",
        shortcutName,
        "-Node",
        process.execPath,
        "-Npm",
        npm,
        "-PowerShell",
        powerShell,
        "-AllShortcuts",
        "-StartMenuDir",
        startMenuDir,
        "-StartupDir",
        startupDir,
        "-Json",
      ], {
        encoding: "utf8",
        env: {
          ...process.env,
          npm_config_cache: path.join(workDir, "npm-cache"),
        },
        timeout: 60000,
        windowsHide: true,
      });
      assert.strictEqual(install.status, 0, install.stderr || install.stdout);
      const packagedUninstallScript = path.join(
        installDir,
        "node_modules",
        "claudebuddy",
        "scripts",
        "uninstall-claudebuddy-local.ps1",
      );
      assert.strictEqual(fs.existsSync(packagedUninstallScript), true);

      const uninstall = spawnSync(powerShell, [
        "-NoProfile",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        packagedUninstallScript,
        "-InstallDir",
        installDir,
        "-Config",
        configPath,
        "-PidFile",
        pidFile,
        "-TaskName",
        `ClaudeBuddyLocalUninstallTest${process.pid}`,
        "-ShortcutName",
        shortcutName,
        "-Node",
        process.execPath,
        "-PowerShell",
        powerShell,
        "-StartMenuDir",
        startMenuDir,
        "-StartupDir",
        startupDir,
        "-RemoveConfig",
        "-RemoveLogs",
        "-RemoveInstallDir",
        "-Json",
      ], {
        encoding: "utf8",
        timeout: 60000,
        windowsHide: true,
      });

      assert.strictEqual(uninstall.status, 0, uninstall.stderr || uninstall.stdout);
      const body = parseJsonObject(uninstall.stdout);
      assert.strictEqual(body.ok, true);
      assert.strictEqual(body.steps.daemon, true);
      assert.strictEqual(body.steps.autostart, true);
      assert.strictEqual(body.steps.shortcuts, true);
      assert.strictEqual(body.steps.package, true);
      assert.strictEqual(body.steps.config, true);
      assert.strictEqual(body.steps.installDir, true);
      assert.strictEqual(body.outputs.shortcuts.items.every((item) => item.removed), true);
      assert.strictEqual(fs.existsSync(installDir), false);
      assert.strictEqual(fs.existsSync(path.join(startMenuDir, `${shortcutName}.lnk`)), false);
      assert.strictEqual(fs.existsSync(path.join(startupDir, `${shortcutName}.lnk`)), false);
    } finally {
      fs.rmSync(workDir, { recursive: true, force: true });
    }
  });

  it("keeps custom package metadata during local uninstall", () => {
    const powerShell = process.platform === "win32" ? findPowerShellForReleaseTest() : null;
    if (!powerShell) return;

    const workDir = path.join(repoRoot, `local-uninstall-custom-test-${process.pid}-${Date.now()}`);
    const installDir = path.join(workDir, "install");
    const packageRoot = path.join(installDir, "node_modules", "claudebuddy");
    const packageJson = path.join(installDir, "package.json");
    const packageLock = path.join(installDir, "package-lock.json");
    const configPath = path.join(installDir, "claudebuddy.config.json");
    const logsDir = path.join(installDir, "logs");

    try {
      fs.mkdirSync(packageRoot, { recursive: true });
      fs.mkdirSync(logsDir, { recursive: true });
      fs.writeFileSync(path.join(packageRoot, "package.json"), JSON.stringify({ name: "claudebuddy" }));
      fs.writeFileSync(configPath, "{}");
      fs.writeFileSync(path.join(logsDir, "daemon.log"), "log\n");
      fs.writeFileSync(packageJson, JSON.stringify({
        private: true,
        scripts: { start: "node app.js" },
        dependencies: { claudebuddy: "file:claudebuddy-0.0.0.tgz" },
      }));
      fs.writeFileSync(packageLock, JSON.stringify({
        lockfileVersion: 3,
        requires: true,
        packages: {
          "": { dependencies: { claudebuddy: "file:claudebuddy-0.0.0.tgz", other: "1.0.0" } },
          "node_modules/claudebuddy": { version: "0.0.0" },
          "node_modules/other": { version: "1.0.0" },
        },
      }));

      const result = spawnSync(powerShell, [
        "-NoProfile",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        path.join(repoRoot, "scripts", "uninstall-claudebuddy-local.ps1"),
        "-InstallDir",
        installDir,
        "-Config",
        configPath,
        "-PidFile",
        path.join(logsDir, "daemon.pid"),
        "-TaskName",
        `ClaudeBuddyLocalUninstallCustomTest${process.pid}`,
        "-ShortcutName",
        `ClaudeBuddy Local Uninstall Custom Test ${process.pid}`,
        "-KeepDaemon",
        "-KeepAutostart",
        "-KeepShortcuts",
        "-RemoveConfig",
        "-RemoveLogs",
        "-RemoveInstallDir",
        "-Json",
      ], {
        encoding: "utf8",
        timeout: 30000,
        windowsHide: true,
      });

      assert.strictEqual(result.status, 0, result.stderr || result.stdout);
      const body = parseJsonObject(result.stdout);
      assert.strictEqual(body.ok, true);
      assert.strictEqual(body.outputs.packageRoot.removed, true);
      assert.strictEqual(body.outputs.packageJson.removed, false);
      assert.match(body.outputs.packageJson.reason, /does not look generated/);
      assert.strictEqual(body.outputs.packageLock.removed, false);
      assert.match(body.outputs.packageLock.reason, /does not look generated/);
      assert.strictEqual(body.outputs.installDir.removed, false);
      assert.match(body.outputs.installDir.reason, /not empty/);
      assert.strictEqual(fs.existsSync(packageRoot), false);
      assert.strictEqual(fs.existsSync(configPath), false);
      assert.strictEqual(fs.existsSync(logsDir), false);
      assert.strictEqual(fs.existsSync(packageJson), true);
      assert.strictEqual(fs.existsSync(packageLock), true);
      assert.strictEqual(fs.existsSync(installDir), true);
    } finally {
      fs.rmSync(workDir, { recursive: true, force: true });
    }
  });
});

function findPowerShellForReleaseTest() {
  for (const command of ["pwsh.exe", "powershell.exe"]) {
    const result = spawnSync(command, [
      "-NoProfile",
      "-Command",
      "$PSVersionTable.PSVersion.ToString()",
    ], {
      encoding: "utf8",
      timeout: 5000,
      windowsHide: true,
    });
    if (!result.error && result.status === 0) return command;
  }
  return null;
}

function findNpmForReleaseTest() {
  for (const command of ["npm.cmd", "npm"]) {
    const result = spawnSync(command, ["--version"], {
      encoding: "utf8",
      timeout: 5000,
      windowsHide: true,
    });
    if (!result.error && result.status === 0) return command;
  }
  return null;
}

function parseJsonObject(output) {
  const start = output.indexOf("{");
  const end = output.lastIndexOf("}");
  assert.notStrictEqual(start, -1, `expected JSON object in output:\n${output}`);
  assert.ok(end > start, `expected complete JSON object in output:\n${output}`);
  return JSON.parse(output.slice(start, end + 1));
}
