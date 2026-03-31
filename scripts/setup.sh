#!/usr/bin/env bash
# Hive one-line install & upgrade
# Usage: curl -fsSL https://raw.githubusercontent.com/CtriXin/hive/main/scripts/setup.sh | bash
set -euo pipefail

HIVE_HOME="${HIVE_HOME:-$HOME/.hive-orchestrator}"
REPO_URL="https://github.com/CtriXin/hive.git"
MMS_ROUTES="${MMS_ROUTES_PATH:-$HOME/.config/mms/model-routes.json}"

# ── Colors ──────────────────────────────────────────────
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; CYAN='\033[0;36m'; NC='\033[0m'
ok()   { echo -e "${GREEN}✓${NC} $1"; }
warn() { echo -e "${YELLOW}⚠${NC} $1"; }
err()  { echo -e "${RED}✗${NC} $1"; }
info() { echo -e "${CYAN}→${NC} $1"; }

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo " Hive — One-line Install & Upgrade"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""

# ── Prerequisites ──────────────────────────────────────
info "Checking prerequisites..."

if ! command -v git &>/dev/null; then
  err "git not found. Install git first."
  exit 1
fi

if ! command -v node &>/dev/null; then
  err "Node.js not found. Install Node.js >= 18 first."
  exit 1
fi

NODE_VER=$(node -v | sed 's/v//' | cut -d. -f1)
if [ "$NODE_VER" -lt 18 ]; then
  err "Node.js >= 18 required (found $(node -v))"
  exit 1
fi
ok "Node.js $(node -v), git $(git --version | awk '{print $3}')"

# ── Clone or Pull ──────────────────────────────────────
if [ -d "$HIVE_HOME/.git" ]; then
  info "Upgrading existing installation at $HIVE_HOME..."
  cd "$HIVE_HOME"
  BEFORE=$(git rev-parse HEAD)
  git pull --ff-only origin main 2>&1 | tail -3
  AFTER=$(git rev-parse HEAD)
  if [ "$BEFORE" = "$AFTER" ]; then
    ok "Already up to date"
  else
    COMMITS=$(git log --oneline "$BEFORE".."$AFTER" | wc -l | tr -d ' ')
    ok "Pulled $COMMITS new commit(s)"
  fi
else
  info "Installing Hive to $HIVE_HOME..."
  git clone --depth 1 "$REPO_URL" "$HIVE_HOME" 2>&1 | tail -3
  cd "$HIVE_HOME"
  ok "Cloned"
fi

# ── Install & Build ───────────────────────────────────
info "Installing dependencies..."
npm install --ignore-scripts 2>&1 | tail -3
ok "Dependencies installed"

info "Building..."
npm run build 2>&1 | tail -3
ok "Build complete"

# ── Environment Check ─────────────────────────────────
echo ""
echo "━━━ Environment Check ━━━"

# MMS routes
if [ -f "$MMS_ROUTES" ]; then
  ROUTE_COUNT=$(node -e "try{const r=JSON.parse(require('fs').readFileSync('$MMS_ROUTES','utf8'));console.log(Object.keys(r).length)}catch{console.log(0)}" 2>/dev/null)
  ok "MMS model-routes.json: $ROUTE_COUNT routes"
else
  warn "MMS model-routes.json not found at $MMS_ROUTES"
  echo "  Without it, Hive can only use config/providers.json (requires API keys in env)."
  echo "  Fix: install MMS, or set MMS_ROUTES_PATH=/path/to/model-routes.json"
fi

# API keys
FOUND=0; MISSING=0; MISSING_LIST=""
for KEY_VAR in QWEN_API_KEY KIMI_API_KEY KIMI_CODING_API_KEY GLM_CN_API_KEY GLM_EN_API_KEY MINIMAX_CN_API_KEY MINIMAX_EN_API_KEY BAILIAN_API_KEY; do
  if [ -n "${!KEY_VAR:-}" ]; then
    FOUND=$((FOUND + 1))
  else
    MISSING=$((MISSING + 1))
    MISSING_LIST="$MISSING_LIST $KEY_VAR"
  fi
done

if [ "$FOUND" -gt 0 ]; then
  ok "API keys: $FOUND configured"
fi
if [ "$MISSING" -gt 0 ] && [ ! -f "$MMS_ROUTES" ]; then
  warn "Missing $MISSING API key(s):$MISSING_LIST"
  echo "  These are needed when MMS routes are unavailable."
  echo "  Add to ~/.zshrc or ~/.bashrc: export QWEN_API_KEY=\"your-key\""
fi

# ── Smoke Test ────────────────────────────────────────
echo ""
info "Running smoke test..."
if npm run test:smoke 2>&1 | tail -3; then
  ok "Smoke test passed"
else
  warn "Smoke test had warnings (non-fatal)"
fi

# ── Summary ───────────────────────────────────────────
VERSION=$(node -e "console.log(require('./package.json').version)")
echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo -e " ${GREEN}Hive v${VERSION} ready!${NC}"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""
echo " Location:    $HIVE_HOME"
echo " MCP server:  node $HIVE_HOME/dist/mcp-server/index.js"
echo ""
echo " Add to Claude Code MCP config:"
echo ""
echo "   claude mcp add hive -- node $HIVE_HOME/dist/mcp-server/index.js"
echo ""
echo " Or manually add to ~/.claude.json:"
echo ""
echo "   \"hive\": {"
echo "     \"type\": \"stdio\","
echo "     \"command\": \"node\","
echo "     \"args\": [\"$HIVE_HOME/dist/mcp-server/index.js\"],"
echo "     \"env\": { \"HOME\": \"$HOME\" }"
echo "   }"
echo ""
echo " Upgrade anytime:  curl -fsSL https://raw.githubusercontent.com/CtriXin/hive/main/scripts/setup.sh | bash"
echo " Or from local:    cd $HIVE_HOME && git pull && npm install && npm run build"
echo ""
