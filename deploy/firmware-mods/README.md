# 固件修改说明

本目录包含为支持 16 种 clawd 表情而修改的固件文件。
将这些文件覆盖到 `firmware/clawstick/src/` 对应位置。

## 修改的文件

### 1. main.cpp

**改动**:
- `PersonaState` 枚举从 5 种扩展到 17 种（+1 safety fallback=18），新增：P_JUGGLING, P_SWEEPING, P_NOTIFICATION, P_CARRYING, P_BUILDING, P_READING, P_BUBBLE, P_DEBUGGER, P_ANNOYED
- 新增 `nameToPersona()` 函数：将 bridge 发来的命名状态字符串（如 "juggling"、"reading"）映射到 PersonaState
- `derive()` 优先使用 `s.personaState`，回退到计数器推导
- `personaState` 仅在断连时清空，不在 sessionsRunning==0 时清空（修复 dizzy→idle 而非 dizzy→working 的问题）

### 2. character.cpp

**改动**:
- `STATE_NAMES[]` 从 5 项扩展到 16 项：idle, working, thinking, juggling, sweeping, error, attention, notification, carrying, sleeping, dizzy, building, reading, bubble, debugger, annoyed
- `N_STATES` = 16
- `PERSONA_TO_STATE[18]` 映射表：PersonaState → GIF 资源索引
- `characterSetState()` 边界检查从 `< 16` 改为 `< 18`
- `characterInit()` 解析 manifest.json 的 `states` 数组（L2 schema），拒绝旧版 dict 格式

### 3. data.h

**改动**:
- `TamaState` 结构体新增 `char personaState[20]` 字段
- `_applyJson()` 读取 JSON 的 `"state"` 字段存入 `personaState`
- `personaState` 仅在 `!out->connected` 时清空，不在计数器重置时清空

## 编译烧录

```bash
cd firmware/clawstick

# 覆盖文件后编译
python -m platformio run

# 烧录固件
python -m platformio run -t upload

# 烧录文件系统（GIF 表情）
python -m platformio run -t uploadfs
```
