# Bridge 与 Hook 配置

## 文件说明

| 文件 | 用途 |
|---|---|
| `claudebuddy.config.json` | Bridge 运行时配置（BLE 地址、端口等） |
| `snapshot.js` | Bridge 快照构建器（含 state 字段转发） |

## 1. claudebuddy.config.json

Bridge 启动时读取此配置。**新设备必须修改 `address` 字段为你的 M5 BLE MAC 地址。**

获取 M5 BLE 地址：
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

关键配置项：
- `address`: M5 的 BLE MAC 地址（必须改）
- `controlPort`: HTTP 控制端口（默认 27217）
- `keepaliveMs`: 心跳间隔（默认 10000ms）

## 2. snapshot.js

这是对 `src/hardware-buddy/snapshot.js` 的修改版本。

**改动**: `buildHardwareBuddyHeartbeat()` 新增 `heartbeat.state` 字段，
将最高优先级 session 的 state 字符串（如 "juggling"、"reading"）直接转发给固件，
使固件显示正确的 clawd 表情而非从计数器推导。

**安装**: 覆盖到 `src/hardware-buddy/snapshot.js`

## 3. 启动 Bridge

```bash
cd clawstick/
node bin/claudebuddy.js --config claudebuddy.config.json --source static --state idle
```

验证连接：
```bash
curl http://127.0.0.1:27217/status
# 期望: transport.connected=true, transport.secure=true
```

手动测试状态发送：
```bash
curl -X POST http://127.0.0.1:27217/state \
  -H "Content-Type: application/json" \
  -d '{"sessions":[{"id":"test","state":"thinking","displayTitle":"Test","sessionTitle":"Test","updatedAt":1,"agentId":"claude-code","headless":false,"hiddenFromHud":false,"lastEvent":{"rawEvent":"UserPromptSubmit"}}],"permissions":[],"doNotDisturb":false}'
```
