# Claude Code Hook 脚本

## clawstick-hook.js

将 Claude Code CLI 的 hook 事件桥接到 clawstick bridge 运行时。

### 工作原理

1. Claude Code 触发 hook 事件（如 PreToolUse、PermissionRequest）
2. 本脚本从 stdin 读取 JSON payload
3. 将事件映射为 session state（如 PreToolUse→"working"、Read→"reading"）
4. POST JSON 到 `http://127.0.0.1:27217/state`
5. Bridge 通过 BLE 转发到 M5

### 事件→状态映射

| 事件 | 状态 | 说明 |
|---|---|---|
| SessionStart | idle | 会话开始 |
| SessionEnd | sleeping | 会话结束 |
| UserPromptSubmit | thinking | 用户提交提示 |
| PreToolUse | working | 工具调用前（默认） |
| PreToolUse(Read/Grep/Glob) | reading | 读取类工具 |
| PreToolUse(Task/Agent) | juggling | 子代理 |
| PostToolUse | working | 工具调用后 |
| PostToolUseFailure | error | 工具调用失败 |
| Stop | attention | 停止（任务完成） |
| StopFailure | error | 停止失败 |
| SubagentStart | juggling | 子代理启动 |
| SubagentStop | working | 子代理停止 |
| PreCompact | sweeping | 上下文压缩前 |
| PostCompact | thinking | 上下文压缩后 |
| Notification | notification | 通知 |
| Elicitation | notification | 引导 |
| WorktreeCreate | carrying | 工作树创建 |
| PermissionRequest | attention | 权限请求 |

### PermissionRequest 特殊处理

当事件为 PermissionRequest 时，额外发送 `permissions` 数组到 bridge，
使 M5 显示权限审批界面（A=批准，B=拒绝）。

权限数据格式：
```json
{
  "permissions": [{
    "sessionId": "session_id",
    "agentId": "claude-code",
    "toolName": "Bash",
    "toolInput": {"command": "..."},
    "createdAt": 1234567890000
  }]
}
```
