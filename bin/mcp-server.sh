#!/bin/bash
# Hive MCP server launcher — resolves node via nvm/shell PATH
# Used as MCP command so Claude Code doesn't need hardcoded node path

# Load nvm if available
export NVM_DIR="$HOME/.nvm"
[ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"

exec node "$(dirname "$0")/../dist/mcp-server/index.js" "$@"
