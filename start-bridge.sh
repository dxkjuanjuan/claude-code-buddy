#!/bin/bash
# start-bridge.sh - Launch clawstick bridge for Claude Code
#
# This starts the claudebuddy bridge runtime which:
# 1. Connects to M5StickC Plus over BLE
# 2. Starts HTTP control server on 127.0.0.1:27217
# 3. Sends Claude Code status updates to the device
#
# After bridge is running, use the HTTP API to update status:
#   curl -X POST http://127.0.0.1:27217/v1/state -H "Content-Type: application/json" -d '{"state":"working","title":"Claude Code","detail":"Editing files..."}'

cd "$(dirname "$0")"

echo "=== Clawstick Bridge for Claude Code ==="
echo ""
echo "Bridge will connect to Clawstick-4F42 over BLE"
echo "Control server: http://127.0.0.1:27217"
echo ""
echo "API endpoints:"
echo "  POST /v1/state  - Update device state (idle/working/waiting_user/approving/celebrating)"
echo "  GET  /v1/status - Check bridge status"
echo "  GET  /v1/events - SSE stream of events"
echo ""
echo "Starting bridge..."
echo "Press Ctrl+C to stop"
echo ""

node bin/claudebuddy.js --config claudebuddy.config.json
