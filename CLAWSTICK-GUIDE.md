# Clawstick M5StickC Plus 使用指南

## 硬件

- **设备**: M5StickC Plus (ESP32, 135x240 LCD, BLE, IMU)
- **BLE 地址**: 见 `claudebuddy.config.json` 中的 `address` 字段
- **连接方式**: USB Serial (刷机/调试) + BLE NUS (运行时数据传输)
- **按键**: A键=批准权限, B键=拒绝权限; 摇晃触发 dizzy 表情

## 固件架构

```
firmware/clawstick/
├── src/
│   ├── main.cpp          # 主循环、PersonaState 枚举、derive() 状态推导
│   ├── character.cpp     # GIF 播放引擎，16 状态映射
│   ├── data.h            # TamaState 结构体、BLE/USB JSON 解析
│   ├── ble_bridge.cpp    # Nordic UART Service BLE 通信
│   └── ui/               # 界面、覆盖层(权限审批等)
├── data/characters/clawd/ # 16 个 GIF 表情 + manifest.json
└── platformio.ini
```

### 16 种表情状态

| PersonaState | GIF 文件 | 触发场景 |
|---|---|---|
| P_IDLE | idle-120.gif | SessionStart / 无任务 |
| P_BUSY | working-120.gif | PreToolUse(Bash/Edit/Write) |
| P_ATTENTION | thinking-120.gif | UserPromptSubmit |
| P_JUGGLING | juggling-120.gif | SubagentStart / Task/Agent 工具 |
| P_SWEEPING | sweeping-120.gif | PreCompact |
| P_ERROR | error-120.gif | PostToolUseFailure / StopFailure |
| P_CELEBRATE | attention-120.gif | Stop (任务完成) |
| P_NOTIFICATION | notification-120.gif | Notification / Elicitation |
| P_CARRYING | carrying-120.gif | WorktreeCreate |
| P_SLEEP | sleeping-120.gif | SessionEnd / 断连 |
| P_DIZZY | dizzy-120.gif | 物理摇晃 (IMU 触发，非 BLE) |
| P_BUILDING | building-120.gif | clawd-working-building hint |
| P_READING | reading-120.gif | PreToolUse(Read/Grep/Glob) |
| P_BUBBLE | bubble-120.gif | clawd-idle-bubble hint |
| P_DEBUGGER | debugger-120.gif | clawd-working-debugger hint |
| P_ANNOYED | annoyed-120.gif | clawd-react-annoyed hint |

### 状态推导逻辑 (main.cpp derive())

1. 优先使用 `personaState`（来自 bridge 的命名状态字符串）
2. 回退到计数器推导（sessionsRunning/sessionsWaiting）
3. `personaState` 仅在断连时清空，不在计数器重置时清空
4. 摇晃→dizzy 后，如果有任务会返回 working（不会错误回到 idle）

## 数据流

```
Claude Code Hook 事件
    │
    ▼
clawstick-hook.js  (映射事件→session state, POST JSON)
    │  POST http://127.0.0.1:27217/state
    ▼
Bridge HTTP Server  (接收 POST, 调用 source.setState())
    │
    ▼
Controller  (构建 heartbeat snapshot, 含 state + prompt 字段)
    │  transport.send(snapshot)
    ▼
Python Sidecar  (写入 BLE NUS RX characteristic)
    │  NUS RX (分块 GATT 写入, 每块 ≤180 字节)
    ▼
M5StickC Plus  (data.h _applyJson 解析 JSON, 更新显示)
```

### JSON 快照格式 (bridge → M5)

```json
{
  "total": 1,
  "running": 1,
  "waiting": 0,
  "msg": "session title",
  "state": "working",
  "entries": ["title - event"],
  "prompt": {
    "id": "hb_1",
    "tool": "Bash",
    "hint": "echo hello"
  }
}
```

- `state`: 命名状态字符串，固件通过 `nameToPersona()` 映射到 PersonaState
- `prompt`: 权限审批提示，仅当 `bleSecure()=true` 时固件才处理
- `waiting`: 待审批权限数量

## Bridge 运行时

### 启动

```bash
cd clawstick/
node bin/claudebuddy.js --config claudebuddy.config.json --source static --state idle
```

### 配置文件 (claudebuddy.config.json)

| 字段 | 说明 |
|---|---|
| transport | "sidecar" (Python 进程管理 BLE) |
| backend | "bleak" (使用 bleak 库) |
| address | M5 的 BLE MAC 地址 |
| namePrefix | "Clawstick" (扫描过滤) |
| controlPort | 27217 (HTTP 控制服务器) |
| keepaliveMs | 10000 (心跳间隔) |

### Bridge HTTP API

- `POST /state` — 更新 session/permission 状态
- `GET /status` — 查询连接状态、快照、sidecar 信息

## Claude Code Hooks 配置

在 `~/.claude/settings.json` 的 `hooks` 中注册：

```json
{
  "PreToolUse": [
    {
      "matcher": "",
      "hooks": [{
        "type": "command",
        "command": "& \"D:\\node.exe\" \"C:/path/to/clawstick/hooks/clawstick-hook.js\" PreToolUse",
        "shell": "powershell",
        "timeout": 5,
        "async": true
      }]
    }
  ],
  "PermissionRequest": [
    {
      "matcher": "",
      "hooks": [{
        "type": "http",
        "url": "http://127.0.0.1:23333/permission",
        "timeout": 600
      }]
    },
    {
      "matcher": "",
      "hooks": [{
        "type": "command",
        "command": "& \"D:\\node.exe\" \"C:/path/to/clawstick/hooks/clawstick-hook.js\" PermissionRequest",
        "shell": "powershell",
        "timeout": 5,
        "async": true
      }]
    }
  ]
}
```

每个事件都需要注册：SessionStart, SessionEnd, UserPromptSubmit, PreToolUse, PostToolUse, PostToolUseFailure, Stop, StopFailure, SubagentStart, SubagentStop, PreCompact, PostCompact, Notification, Elicitation, WorktreeCreate, PermissionRequest

## 刷机

```bash
cd firmware/clawstick

# 编译固件
python -m platformio run

# 烧录固件
python -m platformio run -t upload

# 烧录文件系统 (GIF 表情 + manifest)
python -m platformio run -t uploadfs
```

### GIF 预处理

源 GIF 来自 clawd-on-desk 仓库的 `assets/gif/` 目录：

```bash
python tools/preprocess-gif.py \
  --auto-bbox --fill-ratio 1.0 --align top \
  --source-duration-s 2.0 --frames 16 \
  <source.gif> <output-120.gif>
```

- `--auto-bbox`: 自动裁剪空白边距
- `--fill-ratio 1.0`: 缩放填满 120x120 画布
- `--align top`: 角色顶部对齐（与状态栏间距一致）
- `--frames 16`: 输出 16 帧（idle 除外，需要 48 帧）
- 注意: `annoyed` 的源文件名是 `clawd-react-annoyed.gif`（不是 `clawd-annoyed.gif`）
- 注意: `attention` 的源文件名是 `clawd-happy.gif`（不是 `clawd-attention.gif`）

## 已知问题与解决方案

### 1. BLE 连接 "device does not expose Nordic UART characteristics"

**症状**: Bridge 日志反复出现此错误，M5 收不到数据

**原因**:
- Windows BLE GATT 缓存过期（固件更新后常见）
- 两个 Python sidecar 进程竞争同一个 BLE 设备

**解决**:
1. 杀掉所有 bridge 和 sidecar 进程
2. 在 Windows 蓝牙设置中删除 M5 设备的配对记录
3. 重启 bridge
4. 如果日志中出现 `existing Hardware Buddy BLE sidecar detected`，杀掉旧的 Python 进程

```powershell
# 查找所有相关进程
wmic process where "name='python.exe'" get ProcessId,CommandLine | findstr hardware_buddy
wmic process where "name='node.exe'" get ProcessId,CommandLine | findstr claudebuddy

# 杀掉旧进程后重启 bridge
taskkill /PID <pid> /F
```

### 2. 权限提示不显示在 M5 上

**症状**: Claude Code 请求权限时，M5 没有显示审批界面

**原因**:
1. `PermissionRequest` hook 未注册（最常见）
2. Bridge 的 `transport.secure` 为 false（固件 `data.h` 中 `bleSecure()` 门控了 prompt 字段）
3. `pendingPermissions` 格式不正确

**解决**:
1. 确认 `settings.json` 中有 `PermissionRequest` hook 指向 clawstick-hook.js
2. 确认 bridge 状态 `transport.secure=true`：`curl http://127.0.0.1:27217/status`
3. 如果 `secure=false`，重启 bridge（见问题1）

### 3. GIF 角色太小

**症状**: 只有 dizzy 大小正常，其他表情角色很小

**原因**: 预处理时未使用 `--auto-bbox --fill-ratio 1.0`，源 GIF 周围有大量空白

**解决**: 用正确的参数重新转换所有 GIF（见"刷机 > GIF 预处理"）

### 4. 摇晃后状态恢复错误（dizzy → idle 而非 working）

**症状**: 工作中摇晃 M5 → 显示 dizzy → 恢复后显示 idle 而非 working

**原因**: `personaState` 在 `sessionsRunning==0` 时被清空

**解决**: `personaState` 仅在断连时清空（`data.h` 的 `dataPoll()` 中 `!out->connected` 分支），不在计数器重置时清空

### 5. Python sidecar 生成子进程

**症状**: 两个 Python `hardware_buddy_bridge.py` 进程同时运行

**说明**: 这是 Windows 上 bleak 的正常行为——主 sidecar 会 spawn 一个子进程处理 BLE 事件循环。**不要杀掉子进程**，否则会导致 bridge 崩溃。如果 BLE 连接不稳定，重启整个 bridge。

### 6. idle GIF 帧数不对

**症状**: idle GIF 只有 8 帧而非 48 帧

**原因**: `--source-duration-s 2.0` 采样窗口太短，idle 源文件有 200+ 帧

**解决**: idle 使用 `--source-duration-s 8.0` 或更大的窗口

## 在新电脑上使用

### 前置条件

1. Node.js (用于运行 bridge + hooks)
2. Python 3.x + bleak (`pip install bleak`)
3. PlatformIO (`pip install platformio`)，仅刷机时需要
4. Claude Code CLI

### 步骤

1. 克隆 clawstick 仓库
2. 编译并烧录固件：`python -m platformio run -t upload && python -m platformio run -t uploadfs`
3. 修改 `claudebuddy.config.json` 中的 `address` 为你的 M5 BLE 地址
4. 启动 bridge：`node bin/claudebuddy.js --config claudebuddy.config.json --source static --state idle`
5. 在 `~/.claude/settings.json` 中注册 hooks（参考上方配置）
6. 启动 Claude Code 会话，M5 应自动显示 idle 表情

### 获取 M5 BLE 地址

```python
import asyncio
from bleak import BleakScanner

async def scan():
    devices = await BleakScanner.discover(timeout=5, return_adv=True)
    for addr, (device, adv) in devices.items():
        name = adv.local_name or ''
        if 'Claw' in name or 'Stick' in name:
            print(f'{addr} {name}')

asyncio.run(scan())
```
