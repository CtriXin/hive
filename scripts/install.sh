#!/usr/bin/env bash
# Hive installer — works in MMS sandboxed environments
set -euo pipefail

HIVE_DIR="$(cd "$(dirname "$0")/.." && pwd)"
MMS_CONFIG_DIR="${HOME}/.config/mms"
MMS_ROUTES="${MMS_CONFIG_DIR}/model-routes.json"

# ── Colors ──────────────────────────────────────────────
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; NC='\033[0m'
ok()   { echo -e "${GREEN}✓${NC} $1"; }
warn() { echo -e "${YELLOW}⚠${NC} $1"; }
err()  { echo -e "${RED}✗${NC} $1"; }

echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo " Hive Installer v2.0.0"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""

# ── Step 1: Node.js check ──────────────────────────────
echo "▶ Checking Node.js..."
if ! command -v node &>/dev/null; then
  err "Node.js not found. Install Node.js >= 18 first."
  exit 1
fi
NODE_VER=$(node -v | sed 's/v//' | cut -d. -f1)
if [ "$NODE_VER" -lt 18 ]; then
  err "Node.js >= 18 required (found v$(node -v))"
  exit 1
fi
ok "Node.js $(node -v)"

# ── Step 2: npm install ───────────────────────────────
echo ""
echo "▶ Installing dependencies..."
cd "$HIVE_DIR"
npm install --ignore-scripts 2>&1 | tail -3
ok "Dependencies installed"

# ── Step 3: Build ─────────────────────────────────────
echo ""
echo "▶ Building TypeScript..."
npm run build 2>&1 | tail -3
ok "Build complete"

# ── Step 4: MMS model-routes.json check ──────────────
echo ""
echo "▶ Checking MMS model routes..."
if [ -n "${MMS_ROUTES_PATH:-}" ]; then
  MMS_ROUTES="$MMS_ROUTES_PATH"
fi

if [ -f "$MMS_ROUTES" ]; then
  ROUTE_COUNT=$(node -e "const r=JSON.parse(require('fs').readFileSync('$MMS_ROUTES','utf8')); console.log(Object.keys(r).length)" 2>/dev/null || echo "0")
  ok "model-routes.json found ($ROUTE_COUNT routes) at $MMS_ROUTES"
else
  warn "model-routes.json not found at $MMS_ROUTES"
  echo ""
  echo "  Hive uses MMS model-routes.json to resolve model → provider."
  echo "  Without it, only config/providers.json fallback is available."
  echo ""
  echo "  To fix:"
  echo "    1. If MMS is installed, check that model-routes.json exists:"
  echo "       ls ~/.config/mms/model-routes.json"
  echo "    2. Or set MMS_ROUTES_PATH env var to point to your routes file:"
  echo "       export MMS_ROUTES_PATH=/path/to/model-routes.json"
  echo ""
fi

# ── Step 5: API key check ────────────────────────────
echo "▶ Checking API keys..."
MISSING_KEYS=()
FOUND_KEYS=()

check_key() {
  local name="$1" env="$2"
  if [ -n "${!env:-}" ]; then
    FOUND_KEYS+=("$name")
  else
    MISSING_KEYS+=("$env")
  fi
}

check_key "百炼 CodingPlan" "BAILIAN_API_KEY"
check_key "Qwen"            "QWEN_API_KEY"
check_key "Kimi"            "KIMI_API_KEY"
check_key "Kimi CodingPlan" "KIMI_CODING_API_KEY"
check_key "GLM CN"          "GLM_CN_API_KEY"
check_key "GLM EN"          "GLM_EN_API_KEY"
check_key "MiniMax CN"      "MINIMAX_CN_API_KEY"
check_key "MiniMax EN"      "MINIMAX_EN_API_KEY"

if [ ${#FOUND_KEYS[@]} -gt 0 ]; then
  ok "Found ${#FOUND_KEYS[@]} API key(s): ${FOUND_KEYS[*]}"
fi
if [ ${#MISSING_KEYS[@]} -gt 0 ]; then
  warn "Missing ${#MISSING_KEYS[@]} API key(s): ${MISSING_KEYS[*]}"
  echo "  Set them in your shell profile or .env file."
  echo "  At least one provider key is needed for Hive to dispatch tasks."
fi

# ── Step 6: Smoke test ───────────────────────────────
echo ""
echo "▶ Running smoke test..."
if npm run test:smoke 2>&1 | tail -5; then
  ok "Smoke test passed"
else
  warn "Smoke test had issues (non-fatal, check output above)"
fi

# ── Summary ──────────────────────────────────────────
echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo " Installation complete!"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""
echo " Usage:"
echo "   MCP server:  npm run start:mcp"
echo "   CLI:         npx hive"
echo "   Config:      npx hive-config"
echo ""
echo " MCP config (add to Claude settings.json):"
echo "   {"
echo "     \"mcpServers\": {"
echo "       \"hive\": {"
echo "         \"command\": \"node\","
echo "         \"args\": [\"$HIVE_DIR/dist/mcp-server/index.js\"]"
echo "       }"
echo "     }"
echo "   }"
echo ""
