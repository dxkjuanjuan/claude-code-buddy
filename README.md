# ClaudeBuddy / Clawstick

ClaudeBuddy is a standalone Hardware Buddy bridge runtime for ClaudeBuddy and
Clawstick devices. It can run without Clawd or Electron: a local process feeds
agent state into the runtime, the runtime mirrors that state to a small BLE
device, and secure hardware button replies can be returned to the local adapter
when explicitly enabled.

This package is still pre-release. The npm package is scoped for the standalone
runtime, but `private:true` remains set until the public repository and release
process are finalized.

## What It Provides

- Node CLI and package exports for the bridge core
- Fake transport for local smoke tests without hardware
- Optional Python `bleak` sidecar for Nordic UART BLE devices
- JSON-file, stdin JSONL, and loopback HTTP state inputs
- JSONL, long-poll, and SSE permission reply outputs
- Loopback Quick Commands events for adapter-owned follow-up actions
- Windows daemon, Scheduled Task, tray, and shortcut helper scripts
- Safe public example configs with hardware permission replies disabled by default

Hardware approval replies are fail-closed by default. Turn them on only after
the device is paired/bonded and the runtime reports a secure BLE link.

## Requirements

- Node.js 18 or newer
- Windows for the managed daemon/tray scripts
- Python plus `bleak` only when using the real BLE sidecar
- A Hardware Buddy-compatible Nordic UART device for BLE mode

## Quick Start

From a source checkout:

```powershell
npm install
node bin\claudebuddy.js --help
node bin\claudebuddy.js --config examples\claudebuddy.fake.config.json --once --once-ms 0
```

After package installation, use the `claudebuddy` binary instead of
`node bin\claudebuddy.js`.

## BLE Smoke

Install the optional Python sidecar dependency:

```powershell
pip install -r tools\requirements-sidecar.txt
```

Scan for a compatible device:

```powershell
python tools\hardware_buddy_bridge.py --backend bleak --scan-timeout 8
```

Run the safe BLE template:

```powershell
node bin\claudebuddy.js --config examples\claudebuddy.http-ble.example.config.json --once --once-ms 6000
```

The public BLE template scans by `namePrefix`, enables the loopback HTTP control
server, and keeps `permissionReplies:false`. Copy it to `claudebuddy.config.json`
and set a discovered `address` when you want a stable fixed-device profile.

## Windows Daemon And Tray

The managed scripts wrap the same Node CLI with a consistent config path, PID
file, log file, status check, and optional autostart:

```powershell
.\scripts\start-claudebuddy-daemon.ps1
.\scripts\status-claudebuddy-daemon.ps1
.\scripts\stop-claudebuddy-daemon.ps1
.\scripts\claudebuddy-control.ps1 -Action status -Json
.\scripts\claudebuddy-tray.ps1 -ValidateOnly -Json
```

Install autostart only after checking the dry run:

```powershell
.\scripts\install-claudebuddy-scheduled-task.ps1 -WhatIf
.\scripts\install-claudebuddy-scheduled-task.ps1 -WhatIf -Json
.\scripts\install-claudebuddy-scheduled-task.ps1
```

Install or remove tray shortcuts:

```powershell
.\scripts\install-claudebuddy-tray-shortcuts.ps1
.\scripts\uninstall-claudebuddy-tray-shortcuts.ps1
```

See [Standalone Daemon On Windows](docs/standalone-daemon-windows.md) for the
full foreground, background, Scheduled Task, tray, and shortcut workflows.

## Local Windows Install

For pre-release local installs, first build a package artifact from the source
checkout:

```powershell
.\scripts\package-claudebuddy-local-release.ps1 -Json
```

Then inspect the install plan before writing anything:

```powershell
.\scripts\install-claudebuddy-local.ps1 -WhatIf -Json
```

The default install writes only a local npm package payload and
`claudebuddy.config.json` under the install directory, then validates the
packaged tray script. When `-InstallDir` is omitted, the install directory is
the current user's `%LOCALAPPDATA%\ClaudeBuddy\Standalone`. It does not create
shortcuts, register autostart, or start the daemon unless you ask for those
steps:

```powershell
.\scripts\install-claudebuddy-local.ps1 -Json
```

Optional install switches touch more of Windows:

- `-AllShortcuts`, `-StartMenu`, or `-Startup` create `.lnk` files. Without
  `-StartMenuDir` / `-StartupDir`, they use the real current-user Start Menu or
  Startup folders.
- `-Autostart` registers a current-user Windows Scheduled Task.
- `-StartDaemon` starts the managed Node daemon immediately.
- `-Force` overwrites an existing generated config from the packaged template.

For isolated smoke runs, pass explicit temp paths:

```powershell
$root = Join-Path $env:TEMP "claudebuddy-local-install"
.\scripts\install-claudebuddy-local.ps1 `
  -InstallDir "$root\install" `
  -Config "$root\install\claudebuddy.config.json" `
  -PidFile "$root\install\logs\claudebuddy-daemon.pid" `
  -StartMenuDir "$root\shortcuts\start-menu" `
  -StartupDir "$root\shortcuts\startup" `
  -Json
```

## Local Windows Uninstall

Preview uninstall first:

```powershell
.\scripts\uninstall-claudebuddy-local.ps1 -WhatIf -Json
```

The default uninstall stops the managed daemon if its PID file is present,
removes the configured Scheduled Task, removes tray shortcuts, and removes the
installed package payload. It keeps config files, logs, and the install
directory by default:

```powershell
.\scripts\uninstall-claudebuddy-local.ps1 -Json
```

Use explicit removal switches for disposable installs:

```powershell
.\scripts\uninstall-claudebuddy-local.ps1 `
  -RemoveConfig `
  -RemoveLogs `
  -RemoveInstallDir `
  -Json
```

`-RemoveInstallDir` only removes the install directory after package/config/log
cleanup leaves it empty. Use `-KeepDaemon`, `-KeepAutostart`, or
`-KeepShortcuts` when you want to leave one of those pieces in place. If you
installed shortcuts with custom `-StartMenuDir` / `-StartupDir`, pass the same
paths during uninstall.

## Configuration

The CLI loads built-in defaults first. If `claudebuddy.config.json` exists in
the current working directory, it is loaded automatically. `--config <path>`
loads an explicit config file, and CLI flags override file values.

Safe packaged templates:

- [examples/claudebuddy.fake.config.json](examples/claudebuddy.fake.config.json)
- [examples/claudebuddy.http-ble.example.config.json](examples/claudebuddy.http-ble.example.config.json)
- [examples/claudebuddy.http-control.config.json](examples/claudebuddy.http-control.config.json)
- [examples/claudebuddy.json-file.config.json](examples/claudebuddy.json-file.config.json)
- [examples/claudebuddy.quick-commands.config.json](examples/claudebuddy.quick-commands.config.json)
- [examples/claudebuddy.stdin-jsonl.config.json](examples/claudebuddy.stdin-jsonl.config.json)
- [examples/state.sample.json](examples/state.sample.json)

Common fields:

```json
{
  "source": "static",
  "transport": "sidecar",
  "backend": "bleak",
  "namePrefix": "Claude",
  "controlServer": true,
  "controlHost": "127.0.0.1",
  "controlPort": 27217,
  "permissionReplies": false,
  "keepaliveMs": 10000,
  "pollStatusMs": 1000,
  "logLevel": "info",
  "jsonLogs": true,
  "logFile": "logs/claudebuddy-daemon.jsonl"
}
```

Use `address` instead of `namePrefix` for a fixed device. Use
`sidecarDiagnostics:false` only when you have already ruled out BLE sidecar
contention and want quieter logs.

## State Inputs

Use `source:"json-file"` when another local process should publish state by
rewriting a file:

```powershell
node bin\claudebuddy.js --config examples\claudebuddy.json-file.config.json
```

Use `source:"stdin-jsonl"` when a parent process owns lifetime and wants to pipe
one state object per line:

```powershell
'{"sessions":[{"id":"standalone","title":"Pipe task","state":"working"}],"permissions":[],"doNotDisturb":false}' | node bin\claudebuddy.js --source stdin-jsonl --transport fake --once --once-ms 300
```

Use `controlServer:true` when another local adapter should drive state over HTTP:

```powershell
node bin\claudebuddy.js --config examples\claudebuddy.http-control.config.json
```

The HTTP surface exposes:

- `GET /health`
- `GET /status`
- `POST /state`
- `POST /snapshot`
- `GET /replies?after=<seq>`
- `GET /replies?after=<seq>&wait=<ms>`
- `GET /replies/stream?after=<seq>`
- `GET /quick-commands/presets`
- `POST /quick-commands`
- `GET /quick-commands?after=<seq>`
- `GET /quick-commands?after=<seq>&wait=<ms>`

`POST /state` accepts the normalized sessions/permissions shape described in
[Normalized Contract](docs/contracts/normalized-contract.md).

## Quick Commands

Quick Commands are opt-in event intents for local adapters. They do not run
shell commands, paste into the foreground window, or inject built-in prompt text.
The runtime validates preset ids and buffers events; one adapter should consume
them and decide how to turn them into messages, temporary constraints, or local
actions.

Enable the local smoke profile with:

```powershell
node bin\claudebuddy.js --config examples\claudebuddy.quick-commands.config.json
```

The Windows tray shows a `Quick Commands` submenu when the daemon/control server
is available and quick commands are enabled. Menu clicks post stable preset ids
to `POST /quick-commands` with `source:"tray"` and a generated
`clientRequestId`; localized labels are display text only.

A reference adapter-facing consumer is available for local smoke and integration
work:

```powershell
node bin\claudebuddy-quick-command-consumer.js --config examples\claudebuddy.quick-commands.config.json --once --wait-ms 0
```

It reads `/quick-commands` and appends `quick_command_action` JSONL records to
`logs\quick-command-actions.jsonl`. Those records are still adapter-owned
actions: message presets become proposed messages, constraint presets use
`duration:"next_turn"`, and `show_diff` is emitted as `local_action` with
`runShell:false`. Configure only one executing consumer until a later claim/ack
protocol exists.

Adapters can also post an explicit task-finished signal for tray affordances:

```powershell
Invoke-RestMethod http://127.0.0.1:27217/task-state `
  -Method Post `
  -ContentType application/json `
  -Body '{"sessionId":"session-1","state":"finished","title":"Refactor settings flow","source":"adapter"}'
```

`/task-state` is disabled with quick commands. The tray treats a recent
`state:"finished"` record as a short-lived prompt to open the Quick Commands
menu; it does not auto-send a command or infer task completion from snapshots,
logs, or terminal text.

## Permission Replies

Permission replies are disabled unless `permissionReplies:true` is set. Accepted
hardware replies can be consumed through:

- `replyFile` / `replyMode:"jsonl"`
- `GET /replies?after=<seq>`
- `GET /replies?after=<seq>&wait=<ms>`
- `GET /replies/stream?after=<seq>`

Reply records intentionally omit full `toolInput`. External adapters should
remove resolved permissions from their source state after consuming a reply; the
runtime also suppresses already replied JSON-file permissions locally while it
waits for the writer to catch up.

If `controlToken` is configured, HTTP clients must send either
`Authorization: Bearer <token>` or `X-ClaudeBuddy-Token: <token>`.

## Package Contents

The npm payload is intentionally narrow:

- `bin/`
- `src/`
- `scripts/`
- Python sidecar files under `tools/`
- safe example configs under `examples/`
- [docs/contracts/normalized-contract.md](docs/contracts/normalized-contract.md)
- [docs/standalone-daemon-windows.md](docs/standalone-daemon-windows.md)

Local hardware profiles, firmware workspaces, experiments, tests, and agent
handoff files are not part of the package payload.

## Development

```powershell
npm test
npm pack --dry-run --json
.\scripts\package-claudebuddy-local-release.ps1 -SkipTests -Json
.\scripts\smoke-claudebuddy-local-artifact.ps1 -Json
.\scripts\install-claudebuddy-local.ps1 -WhatIf -Json
.\scripts\uninstall-claudebuddy-local.ps1 -WhatIf -Json
```

The standalone runtime package currently uses the MIT license. The npm payload
does not include the firmware workspace or Clawstick animation assets.

For the source repository:

- Bridge/runtime source code is MIT licensed unless a file says otherwise.
- `firmware/clawstick` includes code derived from Anthropic's MIT-licensed
  Hardware Buddy reference; see [NOTICE.md](NOTICE.md) and
  [firmware/clawstick/LICENSE.upstream](firmware/clawstick/LICENSE.upstream).
- Clawstick's Clawd GIF/SVG artwork is not covered by MIT. It follows the same
  artwork terms as the main Clawd on Desk repository; see
  [firmware/clawstick/ASSETS-LICENSE.md](firmware/clawstick/ASSETS-LICENSE.md).

Release metadata such as `repository`, `bugs`, and `homepage` will be added
after the public repository URL is finalized.

## Project Scope

ClaudeBuddy is the bridge runtime. Clawstick is the first hardware endpoint.
Desktop apps such as Clawd can integrate through the normalized contract or the
loopback HTTP control surface, but the runtime does not require a desktop UI.

The guiding constraints are:

- Terminal-first: terminal approval remains authoritative.
- UI-optional: the bridge can run headless or through a tray.
- Hardware-thin: the device mirrors state and returns simple decisions.
- Open protocol first: the BLE path stays compatible with the Hardware Buddy
  Nordic UART protocol before adding product-specific extensions.
