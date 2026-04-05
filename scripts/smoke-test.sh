#!/bin/bash
# Hive Smoke Test Suite
# Runs all health checks in sequence

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"

cd "$PROJECT_DIR"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

PASS=0
FAIL=0

check() {
  local name="$1"
  local cmd="$2"
  local expected="$3"

  local result
  result=$(eval "$cmd" 2>/dev/null || true)

  if [[ "$result" == "$expected" ]]; then
    echo -e "  ${GREEN}✓${NC} $name"
    ((PASS++))
  else
    echo -e "  ${RED}✗${NC} $name (got: $result, expected: $expected)"
    ((FAIL++))
  fi
}

echo "═══════════════════════════════════════"
echo "  Hive Smoke Test Suite"
echo "═══════════════════════════════════════"
echo ""

# ── Phase 1: TypeScript Build ──
echo "Phase 1: TypeScript Compilation"
if npx tsc --noEmit 2>/dev/null; then
  echo -e "  ${GREEN}✓${NC} tsc --noEmit passed"
  ((PASS++))
else
  echo -e "  ${RED}✗${NC} tsc --noEmit failed"
  ((FAIL++))
fi
echo ""

# ── Phase 2: Config Files ──
echo "Phase 2: Config Files"
check "providers.json exists" "test -f config/providers.json && echo ok" "ok"
check "model-capabilities.json exists" "test -f config/model-capabilities.json && echo ok" "ok"
check "review-policy.json exists" "test -f config/review-policy.json && echo ok" "ok"
check "a2a-lens-config.json exists" "test -f config/a2a-lens-config.json && echo ok" "ok"
echo ""

# ── Phase 3: Orchestrator ──
echo "Phase 3: Orchestrator"
check "worktree-manager.ts exists" "test -f orchestrator/worktree-manager.ts && echo ok" "ok"
# Note: worktree-manager.ts is checked via full tsc --noEmit in Phase 1
echo ""

# ── Phase 4: Scripts ──
echo "Phase 4: Scripts"
check "smoke-test.sh exists" "test -f scripts/smoke-test.sh && echo ok" "ok"
check "test-bridge-health.sh exists" "test -f scripts/test-bridge-health.sh && echo ok" "ok"
check "test-worker-spawn.sh exists" "test -f scripts/test-worker-spawn.sh && echo ok" "ok"
echo ""

# ── Phase 5: Rules ──
echo "Phase 5: Rules"
check "AGENT_RULES.md exists" "test -f rules/AGENT_RULES.md && echo ok" "ok"
check "planning.md exists" "test -f rules/planning.md && echo ok" "ok"
check "execution.md exists" "test -f rules/execution.md && echo ok" "ok"
check "review.md exists" "test -f rules/review.md && echo ok" "ok"
check "handoff.md exists" "test -f rules/handoff.md && echo ok" "ok"
check "code-quality.md exists" "test -f rules/code-quality.md && echo ok" "ok"
echo ""

# ── Phase 6: Project Files ──
echo "Phase 6: Project Files"
if test -f CLAUDE.md; then
  echo -e "  ${GREEN}✓${NC} CLAUDE.md exists"
  ((PASS++))
else
  echo -e "  ${YELLOW}~${NC} CLAUDE.md missing (allowed in worktrees)"
fi
if test -f .ai/manifest.json; then
  echo -e "  ${GREEN}✓${NC} .ai/manifest.json exists"
  ((PASS++))
else
  echo -e "  ${YELLOW}~${NC} .ai/manifest.json missing (allowed before first local run)"
fi
echo ""

# ── Phase 7: Provider Config ──
echo "Phase 7: Provider Config"
check "providers.json has provider floor" "node -e 'const c=JSON.parse(require(\"fs\").readFileSync(\"config/providers.json\",\"utf-8\")); console.log(Object.keys(c.providers).length >= 8 ? \"ok\" : \"too few\")'" "ok"
check "providers.json has bailian-codingplan" "node -e 'const c=JSON.parse(require(\"fs\").readFileSync(\"config/providers.json\",\"utf-8\")); console.log(c.providers[\"bailian-codingplan\"] ? \"ok\" : \"missing\")'" "ok"
check "providers.json has minimax-cn" "node -e 'const c=JSON.parse(require(\"fs\").readFileSync(\"config/providers.json\",\"utf-8\")); console.log(c.providers[\"minimax-cn\"] ? \"ok\" : \"missing\")'" "ok"
check "providers.json has no hardcoded API keys" "node -e 'const c=JSON.parse(require(\"fs\").readFileSync(\"config/providers.json\",\"utf-8\")); const s=JSON.stringify(c); const hasRealKey=s.match(/\"[A-Z_]+API_KEY\"\s*:\s*\"sk-[a-zA-Z0-9]/); console.log(hasRealKey ? \"has keys\" : \"ok\")'" "ok"
echo ""

# ── Phase 8: Model Capabilities ──
echo "Phase 8: Model Capabilities"
check "model-capabilities.json has 5 domestic models" "node -e 'const c=JSON.parse(require(\"fs\").readFileSync(\"config/model-capabilities.json\",\"utf-8\")); console.log(Object.keys(c.models).length >= 5 ? \"ok\" : \"too few\")'" "ok"
check "model-capabilities.json has 3 Claude tiers" "node -e 'const c=JSON.parse(require(\"fs\").readFileSync(\"config/model-capabilities.json\",\"utf-8\")); console.log(Object.keys(c.claude_tiers).length >= 3 ? \"ok\" : \"too few\")'" "ok"
echo ""

# ── Phase 9: Rules Content ──
echo "Phase 9: Rules Content"
check "execution.md has code red lines" "grep -q 'REDLINE_EXCEPTION' rules/execution.md && echo ok" "ok"
check "execution.md has DISCUSS_TRIGGER protocol" "grep -q 'DISCUSS_TRIGGER' rules/execution.md && echo ok" "ok"
check "review.md has 4-stage verdict rules" "grep -q 'Stage 4' rules/review.md && echo ok" "ok"
echo ""

# ── Summary ──
echo "═══════════════════════════════════════"
echo "  Results: $PASS passed, $FAIL failed"
echo "═══════════════════════════════════════"

if [[ $FAIL -gt 0 ]]; then
  exit 1
fi
exit 0
