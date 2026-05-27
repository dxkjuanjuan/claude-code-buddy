# Hardware Buddy Core Normalized Contract

Updated: 2026-05-16

The bridge core must not import Clawd, Electron, BrowserWindow, HTTP response
objects, or raw permission entries. Adapters project their runtime state into
this normalized contract before calling `src/hardware-buddy/*`.

## Session Snapshot

`buildHardwareBuddyHeartbeat()` accepts either an array of sessions or an object
with a `sessions` array. The shape intentionally mirrors the public output of
Clawd's `buildSessionSnapshot()`.

Required enough for useful output:

```js
{
  sessions: [
    {
      id: "session-id",
      state: "working",
      displayTitle: "Repo or task title",
      updatedAt: 1710000000000
    }
  ]
}
```

Recognized session fields:

- `id`: stable session id.
- `state`: runtime state. Phase 1 running states are `working`, `thinking`,
  `juggling`, `carrying`, and `sweeping`.
- `displayTitle`: preferred human-readable title.
- `sessionTitle`: fallback title if `displayTitle` is absent.
- `updatedAt`: numeric timestamp used for newest-first ordering.
- `agentId`: optional agent id for adapter/debug use.
- `headless`: when `true`, the session is hidden from the hardware surface.
- `hiddenFromHud`: when `true`, the session is hidden from the hardware surface.
- `lastEvent.rawEvent` or `lastEvent.labelKey`: optional short event label for
  `entries`.

The core does not read `cwd` directly. If an adapter wants the hardware to show a
cwd-derived title, it should project that into `displayTitle` first.

## Permission Metadata

`pendingPermissions` is an array of metadata objects. Adapters must keep raw
runtime entries private and provide `resolvePermissionEntry` through the
controller instead of embedding resolver state here.

Required enough for an approval prompt:

```js
{
  sessionId: "session-id",
  agentId: "claude-code",
  toolName: "Bash",
  toolInput: { command: "git status" },
  createdAt: 1710000000000
}
```

Recognized permission fields:

- `sessionId`: used to match headless session context.
- `agentId`: permission owner. Defaults to `claude-code` if absent.
- `toolName`: displayed as `prompt.tool`; also used to exclude non-approval
  flows.
- `toolInput`: summarized into `prompt.hint`; never sent in full.
- `createdAt`: numeric timestamp; newest eligible permission becomes the active
  `prompt`.
- `headless`: optional direct headless flag. Session context is also checked.
- `isCodex`: Codex official permission.
- `isPi`: Pi permission.
- `isOpencode`: opencode permission. Hardware v1 supports only `once`/`deny`.
- `isElicitation`: excluded from hardware approval.
- `isCodexNotify`: excluded passive notification.
- `isKimiNotify`: excluded passive notification.

Excluded `toolName` values in v1:

- `AskUserQuestion`
- `ExitPlanMode`
- `TaskCreate`
- `TaskUpdate`
- `TaskGet`
- `TaskList`
- `TaskStop`
- `TaskOutput`

## Security Inputs

Prompt-bearing snapshots require `transportSecure: true`. Missing, false, or
unknown security state must suppress `prompt` and must make hardware permission
replies no-ops.

Adapters should update transport security from the BLE sidecar's confirmed
bond/encryption state, not from user intent or device name alone.

## Standalone JSON File Source

The standalone runtime can also poll a local JSON file and project it into this
same contract. This is a simple adapter boundary for shell scripts, hooks, or
other local agent experiments that should not import Clawd or Electron.

```json
{
  "sessions": [
    {
      "id": "standalone",
      "title": "Build firmware",
      "state": "working",
      "updatedAt": 1710000000000,
      "lastEvent": "platformio"
    }
  ],
  "permissions": [
    {
      "id": "prompt-1",
      "sessionId": "standalone",
      "agentId": "claude-code",
      "toolName": "Bash",
      "toolInput": { "command": "npm test" },
      "createdAt": 1710000000001
    }
  ],
  "doNotDisturb": false
}
```

The file source accepts `title` as an alias for `displayTitle`, `tool` as an
alias for `toolName`, and `input` as an alias for `toolInput`. Missing or
invalid files do not stop the daemon; the source keeps the last valid state and
logs a warning.

For standalone approval loops, configure a JSONL reply sink with `replyFile`.
When the device returns `once` or `deny` and the transport is secure, the daemon
appends a record like:

```json
{"type":"permission_reply","id":"prompt-1","promptId":"hb_1","behavior":"allow","decision":"once","sessionId":"standalone","agentId":"claude-code","toolName":"Bash","createdAt":1710000000001,"time":"2026-05-18T00:00:00.000Z"}
```

The reply `id` is the source permission `id` when present, otherwise the
hardware prompt id. The record does not include full `toolInput`; external
writers should correlate by `id`, apply the decision, and remove the matching
permission from the source file.
