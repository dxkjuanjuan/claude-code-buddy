# Clawstick 部署包

将 Clawstick M5StickC Plus 连接到 Claude Code CLI，实现 16 种 clawd 表情同步 + 权限审批。

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
│   ├── clawstick-hook.js            # Hook 脚本（事件→Bridge）
│   └── README.md                    # Hook 说明
├── config/
│   ├── claudebuddy.config.json      # Bridge 配置（需改 BLE 地址）
│   ├── snapshot.js                  # Bridge 快照构建器（含 state 转发）
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

### 2. 配置 Bridge

```bash
# 修改 BLE 地址（用你的 M5 实际地址替换）
# 获取地址：运行 python -c "import asyncio; from bleak import BleakScanner; ..."
# 编辑 config/claudebuddy.config.json 中的 "address" 字段

# 覆盖 snapshot.js
cp config/snapshot.js ../src/hardware-buddy/snapshot.js
```

### 3. 安装 Hooks

```bash
# 一键安装（修改路径后）
python install-hooks.py --hook-path "C:/path/to/clawstick/hooks/clawstick-hook.js" --node-path "D:\node.exe"

# 或手动：将 config/claude-code-hooks-template.json 中的 hooks 数组合并到
# ~/.claude/settings.json 的 "hooks" 字段中
```

### 4. 启动

```bash
# 启动 Bridge
cd ../clawstick/
node bin/claudebuddy.js --config claudebuddy.config.json --source static --state idle

# 验证连接
curl http://127.0.0.1:27217/status
# 期望: transport.connected=true, transport.secure=true

# 启动 Claude Code，M5 应自动显示 idle 表情
claude
```

## 新电脑使用

只需以下步骤：

1. 安装依赖: `pip install bleak platformio` + Node.js
2. 刷固件（步骤1）
3. 改 BLE 地址（步骤2）
4. 安装 hooks（步骤3）
5. 启动 bridge（步骤4）

## 常见问题

### Bridge 连不上 M5

1. 杀掉所有残留进程：
```powershell
wmic process where "name='python.exe'" get ProcessId,CommandLine | findstr hardware_buddy
wmic process where "name='node.exe'" get ProcessId,CommandLine | findstr claudebuddy
taskkill /PID <pid> /F
```
2. 重启 bridge

### 权限提示不显示

1. 确认 `settings.json` 有 `PermissionRequest` hook
2. 确认 bridge `transport.secure=true`
3. 如果 `secure=false`，重启 bridge

### 表情太小

用 `--auto-bbox --fill-ratio 1.0` 重新转换 GIF（详见 CLAWSTICK-GUIDE.md）

### 摇晃后状态错误

确保用的是修改后的 `data.h`，`personaState` 仅在断连时清空
