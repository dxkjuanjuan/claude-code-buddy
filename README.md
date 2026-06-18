# Claude Code Bully — 基于 clawd-on-desk 与 M5StickC Plus 的 Clawstick / Hardware Buddy for Claude Code

Claude Code Bully 是一个基于 M5StickC Plus 开发板的硬件伴侣，通过 clawd-on-desk 软件与 BLE 连接到电脑，实时显示 Claude Code 的 16 种 clawd 表情，并支持在 M5 上审批权限请求。

Claude Code Bully is an M5StickC Plus-based hardware companion that connects to your PC via clawd-on-desk and BLE, displays 16 clawd expressions from Claude Code in real time, and supports permission approval on the M5 device.

## 架构 / Architecture

```
Claude Code → hooks → clawd-on-desk (port 23333) → BLE → M5StickC Plus
```

共用方案：M5 依赖 clawd-on-desk 作为中间层，不需要独立运行 clawstick bridge。clawd-on-desk 内部加载 clawstick 的 controller + sidecar，自动通过 BLE 推送状态和权限到 M5。

Shared approach: M5 relies on clawd-on-desk as middleware — no independent clawstick bridge needed. clawd-on-desk internally loads clawstick's controller + sidecar, automatically pushing state and permissions to M5 via BLE.

## 功能 / Features

- 16 种 clawd 表情实时同步（idle / working / thinking / error / dizzy 等）
- M5 权限审批：多选项列表（Yes / Yes, always / No），A 上下选择，B 确认
- LED 闪灯：审批提示和 error 状态时闪烁
- 3 个主页面：HOME / STATS / LINK，A 键切换
- 设置菜单：亮度、声音、蓝牙、LED、重置
- 低电量自动关屏、翻转扣下休眠
- BLE 安全配对，权限审批仅限加密通道

## 目录结构 / Directory Structure

```
├── firmware/clawstick/        # M5StickC Plus 固件 (PlatformIO / Arduino)
│   ├── src/                   #   源码
│   └── data/                  #   LittleFS 文件系统 (GIF 角色)
├── src/hardware-buddy/        # clawd-on-desk 集成模块
│   ├── controller.js          #   BLE 状态机 + 权限处理
│   ├── sidecar-client.js      #   Python bleak BLE 客户端
│   ├── snapshot.js            #   状态快照构建 (含 choices)
│   ├── eligibility.js         #   权限过滤
│   └── prompt-id-registry.js  #   prompt ID 映射
├── hooks/                     # Claude Code hook 脚本
│   └── clawstick-hook.js      #   事件 → clawd-on-desk /state
├── deploy/                    # 部署文档和脚本
│   └── SETUP.md               #   详细部署指南
└── scripts/                   # 工具脚本
```

## 快速开始 / Quick Start

### 前置条件 / Prerequisites

- Node.js 18+
- Python 3 + `pip install platformio bleak`
- [clawd-on-desk](https://github.com/nicepkg/clawd) 桌面版
- M5StickC Plus 开发板
- Claude Code CLI

### 1. 刷固件 / Flash Firmware

```bash
cd firmware/clawstick
pio run -t upload      # 编译并烧录固件
pio run -t uploadfs    # 上传 GIF 文件系统（首次必须）
```

### 2. 设置环境变量 / Set Environment Variable

clawd-on-desk 需要找到 clawstick 核心模块：

```powershell
[System.Environment]::SetEnvironmentVariable(
  'CLAWD_HARDWARE_BUDDY_ROOT',
  'C:\Users\<你的用户名>\Desktop\m5stack\clawstick',
  'User'
)
```

clawd-on-desk needs to find clawstick core modules. Set this and **restart clawd-on-desk**.

### 3. 配置 clawd-on-desk / Configure clawd-on-desk

1. 打开 clawd-on-desk 设置（右键宠物图标 → 设置）
2. 进入 **远程审批 (Telegram Approval)** 标签页
3. 在 **硬件伙伴 (Hardware Buddy)** 卡片中：
   - 启用开关
   - 填入 M5 的 BLE 地址
   - 启用权限批准 (Permissions)

扫描 M5 BLE 地址 / Scan for M5 BLE address:

```python
import asyncio
from bleak import BleakScanner

async def scan():
    devices = await BleakScanner.discover(timeout=10)
    for d in devices:
        if "Claw" in (d.name or ""):
            print(f"{d.address}  {d.name}")

asyncio.run(scan())
```

### 4. Windows 蓝牙配对 / Bluetooth Pairing

1. Windows 蓝牙设置 → 添加设备 → 找到 Clawstick → 配对
2. clawd-on-desk 自动连接（状态变为 connected + secure）

### 5. 验证 / Verify

启动 Claude Code，M5 应自动显示表情同步：

```bash
claude
```

## 权限审批 / Permission Approval

当 Claude Code 请求权限时，M5 弹出审批界面：

- **有选项时**：显示列表（如 Yes / Yes, always / No），A 上下选择，B 确认
- **无选项时**：A 允许，B 拒绝
- LED 红灯闪烁提示有待审批

When Claude Code requests permission, M5 shows the approval overlay:

- **With choices**: scrollable list, A to navigate, B to confirm
- **Without choices**: A to allow, B to deny
- Red LED blinks when approval is pending

## 数据流 / Data Flow

```
状态更新：Claude Code → clawd-hook.js → POST /state → clawd-on-desk → BLE → M5
权限请求：Claude Code → HTTP hook → POST /permission → clawd-on-desk → BLE → M5
M5 审批：M5 按钮 → BLE 命令 → controller → resolvePermissionEntry → HTTP 响应 → Claude Code
```

## 修改记录 / Modifications from Upstream

### 固件 / Firmware (基于 Anthropic Hardware Buddy reference)

| 文件 | 修改内容 |
|------|----------|
| `character.cpp` | 16-state clawd 表情映射；P_ERROR 修正为 error GIF (索引5) |
| `main.cpp` | 16-state 表情系统 + 审批 overlay + 多选项列表；LED 仅在审批/error 时闪；A/B 按钮重映射 |
| `data.h` | TamaState 增加 promptChoices 字段；解析 BLE prompt 中的 choices 数组 |
| `approval.cpp/h` | 完整重写：支持多选项列表，A 滚动 B 确认 |
| `home.cpp` | 状态栏 + 名字/状态/sessions 布局 + 3 页面路由 |
| `link.cpp` | BLE 连接状态 + 电源信息页面 |
| `stats.cpp/h` | Settings 持久化；统计系统（审批/拒绝/小睡/摇晃） |

### 软件 / Software (clawd-on-desk 集成模块)

| 文件 | 修改内容 |
|------|----------|
| `snapshot.js` | heartbeat.prompt 增加 choices 数组，默认 ["Yes", "Yes, always", "No"] |
| `controller.js` | 支持 "always" decision（原版只支持 "once" 和 "deny"） |

### Hook / 钩子

| 文件 | 修改内容 |
|------|----------|
| `clawstick-hook.js` | POST flat JSON 到 clawd-on-desk /state（原版独立 bridge） |

## 换电脑部署 / Deploying on a New PC

1. 安装依赖：`pip install bleak platformio` + Node.js
2. 复制 clawstick 仓库到新电脑
3. 刷固件（步骤1）
4. 设置 `CLAWD_HARDWARE_BUDDY_ROOT` 环境变量（步骤2）
5. 配置 clawd-on-desk：扫描并填入新 M5 的 BLE 地址（步骤3）
6. Windows 蓝牙配对（步骤4）
7. 启动 clawd-on-desk + Claude Code

**注意**：每台 M5 的 BLE 地址不同，必须重新扫描。每次刷固件后需删除 Windows 上的蓝牙配对重新连接。

## 常见问题 / Troubleshooting

| 问题 | 解决方案 |
|------|----------|
| clawd-on-desk 找不到核心模块 | 确认 `CLAWD_HARDWARE_BUDDY_ROOT` 指向仓库路径，重启 clawd-on-desk |
| 权限提示不显示 | 确认硬件伙伴的 Permissions 开关已启用；确认 connected=true, secure=true |
| 刷固件后连接不上 | 删除 Windows 蓝牙配对，重新配对 |
| error 状态显示扫地 GIF | 已修复：P_ERROR 现在映射到 error GIF |
| 审批只有 allow/deny | 需要更新 clawd-on-desk 里的 snapshot.js（本仓库已包含） |

## License

- Bridge/runtime 源码：MIT
- `firmware/clawstick` 包含基于 Anthropic MIT 许可的 Hardware Buddy 参考代码，见 [NOTICE.md](NOTICE.md)
- Clawd GIF/SVG 美术素材遵循 clawd-on-desk 的素材条款，见 [ASSETS-LICENSE.md](firmware/clawstick/ASSETS-LICENSE.md)
