#!/bin/bash
# Hive Bridge Health Check
# Tests provider connectivity by reading URLs from config/providers.json

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"

cd "$PROJECT_DIR"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

PROVIDER="${1:-}"
TIMEOUT="${2:-5}"

if [[ -z "$PROVIDER" ]]; then
  echo "Usage: $0 <provider-id> [timeout-seconds]"
  echo ""
  echo "Available providers:"
  node -e "const c=JSON.parse(require('fs').readFileSync('config/providers.json','utf-8')); Object.keys(c.providers).forEach(p => console.log('  - ' + p))"
  exit 1
fi

echo "═══════════════════════════════════════"
echo "  Bridge Health: $PROVIDER"
echo "═══════════════════════════════════════"
echo ""

# Read URL from providers.json
URL=$(node -e "const c=JSON.parse(require('fs').readFileSync('config/providers.json','utf-8')); const p=c.providers['$PROVIDER']; console.log(p?.anthropic_base_url || p?.openai_base_url || '')")
API_KEY_ENV=$(node -e "const c=JSON.parse(require('fs').readFileSync('config/providers.json','utf-8')); const p=c.providers['$PROVIDER']; console.log(p?.api_key_env || '')")
PROTOCOL=$(node -e "const c=JSON.parse(require('fs').readFileSync('config/providers.json','utf-8')); const p=c.providers['$PROVIDER']; console.log(p?.protocol || 'unknown')")

if [[ -z "$URL" ]]; then
  echo -e "  ${RED}✗${NC} Provider '$PROVIDER' not found in config/providers.json"
  exit 1
fi

echo "  Provider: $PROVIDER"
echo "  Protocol: $PROTOCOL"
echo "  URL: $URL"
echo "  Key env: $API_KEY_ENV"
echo ""

# Check if API key is set
API_KEY="${!API_KEY_ENV:-}"
if [[ -z "$API_KEY" ]]; then
  echo -e "  ${YELLOW}⚠${NC} API key env var $API_KEY_ENV is not set"
  echo -e "  ${YELLOW}⚠${NC} Skipping live test (set the env var to enable)"
  exit 0
fi

echo -e "  ${GREEN}✓${NC} API key found"
echo ""

# Health check
echo "Testing connectivity..."

STATUS=$(curl -s -o /dev/null -w "%{http_code}" \
  --max-time "$TIMEOUT" \
  -H "Authorization: Bearer $API_KEY" \
  -H "Content-Type: application/json" \
  "$URL/v1/messages" 2>/dev/null || echo "000")

if [[ "$STATUS" == "200" ]]; then
  echo -e "  ${GREEN}✓${NC} HTTP 200 — Provider is healthy"
elif [[ "$STATUS" == "401" ]]; then
  echo -e "  ${YELLOW}⚠${NC} HTTP 401 — Auth failed (check API key)"
elif [[ "$STATUS" == "000" ]]; then
  echo -e "  ${RED}✗${NC} Connection failed (timeout or unreachable)"
else
  echo -e "  ${YELLOW}⚠${NC} HTTP $STATUS — Unexpected response"
fi
