#!/bin/bash
# Hive MCP Registration Helper
# Usage: bash scripts/setup-mcp.sh

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
MCP_SERVER="$PROJECT_DIR/dist/mcp-server/index.js"
SETTINGS_FILE="$HOME/.claude/settings.json"

echo "═══════════════════════════════════════"
echo "  Hive MCP Setup"
echo "═══════════════════════════════════════"
echo ""

# 1. Check build
if [ ! -f "$MCP_SERVER" ]; then
    echo "❌ MCP server not built. Run: npm run build"
    exit 1
fi
echo "✅ MCP server found: $MCP_SERVER"

# 2. Check settings file
if [ ! -f "$SETTINGS_FILE" ]; then
    mkdir -p "$(dirname "$SETTINGS_FILE")"
    echo '{}' > "$SETTINGS_FILE"
    echo "📝 Created $SETTINGS_FILE"
fi

# 3. Check if already registered
if grep -q "hive" "$SETTINGS_FILE" 2>/dev/null; then
    echo "⚠️  hive already in settings.json. Remove it first if you want to re-register."
    echo ""
    echo "Current registration:"
    node -e "const s=JSON.parse(require('fs').readFileSync('$SETTINGS_FILE','utf-8')); console.log(JSON.stringify(s.mcpServers?.['hive']||'not found',null,2))"
    exit 0
fi

# 4. Prompt for API keys
echo ""
echo "Enter API keys (leave blank to skip, you can set env vars later):"
echo ""

read -p "  BAILIAN_API_KEY (sk-sp-*): " BAILIAN_KEY
read -p "  KIMI_CODING_API_KEY (sk-kimi-*): " KIMI_KEY
read -p "  GLM_CN_API_KEY: " GLM_KEY
read -p "  MINIMAX_CN_API_KEY: " MINIMAX_KEY
read -p "  DEEPSEEK_API_KEY: " DEEPSEEK_KEY

# 5. Register
node -e "
const fs = require('fs');
const settings = JSON.parse(fs.readFileSync('$SETTINGS_FILE', 'utf-8'));
if (!settings.mcpServers) settings.mcpServers = {};
settings.mcpServers['hive'] = {
  command: 'node',
  args: ['$MCP_SERVER'],
  env: {
    BAILIAN_API_KEY: '${BAILIAN_KEY}',
    KIMI_CODING_API_KEY: '${KIMI_KEY}',
    GLM_CN_API_KEY: '${GLM_KEY}',
    MINIMAX_CN_API_KEY: '${MINIMAX_KEY}',
    DEEPSEEK_API_KEY: '${DEEPSEEK_KEY}',
  }
};
fs.writeFileSync('$SETTINGS_FILE', JSON.stringify(settings, null, 2));
console.log('✅ Registered hive in ' + '$SETTINGS_FILE');
"

echo ""
echo "═══════════════════════════════════════"
echo "  Done! Restart Claude to load Hive."
echo ""
echo "  Available tools:"
echo "    - translate    (中→英翻译)"
echo "    - plan_tasks   (任务规划)"
echo "    - execute_plan (执行计划)"
echo "    - dispatch_single (单任务调度)"
echo "    - health_check (检查 provider)"
echo "    - model_scores (查看模型评分)"
echo "    - report       (生成中文报告)"
echo "═══════════════════════════════════════"
