#!/usr/bin/env python3
"""将 clawstick hooks 合并到 Claude Code 的 settings.json 中。

用法:
    python install-hooks.py [--hook-path PATH] [--node-path PATH] [--dry-run]

默认值:
    --hook-path  C:/Users/21244/Desktop/m5stack/clawstick/hooks/clawstick-hook.js
    --node-path  D:\\node.exe
"""

import argparse
import json
import os
import sys

# 所有需要注册的 hook 事件
HOOK_EVENTS = [
    "SessionStart",
    "SessionEnd",
    "UserPromptSubmit",
    "PreToolUse",
    "PostToolUse",
    "PostToolUseFailure",
    "Stop",
    "StopFailure",
    "SubagentStart",
    "SubagentStop",
    "PreCompact",
    "PostCompact",
    "Notification",
    "Elicitation",
    "WorktreeCreate",
    "PermissionRequest",
]

SETTINGS_PATH = os.path.expanduser("~/.claude/settings.json")


def build_hook_entry(event, hook_path, node_path):
    """构建一个 clawstick hook 条目。"""
    command = f'& "{node_path}" "{hook_path}" {event}'
    return {
        "matcher": "",
        "hooks": [
            {
                "type": "command",
                "command": command,
                "shell": "powershell",
                "timeout": 5,
                "async": True,
            }
        ],
    }


def load_settings(path):
    """加载 settings.json。"""
    if not os.path.exists(path):
        print(f"settings.json 不存在: {path}")
        print("将创建新文件")
        return {}
    with open(path, "r", encoding="utf-8") as f:
        return json.load(f)


def save_settings(path, settings):
    """保存 settings.json。"""
    with open(path, "w", encoding="utf-8") as f:
        json.dump(settings, f, indent=2, ensure_ascii=False)


def merge_hooks(settings, hook_path, node_path):
    """将 clawstick hooks 合并到 settings 中。返回变更数量。"""
    if "hooks" not in settings:
        settings["hooks"] = {}

    changes = 0
    for event in HOOK_EVENTS:
        entry = build_hook_entry(event, hook_path, node_path)

        if event not in settings["hooks"]:
            settings["hooks"][event] = []

        # 检查是否已存在 clawstick hook
        exists = False
        for existing in settings["hooks"][event]:
            for h in existing.get("hooks", []):
                cmd = h.get("command", "")
                if "clawstick-hook.js" in cmd and event in cmd:
                    exists = True
                    break

        if not exists:
            settings["hooks"][event].append(entry)
            changes += 1
            print(f"  + {event}")
        else:
            print(f"  = {event} (已存在)")

    return changes


def main():
    parser = argparse.ArgumentParser(description="安装 clawstick hooks 到 Claude Code")
    parser.add_argument(
        "--hook-path",
        default="C:/Users/21244/Desktop/m5stack/clawstick/hooks/clawstick-hook.js",
        help="clawstick-hook.js 的路径",
    )
    parser.add_argument(
        "--node-path",
        default="D:\\node.exe",
        help="Node.js 可执行文件路径",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="只显示变更，不写入文件",
    )
    args = parser.parse_args()

    print(f"Settings: {SETTINGS_PATH}")
    print(f"Hook:     {args.hook_path}")
    print(f"Node:     {args.node_path}")
    print()

    settings = load_settings(SETTINGS_PATH)
    print("合并 hooks:")
    changes = merge_hooks(settings, args.hook_path, args.node_path)

    if changes == 0:
        print("\n没有新变更，所有 hooks 已存在。")
        return

    print(f"\n共 {changes} 个 hook 变更。")

    if args.dry_run:
        print("[dry-run] 未写入文件")
        return

    save_settings(SETTINGS_PATH, settings)
    print(f"已写入: {SETTINGS_PATH}")


if __name__ == "__main__":
    main()
