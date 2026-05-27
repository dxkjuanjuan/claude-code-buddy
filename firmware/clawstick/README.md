# Clawstick Firmware

This is the first repo-local Clawstick firmware mainline. It starts from the
validated `upstream/claude-desktop-buddy` baseline at local commit
`74c4365 Enforce secure BLE NUS access`, then adds a small Clawstick
configuration layer so this tree can diverge without editing the upstream
mirror.

The upstream reference tree may exist locally at
`upstream/claude-desktop-buddy` as a known-good recovery/comparison checkout,
but it is not part of the public repository. Make new Clawstick firmware
changes here unless the task is explicitly to refresh a local mirror.

## Environments

- `clawstick-m5stickc-plus`: the product mainline. It advertises as
  `Clawstick-XXXX`.
- `compat-claude-m5stickc-plus`: compatibility build for existing local smoke
  paths that scan for `Claude-XXXX`.

Both environments target the tested M5StickC Plus-compatible ESP32 path and keep
the secure NUS behavior validated in the upstream mirror.

## Verification

Build both environments before opening a release or flashing a device:

```powershell
python -m platformio run -d firmware\clawstick -e clawstick-m5stickc-plus
python -m platformio run -d firmware\clawstick -e compat-claude-m5stickc-plus
```

For hardware smoke, upload the desired environment, scan/connect through the
bridge runtime, confirm status reports a secure link after pairing, send a test
snapshot, and verify the approval buttons emit `once` and `deny` decisions.

## Build

From the repository root:

```powershell
python -m platformio run -d firmware\clawstick -e clawstick-m5stickc-plus
```

Compatibility build:

```powershell
python -m platformio run -d firmware\clawstick -e compat-claude-m5stickc-plus
```

## Upload

Verify the serial port first; the port name changes by machine and USB slot.

```powershell
python -m esptool --port <PORT> chip-id
python -m platformio run -d firmware\clawstick -e clawstick-m5stickc-plus -t upload --upload-port <PORT>
```

Use the compatibility environment when you want the device to keep advertising
with the `Claude` prefix:

```powershell
python -m platformio run -d firmware\clawstick -e compat-claude-m5stickc-plus -t upload --upload-port <PORT>
```

Changing the advertised prefix may require updating the host config
`namePrefix` or using a fixed BLE address. Pair/bond again if the BLE security
state was cleared.

NVS compatibility note: settings, stats, owner, bonds, and any stored pet name
still use the upstream `buddy` namespace. The old species key is ignored, and a
legacy `{"cmd":"species"}` command is acknowledged only so older senders do not
hang. A device with an existing `petname` key keeps that name. A device upgraded
from upstream without an explicit pet name will show
`CLAWSTICK_DEFAULT_PET_NAME` instead of the old compiled-in `Buddy` default.

## Scope

This tree should stay protocol-compatible with the Hardware Buddy BLE reference
while becoming the place for Clawstick-specific UI, settings, and interaction
work. Keep reusable desktop/runtime protocol logic in the repository root
bridge core; keep firmware-only behavior here.

The first personalization layer is intentionally small and protocol-neutral:
the boot screen, default pet name, no-link message, approval labels, and
about/link/credits copy read from `src/clawstick_config.h`. Button decisions
and BLE JSON remain compatible with the upstream Hardware Buddy protocol.

The compatibility environment preserves the `Claude-XXXX` BLE prefix only; UI
copy still comes from the Clawstick configuration layer.

## Licensing And Attribution

The firmware source started from Anthropic's MIT-licensed
`claude-desktop-buddy` reference. Keep the upstream notice in
`LICENSE.upstream` with redistributed copies of this firmware tree.

Clawd character artwork and animation files under `assets/` and
`data/characters/clawd/` are not covered by the source-code license. They follow
the same artwork terms as the main Clawd on Desk repository; see
`ASSETS-LICENSE.md`.
