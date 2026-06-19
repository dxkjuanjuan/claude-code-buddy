# Multi-Session HOME Page Design

**Date**: 2026-06-19
**Status**: Approved

## Context

When multiple Claude Code CLI windows are running, the M5 shows only aggregate counts ("3 sessions") with no way to see individual window info or switch between them. The user needs to:

1. See which project each window is working on
2. Switch between windows with B key (A keeps page cycling)
3. Know which window is asking for approval (avoid misjudging)
4. See creation time and running time in project-settings

## Data Layer

### snapshot.js — New `s` array

Add a compact per-session array to the heartbeat:

```js
s: [
  ["4F42", "m5stack/claw", "working", 1718780123, 1718776500],
  // [id_suffix(4chars), title(16max), state, updatedAt_epoch, createdAt_epoch]
]
```

- Max 4 entries (firmware cap)
- `id_suffix`: last 4 chars of session ID for identification
- `title`: `displayTitle || sessionTitle`, truncated to 16 chars
- `state`: session state string
- `updatedAt`: epoch seconds
- `createdAt`: epoch seconds (0 if unavailable)

### snapshot.js — Prompt session index

Add `si` (session index, 0-based) to the prompt object:

```js
prompt: {
  id: ...,
  tool: ...,
  hint: ...,
  choices: [...],
  si: 2  // which session this prompt belongs to
}
```

### data.h — TamaState extension

```cpp
struct SessionInfo {
  char id[5];        // session id suffix (4 chars + null)
  char title[17];    // project name (16 chars + null)
  char state[9];     // "idle"/"working"/"thinking" (8 + null)
  uint32_t updatedAt; // epoch seconds
  uint32_t createdAt; // epoch seconds (0 = unknown)
};

struct TamaState {
  // ... existing fields unchanged ...
  SessionInfo sessions[4];
  uint8_t  sessionCount;     // actual number of sessions (0-4)
  uint8_t  activeSession;    // currently viewed session (0-based)
  uint8_t  promptSessionIdx; // session index for active prompt (0xFF = none)
};
```

### data.h — _applyJson parsing

Parse `s` array from heartbeat JSON:

```cpp
JsonArray sArr = doc["s"];
if (!sArr.isNull()) {
  out->sessionCount = 0;
  for (uint8_t i = 0; i < 4 && i < sArr.size(); i++) {
    JsonArray row = sArr[i];
    if (row.isNull() || row.size() < 3) continue;
    // parse id, title, state, updatedAt, createdAt
    out->sessionCount = i + 1;
  }
}
```

Parse `prompt.si`:

```cpp
if (!pr.isNull() && bleSecure()) {
  // ... existing prompt parsing ...
  out->promptSessionIdx = pr["si"] | 0xFF;
}
```

On disconnect, zero sessions and clamp `activeSession`.

## UI Layer

### HOME page (home.cpp)

**Status bar**: Add session indicator "1/3" between page dots and clock when `sessionCount > 1`.

**Lower info region** (replaces current name/status/sessions layout):

```
y=140:  Project name (size 2, centered)
y=160:  Divider
y=166:  ● working  (status row, from active session's state)
y=186:  Divider
y=192:  "1/3" session index (size 1, dim, centered)
```

**Caption**: "A >" left, "B switch" right (when sessionCount > 1), else "hold A menu"

### Approval overlay (approval.cpp)

**Title row**: Replace "APPROVAL" with "#N projectname" when `promptSessionIdx < sessionCount`:

```
"#2 m5stack/claw"  +  wait timer "Ns" on right
```

Falls back to "APPROVAL" if session info unavailable.

### Project-settings overlay (main.cpp)

Long-press A on HOME opens overlay showing current session:

```
#1 m5stack/claw
────────────────
run  15m
created  2h ago
────────────────
normal
> dangerous
  auto
  plan
  edit-auto
────────────────
A:sel B:toggle holdA:exit
```

## Interaction Layer

### main.cpp — B key on HOME

When `sessionCount > 1` and on HOME page (no overlay):

```cpp
if (ui_router::current() == ui_router::CARD_HOME) {
  activeSession = (activeSession + 1) % tama.sessionCount;
  beep(1800, 30);
  characterInvalidate(); // refresh GIF state
}
```

### main.cpp — Persona state from active session

Instead of using top-level `personaState`, derive persona from `sessions[activeSession].state` when `sessionCount > 0`.

## Files to Modify

| File | Change |
|------|--------|
| `src/hardware-buddy/snapshot.js` | Add `s` array + `prompt.si` |
| `firmware/.../data.h` | SessionInfo struct, parse `s` array, promptSessionIdx |
| `firmware/.../ui/screens/home.cpp` | Show project name + session index, B hint |
| `firmware/.../ui/overlays/approval.cpp` | Title shows "#N projectname" |
| `firmware/.../main.cpp` | B key session switch, project-settings overlay |

**Not modified**: `sidecar-protocol.js` (s is optional, old sidecar ignores it)

## Verification

1. Flash firmware, restart clawd-on-desk
2. Open 2+ Claude Code CLI windows in different projects
3. Verify HOME shows project name and "1/2" indicator
4. Press B — verify project name changes, "2/2" shown
5. Trigger a permission prompt — verify approval shows "#N projectname"
6. Long-press A — verify project-settings shows run time and created time
7. Single session — verify B does nothing, no "1/1" shown
