# Clawstick 部署包（共用方案）

将 Clawstick M5StickC Plus 连接到 Claude Code CLI，通过 clawd-on-desk 实现 16 种 clawd 表情同步 + 权限审批。

**共用方案**：M5 依赖 clawd-on-desk 存在，不需要独立运行 clawstick bridge。clawd-on-desk 内部加载 clawstick 的 controller + sidecar，自动通过 BLE 推送状态和权限到 M5。

## 目录结构

```
deploy/
├── install-hooks.py                 # 一键安装 Claude Code hooks
├── firmware-mods/
│   ├── main.cpp                     # 修改后的固件主文件
│   ├── character.cpp                # 修改后的 GIF 播放引擎
│   ├── data.h                       # 修改后的数据解析
│   └── README.md                    # 固件改动说明
├── hooks/
│   ├── clawstick-hook.js            # Hook 脚本（事件→clawd-on-desk /state）
│   └── README.md                    # Hook 说明
├── config/
│   ├── claude-code-hooks-template.json  # hooks 模板（供参考）
│   └── README.md                    # 配置说明
└── SETUP.md                         # 本文件
```

## 快速开始

### 1. 刷固件

```bash
# 将 firmware-mods/ 中的 3 个文件覆盖到 firmware/clawstick/src/
cp firmware-mods/main.cpp    ../firmware/clawstick/src/
cp firmware-mods/character.cpp ../firmware/clawstick/src/
cp firmware-mods/data.h      ../firmware/clawstick/src/

# 编译烧录
cd ../firmware/clawstick
python -m platformio run -t upload      # 固件
python -m platformio run -t uploadfs    # GIF 文件系统
```

### 2. 设置环境变量

clawd-on-desk 需要找到 clawstick 核心模块。设置环境变量：

```powershell
# 设置用户环境变量（永久生效）
[System.Environment]::SetEnvironmentVariable('CLAWD_HARDWARE_BUDDY_ROOT', 'C:\Users\21244\Desktop\m5stack\clawstick', 'User')
```

### 3. 配置 clawd-on-desk

1. 打开 clawd-on-desk 设置（右键宠物图标 → 设置）
2. 进入 **远程审批 (Telegram Approval)** 标签页
3. 在 **硬件伙伴 (Hardware Buddy)** 卡片中：
   - 启用开关
   - 填入 M5 的 BLE 地址（用 `python -c "import asyncio; from bleak import BleakScanner; ..."` 扫描获取）
   - 启用权限批准 (Permissions)

### 4. 安装 Hooks

```bash
# 一键安装（修改路径后）
python install-hooks.py --hook-path "C:/path/to/clawstick/hooks/clawstick-hook.js" --node-path "D:\node.exe"

# 或手动：将 config/claude-code-hooks-template.json 中的 hooks 数组合并到
# ~/.claude/settings.json 的 "hooks" 字段中
```

**注意**：共用方案下，clawd-on-desk 已经注册了自己的 hooks（clawd-hook.js）和 PermissionRequest HTTP hook。
clawstick-hook.js 会额外注册相同的 command hooks，产生重复推送。
建议只保留 clawd-on-desk 的 hooks，移除 clawstick-hook.js 的条目。
PermissionRequest 由 clawd-on-desk 的 HTTP hook (POST /permission) 处理，不要重复注册。

### 5. 启动

```bash
# 启动 clawd-on-desk（它会自动连接 M5）
# 重启后确认硬件伙伴状态：connected=true, secure=true

# 启动 Claude Code，M5 应自动显示表情同步
claude
```

## 数据流

```
状态更新：Claude Code → clawd-hook.js → POST /state → clawd-on-desk → 内部 clawstick controller → BLE → M5
权限请求：Claude Code → HTTP hook → POST /permission → clawd-on-desk → pendingPermissions → controller snapshot → BLE → M5
M5 批准：M5 按钮 → BLE 命令 → controller → resolvePermissionEntry → HTTP 响应 → Claude Code
```

## 新电脑使用

1. 安装依赖: `pip install bleak platformio` + Node.js
2. 刷固件（步骤1）
3. 设置环境变量（步骤2）
4. 配置 clawd-on-desk（步骤3）
5. 安装 hooks（步骤4，建议只保留 clawd-on-desk 的 hooks）
6. 启动 clawd-on-desk + Claude Code

## 常见问题

### clawd-on-desk 找不到核心模块

日志显示 `core_missing: Hardware Buddy core modules are missing`：
1. 确认环境变量 `CLAWD_HARDWARE_BUDDY_ROOT` 指向 clawstick 仓库路径
2. 重启 clawd-on-desk

### Bridge 连不上 M5

1. 杀掉所有残留进程：
```powershell
wmic process where "name='python.exe'" get ProcessId,CommandLine | findstr hardware_buddy
wmic process where "name='node.exe'" get ProcessId,CommandLine | findstr claudebuddy
taskkill /PID <pid> /F
```
2. 重启 clawd-on-desk

### 权限提示不显示

1. 确认 clawd-on-desk 设置中硬件伙伴的 **Permissions** 开关已启用
2. 确认 `connected=true, secure=true`（secure 为 false 时权限推送被阻止）
3. 如果 `secure=false`，重启 clawd-on-desk 和 M5 重新配对

### 表情太小

用 `--auto-bbox --fill-ratio 1.0` 重新转换 GIF（详见 CLAWSTICK-GUIDE.md）

### 摇晃后状态错误

确保用的是修改后的 `data.h`，`personaState` 仅在断连时清空

### 每次烧录后需要重新连接

M5 固件烧录会重置 BLE 配对信息，需要在 Windows 蓝牙设置中删除设备后重新配对
