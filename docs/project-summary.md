# Claude Code Buddy 项目总结 / Project Summary

## 项目概述 / Project Overview

将 M5StickC Plus 开发板通过 BLE 连接到电脑，配合 clawd-on-desk 软件，实现 Claude Code 的 16 种 clawd 表情实时同步和硬件权限审批。

---

## 遇到的问题及解决方案 / Problems & Solutions

### 1. 共用方案 vs 独立 bridge

**问题**：最初 clawstick 作为独立 bridge（port 27217）运行，与 clawd-on-desk（port 23333）同时存在，产生冲突——两个进程争抢 BLE 连接，状态推送重复。

**解决**：改为共用方案——M5 完全依赖 clawd-on-desk，不再独立运行 clawstick bridge。clawd-on-desk 内部加载 clawstick 的 controller.js + sidecar-client.js，统一管理 BLE 连接和状态推送。hook 脚本改为直接 POST 到 clawd-on-desk 的 `/state` 端点。

**效果**：消除 BLE 冲突，单一数据源，状态同步稳定。

---

### 2. clawd-on-desk 返回 "400 unknown state"

**问题**：hook 脚本发送嵌套 JSON 格式（`sessions` + `permissions` 对象），clawd-on-desk 的 `/state` 端点期望扁平字段（`state`, `session_id`, `event` 等）。

**解决**：重写 `clawstick-hook.js`，构建扁平 JSON body：
```json
{"state":"working","session_id":"xxx","event":"UserPromptSubmit","tool_name":"Bash"}
```

**效果**：状态推送正常，M5 表情实时同步。

---

### 3. clawd-on-desk 找不到 clawstick 核心模块（core_missing）

**问题**：clawd-on-desk 内部通过 `path.resolve(__dirname, "..", "..", "clawstick")` 查找核心模块，但安装版路径结构不同，解析失败。

**解决**：设置系统环境变量 `CLAWD_HARDWARE_BUDDY_ROOT` 指向 clawstick 仓库路径：
```powershell
[System.Environment]::SetEnvironmentVariable('CLAWD_HARDWARE_BUDDY_ROOT', 'C:\...\clawstick', 'User')
```

**效果**：clawd-on-desk 启动时正确加载 controller.js + sidecar-client.js，BLE 自动连接。

---

### 4. clawd-prefs.json 配置被覆盖

**问题**：直接编辑 `clawd-prefs.json` 文件，clawd-on-desk 重启后配置被重置。

**解决**：必须通过 clawd-on-desk 的 UI 修改设置（右键宠物图标 → 设置 → 远程审批 → 硬件伙伴），不能直接编辑 JSON。

**效果**：配置持久化，重启不丢失。

---

### 5. M5 刷固件后崩溃重启（Guru Meditation Error: Core 0 panic）

**问题**：刷入语言切换固件后，M5 卡在欢迎页一直重启，串口报错 `Interrupt wdt timeout on CPU0`，ISR 上下文崩溃。

**排查**：
- 怀疑是语言切换代码引入的 bug → 检查 `langCurrent()` 是否在 ISR/BLE 回调中调用 → 否，只在 UI 渲染中使用
- 怀疑是每次刷固件后 BLE 配对丢失导致 → 这是已知问题

**解决**：先回退语言切换功能到稳定版本（0c85ed3），恢复正常运行。语言切换功能需要更深入测试后再加回。

**效果**：固件恢复正常，不再崩溃。

**结论**：崩溃大概率与 BLE 重新配对有关，而非语言代码本身。每次刷固件后需删除 Windows 蓝牙配对重新连接。

---

### 6. P_ERROR 显示扫地 GIF 而不是 error GIF

**问题**：`character.cpp` 中 `PERSONA_TO_STATE` 映射表里，`P_ERROR`（索引7）映射到 4（sweeping/扫地），而 error GIF 实际在索引 5。

**原因**：原版映射表有误，P_SWEEPING 和 P_ERROR 都映射到了同一个值 4。

**解决**：`P_ERROR` 映射从 4 改为 5：
```cpp
5,  // P_ERROR -> error  (原来是 4 -> sweeping)
```

**效果**：BLE 断连时 M5 显示 error 表情而非扫地表情。

---

### 7. 审批界面只有 allow/deny，没有 Yes/Yes always/No

**问题**：Claude Code 的 PermissionRequest 支持 "Yes" / "Yes, always" / "No" 等多选项，但 M5 上只显示 A:allow / B:deny 两个按钮。

**原因链条**：
1. Claude Code HTTP hook 发送 `choices` 数组 → clawd-on-desk 收到
2. clawd-on-desk 的 pendingPermission entry **没有保存 choices 字段**（主进程代码在 asar 包里，无法直接修改）
3. `snapshot.js` 构建 heartbeat.prompt 时只传 `{id, tool, hint}`，不传 choices
4. M5 收到的 BLE 数据没有 choices，走 fallback 的 A:allow / B:deny

**解决**：
- `snapshot.js`：heartbeat.prompt 新增 `choices` 字段，由于 entry 无 choices，默认填充 `["Yes", "Yes, always", "No"]`
- `controller.js`：`handlePermissionCommand` 新增 `"always"` decision 识别（原版只识别 `"once"` 和 `"deny"`）
- M5 固件 `data.h`：TamaState 新增 `promptChoices[4][16]` + `promptChoiceCount`
- M5 固件 `approval.cpp`：重写审批界面，有 choices 时显示可滚动列表，A 上下选择，B 确认
- M5 固件 `main.cpp`：A 键在 choices 模式下循环选项，B 键确认选中项

**效果**：有 choices 时 M5 显示选项列表，A 上下滚动，B 确认。无 choices 时保持 A:allow / B:deny。但 choices 的实际触发还需 clawd-on-desk 主进程配合（当前 AskUserQuestion 等交互不触发 PermissionRequest）。

---

### 8. LED 在 thinking 时闪烁，审批时不闪

**问题**：原版 LED 在 `P_ATTENTION`（thinking）状态时闪烁，审批提示和 error 状态时不闪。用户体验不合理——thinking 是正常工作状态不需要提示，审批和报错才需要引起注意。

**解决**：LED 闪烁条件从 `P_ATTENTION` 改为 `inPrompt || P_ERROR`：
```cpp
if (inPrompt) needBlink = true;
if (activeState == P_ERROR) needBlink = true;
```

**效果**：LED 仅在有待审批权限或 BLE 断连（error）时闪烁提醒用户。

---

### 9. PlatformIO 编译路径问题

**问题**：`pio` 命令在不同工作目录下报错 "Not a PlatformIO project"。

**解决**：必须在 `firmware/clawstick/` 目录下执行 pio 命令，该目录包含 `platformio.ini`。

---

### 10. Git 推送超时

**问题**：`git push` 反复超时或卡住，GitHub API 可达但 git push 不通。

**解决**：网络波动导致，多次重试后成功。可能是 DNS 或代理问题（GitHub 解析到 `198.18.0.33`，疑似经过代理）。

---

## 最终架构 / Final Architecture

```
Claude Code CLI
  ├── hooks (clawd-hook.js) ──── POST /state ────→ clawd-on-desk (port 23333)
  └── PermissionRequest HTTP hook ── POST /permission ──→ clawd-on-desk
                                                    │
                                         ┌──────────┴──────────┐
                                         │  controller.js      │
                                         │  ├─ BLE 状态机      │
                                         │  ├─ 权限处理        │
                                         │  │  ├─ "once"→allow │
                                         │  │  ├─ "always"→allow│ ← 新增
                                         │  │  └─ "deny"→deny  │
                                         │  └─ snapshot 构建   │
                                         │     └─ +choices []  │ ← 新增
                                         └──────────┬──────────┘
                                                    │ BLE (Nordic UART)
                                                    ▼
                                            M5StickC Plus
                                          ┌──────────────┐
                                          │ 16-state GIF │
                                          │ 审批 overlay  │
                                          │ LED 闪烁提示  │
                                          └──────────────┘
```

## 两个 GitHub 仓库

| 仓库 | 用途 | 地址 |
|------|------|------|
| claude-code-buddy | 完整项目仓库（含 release 下载包） | https://github.com/dxkjuanjuan/claude-code-buddy |
| clawd-on-desk-buddy- | 修改文件仓库（详细改动说明） | https://github.com/dxkjuanjuan/clawd-on-desk-buddy- |

## 待解决 / Open Issues

1. **choices 实际触发**：AskUserQuestion 等 Claude Code 交互不经过 PermissionRequest hook，无法触发 M5 审批弹窗。需要 Claude Code 或 clawd-on-desk 侧配合。
2. **中文显示**：M5StickC Plus 默认字体不支持中文，需要加载 VLW 字体文件。语言切换功能因启动崩溃已回退，待稳定后重新实现。
3. **clawd-on-desk 更新覆盖**：修改的 snapshot.js 和 controller.js 在 clawd-on-desk 更新后会被覆盖，需要重新复制。
