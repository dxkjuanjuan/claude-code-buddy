# Standalone Daemon On Windows

This is the current supported shape for running `claudebuddy` without Clawd or
Electron. It is intentionally simple: run the Node CLI with a config file, keep
permission replies disabled by default, and write logs to a file.

## Foreground Smoke

Fake transport:

```powershell
node bin\claudebuddy.js --config examples\claudebuddy.fake.config.json --once --once-ms 0
```

JSON file input:

```powershell
node bin\claudebuddy.js --config examples\claudebuddy.json-file.config.json --once --once-ms 0
```

BLE sidecar with the public safe template:

```powershell
node bin\claudebuddy.js --config examples\claudebuddy.http-ble.example.config.json --once --once-ms 6000
```

Do not run the BLE command while another app is holding the `bleak` sidecar.
The template scans by `namePrefix` and keeps hardware approval replies disabled;
copy it to `claudebuddy.config.json` and add a discovered `address` for a
specific device.

## Long-Running Foreground

```powershell
node bin\claudebuddy.js --config examples\claudebuddy.http-ble.example.config.json
```

Shutdown is signal-driven. `Ctrl+C` sends `SIGINT`; the CLI stops the runtime,
closes the log file stream, and uses `shutdownTimeoutMs` as a watchdog if a
child process or OS handle stalls shutdown.

## Background Process

For a plain background process from PowerShell:

```powershell
Start-Process -WindowStyle Hidden -FilePath node -ArgumentList @(
  'bin\claudebuddy.js',
  '--config',
  'examples\claudebuddy.http-ble.example.config.json'
) -WorkingDirectory '<claudebuddy-install-or-checkout>'
```

Logs go to the config's `logFile`. Use `jsonLogs: true` for structured log
lines.

## Managed Scripts

The repo also includes thin Windows wrappers around the same Node CLI. They keep
the command line, PID file, log path, and HTTP status check consistent for local
daemon use:

```powershell
.\scripts\start-claudebuddy-daemon.ps1
.\scripts\status-claudebuddy-daemon.ps1
.\scripts\stop-claudebuddy-daemon.ps1
.\scripts\install-claudebuddy-scheduled-task.ps1
.\scripts\status-claudebuddy-scheduled-task.ps1
.\scripts\uninstall-claudebuddy-scheduled-task.ps1
.\scripts\claudebuddy-control.ps1
.\scripts\claudebuddy-tray.ps1
.\scripts\install-claudebuddy-tray-shortcuts.ps1
.\scripts\uninstall-claudebuddy-tray-shortcuts.ps1
```

By default, the scripts use:

```text
examples\claudebuddy.http-ble.example.config.json
logs\claudebuddy-daemon.pid
```

The default managed config is safe for a public checkout: it enables the
loopback HTTP control server, scans for a BLE device with `namePrefix:
"Claude"`, and keeps `permissionReplies: false`. It does not contain a fixed
device address and will not accept hardware approval replies until the user
explicitly opts in.

Use `-Config <path>` and `-PidFile <path>` to run a different profile.
Use the same `-Node <path>` value for direct start/stop/uninstall calls when
running through a custom or renamed Node executable; the control and tray
wrappers forward their configured `-Node` value for you.

`start-claudebuddy-daemon.ps1` serializes concurrent starts and refuses to start
a second daemon when the PID file points at a live Node process. If the PID file
is stale or points at an unrelated process, it removes it and starts fresh.
`status-claudebuddy-daemon.ps1 -Json` emits a machine-readable status object
with the process state plus `/health` and `/status` when the control server is
enabled; if the config file is missing or invalid, it still reports PID state and
sets `configOk:false`. `stop-claudebuddy-daemon.ps1` stops the recorded daemon
PID only when it still belongs to the expected Node process, and only force-cleans
the sidecar PID reported by `/status` when it still looks like a Python sidecar.
The managed-script smoke path is covered in the source checkout with fake
transport, so the regression tests do not touch BLE hardware.

Install an on-logon Scheduled Task with:

```powershell
.\scripts\install-claudebuddy-scheduled-task.ps1
```

Pass `-WhatIf` first to inspect the task registration without writing it:

```powershell
.\scripts\install-claudebuddy-scheduled-task.ps1 -WhatIf
.\scripts\install-claudebuddy-scheduled-task.ps1 -WhatIf -Json
```

The task trigger is scoped to the current Windows user. Existing tasks are not
overwritten unless `-Force` is passed explicitly. Install and uninstall both
support `-Json`, including dry runs, so installer wrappers can inspect the
planned task action without parsing console text.

Check task registration without touching the daemon:

```powershell
.\scripts\status-claudebuddy-scheduled-task.ps1
.\scripts\status-claudebuddy-scheduled-task.ps1 -Json
```

Remove the task and stop the managed daemon:

```powershell
.\scripts\uninstall-claudebuddy-scheduled-task.ps1
.\scripts\uninstall-claudebuddy-scheduled-task.ps1 -Json
```

Use `-KeepDaemon` when you only want to remove autostart and leave the current
daemon process running.

For a single local control entry point, use:

```powershell
.\scripts\claudebuddy-control.ps1
.\scripts\claudebuddy-control.ps1 -Action status -Json
.\scripts\claudebuddy-control.ps1 -Action start
.\scripts\claudebuddy-control.ps1 -Action stop
.\scripts\claudebuddy-control.ps1 -Action install-autostart -WhatIf
.\scripts\claudebuddy-control.ps1 -Action install-autostart -Force
.\scripts\claudebuddy-control.ps1 -Action remove-autostart -KeepDaemon
.\scripts\claudebuddy-control.ps1 -Action tail-log -LogLines 120
```

The control script is intentionally a thin shell over the managed daemon and
scheduled-task scripts. It emits combined daemon/autostart status as JSON for
the tray process and other installer wrappers, but it does not keep a GUI
process resident.

## Resident Tray

The first resident tray process is also a thin wrapper around
`claudebuddy-control.ps1`. It does not implement daemon logic itself; it reads
daemon/autostart status in-process for cheap polling, exposes a context menu,
and calls the control shell for start, stop, restart, autostart, and log actions:

```powershell
.\scripts\claudebuddy-tray.ps1
```

The tray supports `-Config`, `-PidFile`, `-TaskName`, `-Node`, and
`-PollSeconds`, matching the managed scripts. Validate the tray environment
without launching a UI:

```powershell
.\scripts\claudebuddy-tray.ps1 -ValidateOnly -Json
```

When the selected config enables `quickCommands:true`, the tray adds a
`Quick Commands` submenu. Each menu item posts the preset id, `source:"tray"`,
and a generated `clientRequestId` to the daemon's loopback control server.
Labels are display text only; the tray does not translate commands into agent
prompt text, run shell commands, or paste into the foreground window. If the
daemon is stopped, the control server is unavailable, or quick commands are
disabled, the command menu items stay disabled and the submenu shows the current
status.

For hidden launch from a shortcut or future installer:

```powershell
Start-Process -WindowStyle Hidden -FilePath powershell.exe -ArgumentList @(
  '-NoProfile',
  '-ExecutionPolicy',
  'Bypass',
  '-File',
  '<claudebuddy-install-or-checkout>\scripts\claudebuddy-tray.ps1'
) -WorkingDirectory '<claudebuddy-install-or-checkout>'
```

Install a Start Menu shortcut for the tray:

```powershell
.\scripts\install-claudebuddy-tray-shortcuts.ps1
```

Install both Start Menu and Windows Startup shortcuts:

```powershell
.\scripts\install-claudebuddy-tray-shortcuts.ps1 -All
```

Use `-Startup` to install only the Startup shortcut, or pass `-Config`,
`-PidFile`, `-TaskName`, `-Node`, and `-PollSeconds` to bake a non-default tray
profile into the shortcut. Remove tray shortcuts with:

```powershell
.\scripts\uninstall-claudebuddy-tray-shortcuts.ps1
```

Uninstall defaults to checking both Start Menu and Startup locations; use
`-StartMenu` or `-Startup` to restrict removal.

## Local Release Artifact

For local packaging, use the repo-local release wrapper. It runs `npm test` by
default, creates an npm `.tgz` in `dist\`, computes a SHA256 digest, and writes a
JSON manifest next to the artifact:

```powershell
.\scripts\package-claudebuddy-local-release.ps1
.\scripts\package-claudebuddy-local-release.ps1 -Json
```

Use `-SkipTests` only when the same tree has already been tested:

```powershell
.\scripts\package-claudebuddy-local-release.ps1 -SkipTests -Json
```

Use `-DryRun` to inspect npm's package file list without creating an artifact or
manifest:

```powershell
.\scripts\package-claudebuddy-local-release.ps1 -DryRun -SkipTests -Json
```

After creating a local artifact, install it into an isolated temporary npm
project and smoke the packaged CLI, package exports, fake runtime, packaged
sidecar files, and tray validation path:

```powershell
.\scripts\smoke-claudebuddy-local-artifact.ps1 -Json
```

The artifact smoke removes its temporary install directory by default. Use
`-KeepWorkDir` only when debugging a failed packaged install.

For a higher-level local install wrapper, use:

```powershell
.\scripts\install-claudebuddy-local.ps1 -WhatIf -Json
$root = Join-Path $env:TEMP "claudebuddy-local-install-smoke"
.\scripts\install-claudebuddy-local.ps1 `
  -InstallDir "$root\install" `
  -Config "$root\install\claudebuddy.config.json" `
  -PidFile "$root\install\logs\claudebuddy-daemon.pid" `
  -StartMenuDir "$root\shortcuts\start-menu" `
  -StartupDir "$root\shortcuts\startup" `
  -AllShortcuts `
  -Json
```

The wrapper installs the local `.tgz` into a user install directory, copies the
safe HTTP+BLE config template to `claudebuddy.config.json`, validates the
packaged tray script, and can optionally create Start Menu / Startup shortcuts,
install a Scheduled Task, or start the daemon. Use explicit `-InstallDir`,
`-Config`, `-PidFile`, `-StartMenuDir`, and `-StartupDir` for isolated smoke
runs. Passing shortcut switches without `-StartMenuDir` / `-StartupDir` writes
to the real user folders. If a run fails after `npm install`, rerun the command
to resume; `-Force` also overwrites an existing generated config from the
template.

Remove a local install with the matching high-level uninstall wrapper:

```powershell
.\scripts\uninstall-claudebuddy-local.ps1 -WhatIf -Json
.\scripts\uninstall-claudebuddy-local.ps1 -Json
```

By default the uninstall wrapper stops the managed daemon if its PID file is
present, removes the Scheduled Task, removes tray shortcuts from Start Menu and
Startup, and removes the installed package payload. It keeps config and logs
unless `-RemoveConfig` / `-RemoveLogs` are passed. Use `-RemoveInstallDir` only
for disposable install roots; it removes the install directory only after the
package/config/log removals leave it empty. Keep using `-StartMenuDir` /
`-StartupDir` when testing against isolated shortcut directories.

## First BLE Setup

For a new machine or a different device, start from the public template:

```powershell
Copy-Item examples\claudebuddy.http-ble.example.config.json .\claudebuddy.config.json
```

Scan for the local device:

```powershell
python tools\hardware_buddy_bridge.py --backend bleak --scan-timeout 8
```

Then either add the discovered `address` to `claudebuddy.config.json`, or leave
`address` empty and keep a suitable `namePrefix`. Fixed address connects are
usually faster and less sensitive to Windows BLE scan timing.

Before enabling hardware approval replies, pair/bond the device in Windows
Bluetooth settings and verify `/status` reports both `transport.secure: true`
and sidecar status data with `sec: true`. Only then set:

```json
{
  "permissionReplies": true
}
```

## JSON File Source

Use `source: "json-file"` when another local process should drive the hardware
surface without importing this package. The daemon polls `sourceFile` every
`sourcePollMs` milliseconds.

Minimal source file:

```json
{
  "sessions": [
    {
      "id": "standalone",
      "title": "Build firmware",
      "state": "working"
    }
  ],
  "permissions": [],
  "doNotDisturb": false
}
```

If the file is missing or temporarily invalid JSON, the daemon logs a warning
and keeps the last valid state. On first start, before any valid file has been
loaded, that means the default static fallback session remains visible.

The source file is plaintext local IPC. Protect it with filesystem ACLs if
`toolInput` may contain secrets. The daemon refuses to read files larger than
`sourceMaxBytes` to avoid stalling the event loop on oversized input.
Hardware permission replies remain disabled unless `permissionReplies` is
explicitly set to `true`.

To complete a standalone permission loop, add a JSONL reply file:

```json
{
  "source": "json-file",
  "sourceFile": "state.sample.json",
  "transport": "sidecar",
  "backend": "bleak",
  "address": "<discovered-device-address>",
  "permissionReplies": true,
  "replyFile": "replies.jsonl"
}
```

`replyFile` implies `replyMode: "jsonl"`. When a secure hardware reply is
accepted, the daemon appends one JSON line:

```json
{"type":"permission_reply","id":"prompt-1","promptId":"hb_1","behavior":"allow","decision":"once","sessionId":"standalone","agentId":"claude-code","toolName":"Bash","createdAt":1710000000001,"time":"2026-05-18T00:00:00.000Z"}
```

The reply record intentionally omits full `toolInput`. The source writer should
watch or tail the reply file, apply the decision, and remove the matching
permission from `sourceFile`. The daemon suppresses already replied permissions
locally so a prompt does not reappear while the writer is catching up. Protect
the reply file with the same local ACL expectations as the source file.

## Stdin JSONL Source

Use `source: "stdin-jsonl"` when a local adapter already owns process lifetime
and wants to pipe state directly into the daemon. Each input line is one complete
JSON state object with the same shape as the JSON file source and HTTP
`POST /state`. Typed envelopes are also accepted:

```json
{"type":"state","data":{"sessions":[{"id":"standalone","title":"Pipe task","state":"working"}],"permissions":[],"doNotDisturb":false}}
```

Minimal config:

```json
{
  "source": "stdin-jsonl",
  "sourceMaxBytes": 65536,
  "transport": "fake",
  "permissionReplies": false
}
```

PowerShell smoke:

```powershell
'{"sessions":[{"id":"standalone","title":"Pipe task","state":"working"}],"permissions":[]}' | node bin\claudebuddy.js --source stdin-jsonl --transport fake --once --once-ms 300
```

Invalid lines are ignored with a warning, and the daemon keeps the last valid
state. In this mode, `sourceMaxBytes` limits each JSONL line. Hardware replies
still require `permissionReplies:true` plus a reply sink such as `replyFile` or
HTTP control memory replies.

## Local HTTP Control

Use `controlServer: true` when another local process should drive the daemon
without writing state files. The server is disabled by default and should stay
bound to loopback unless a later packaging layer adds stronger access control.

```json
{
  "source": "static",
  "transport": "fake",
  "controlServer": true,
  "controlHost": "127.0.0.1",
  "controlPort": 27217,
  "permissionReplies": false
}
```

Current endpoints:

- `GET /health`
- `GET /status`
- `GET /replies`
- `GET /replies/stream`
- `GET /quick-commands/presets`
- `GET /quick-commands`
- `POST /state`
- `POST /snapshot`
- `POST /quick-commands`

`POST /state` accepts the same shape as the JSON file source:

```json
{
  "sessions": [
    {
      "id": "standalone",
      "title": "HTTP Task",
      "state": "thinking"
    }
  ],
  "permissions": [],
  "doNotDisturb": false
}
```

Add `controlToken` to require either `Authorization: Bearer <token>` or
`X-ClaudeBuddy-Token: <token>` on every request. The control API can carry
session titles and permission metadata, so keep it local and treat it as
plaintext local IPC.

Quick Commands are disabled unless `quickCommands:true` is set. The runtime
validates preset ids and emits cursor-buffered command events for one configured
adapter to consume. It does not execute `show_diff`, infer the active session,
fill prompt text, or perform foreground-window automation. For local smoke:

```powershell
node bin\claudebuddy.js --config examples\claudebuddy.quick-commands.config.json
Invoke-RestMethod http://127.0.0.1:27217/quick-commands/presets
Invoke-RestMethod http://127.0.0.1:27217/quick-commands `
  -Method Post `
  -ContentType application/json `
  -Body '{"id":"plan_first","source":"http","clientRequestId":"manual-plan-first-1"}'
Invoke-RestMethod "http://127.0.0.1:27217/quick-commands?after=0"
```

The reference adapter consumer can turn those events into JSONL action records
without touching any foreground window or workspace shell:

```powershell
node bin\claudebuddy-quick-command-consumer.js `
  --config examples\claudebuddy.quick-commands.config.json `
  --once `
  --wait-ms 0
```

By default it appends to `logs\quick-command-actions.jsonl`. Message presets are
adapter-owned message proposals, constraint presets use `duration:"next_turn"`,
and `show_diff` remains a `local_action` with `runShell:false`. Run only one
executing consumer for a daemon until a future claim/ack protocol is added.

Adapters can surface a finished task to the tray with an explicit signal:

```powershell
Invoke-RestMethod http://127.0.0.1:27217/task-state `
  -Method Post `
  -ContentType application/json `
  -Body '{"sessionId":"session-1","state":"finished","title":"Refactor settings flow","source":"adapter"}'
```

The runtime stores only the latest local task state for this affordance. The tray
shows recent `state:"finished"` signals for a short window and then does
nothing. It never infers completion from Hardware Buddy snapshot counters,
daemon logs, or terminal text.

For HTTP-only approval loops, enable both `controlServer` and
`permissionReplies`. The daemon keeps accepted secure hardware replies in an
in-memory cursor buffer, even without `replyFile`:

```json
{
  "source": "static",
  "transport": "sidecar",
  "backend": "bleak",
  "address": "<discovered-device-address>",
  "controlServer": true,
  "permissionReplies": true,
  "replyBufferSize": 100
}
```

Clients post pending permissions with `POST /state`, then poll:

```powershell
Invoke-RestMethod http://127.0.0.1:27217/replies?after=0
```

The response contains `nextCursor`; pass that value as the next `after` to avoid
processing the same reply twice. Reply records omit full `toolInput`. If
`replyFile` is also configured, the daemon writes both the in-memory reply
buffer and the JSONL file.

For lower idle traffic, long-poll the same endpoint:

```powershell
Invoke-RestMethod "http://127.0.0.1:27217/replies?after=0&wait=30000"
```

If no newer reply is available, the server waits up to `wait` milliseconds
before returning an empty `items` array. The current wait cap is 60000 ms.

For event-driven local adapters, use the SSE stream:

```powershell
Invoke-WebRequest "http://127.0.0.1:27217/replies/stream?after=0"
```

The stream first sends a `ready` event with cursor metadata. Each accepted
hardware reply then arrives as a `permission_reply` event whose SSE `id` is the
reply `seq`; heartbeat events keep the loopback connection active.

## Scheduled Task Shape

A first Windows auto-start path can be a scheduled task. The managed installer
uses the safe default config unless `-Config` is supplied:

```powershell
.\scripts\install-claudebuddy-scheduled-task.ps1
```

Stop and remove that task with:

```powershell
.\scripts\uninstall-claudebuddy-scheduled-task.ps1
```

This is still intentionally lighter than a full Windows Service wrapper. The
current auto-start path is a user logon task around the managed daemon scripts;
the tray is a separate optional resident control surface. A later packaging
slice can add a dedicated service wrapper.

## Safety Defaults

- `permissionReplies` stays `false` unless explicitly enabled.
- Prompt-bearing snapshots still require a secure transport.
- Hardware replies are only durable in standalone mode when a reply sink such as
  `replyFile` is configured. HTTP control mode also keeps a bounded in-memory
  reply buffer for local adapter polling.
- The HTTP control server is disabled by default and should bind to loopback.
  Use `controlToken` for local clients that are not fully trusted.
- `retryMaxAttempts: 0` means retry indefinitely. A positive value counts
  retries after the initial start/connect attempt; for example `3` allows one
  initial attempt plus up to three retries.
- `logLevel` can be `debug`, `info`, `warn`, `error`, or `silent`.
- `--quiet` maps to `warn`; `--verbose` maps to `debug`.
- `logFile` parent directories are created automatically, so avoid pointing it
  at a path you do not intend the daemon to create.
