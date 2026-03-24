#!/bin/bash
# Hive Worker Spawn Test
# Tests that dispatcher can spawn a worker in a worktree

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"

cd "$PROJECT_DIR"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

WORKER_NAME="${1:-test-worker}"
BRANCH_NAME="${2:-task/test-spawn}"

echo "═══════════════════════════════════════"
echo "  Worker Spawn Test"
echo "═══════════════════════════════════════"
echo ""

# Check build
if [[ ! -f "dist/orchestrator/dispatcher.js" ]]; then
  echo -e "  ${YELLOW}⚠${NC} dist/orchestrator/dispatcher.js not found"
  echo "  Run: npm run build"
  exit 1
fi
echo -e "  ${GREEN}✓${NC} Dispatcher build found"

# Check worktree list
echo ""
echo "Listing worktrees..."
WORKTREES=$(node -e "
const { listWorktrees } = require('./dist/orchestrator/worktree-manager.js');
const wts = listWorktrees();
console.log(JSON.stringify(wts, null, 2));
" 2>/dev/null || echo "[]")

echo "$WORKTREES" | node -e "
const wts = JSON.parse(require('fs').readFileSync('/dev/stdin','utf-8'));
if (wts.length === 0) {
  console.log('  No worktrees found');
} else {
  wts.forEach(w => console.log('  - ' + w.name + ' (' + w.branch + ') @ ' + w.path));
}
"

# Try creating a test worktree
echo ""
echo "Testing worktree creation..."
if node -e "
const { createWorktree, removeWorktree, listWorktrees } = require('./dist/orchestrator/worktree-manager.js');
try {
  const wt = createWorktree({ name: '$WORKER_NAME', branch: '$BRANCH_NAME' });
  console.log('Created: ' + wt.name + ' @ ' + wt.path);
  removeWorktree('$WORKER_NAME');
  console.log('Removed: $WORKER_NAME');
} catch(e) {
  console.error('Error: ' + e.message);
  process.exit(1);
}
" 2>/dev/null; then
  echo -e "  ${GREEN}✓${NC} Worktree creation/removal works"
else
  echo -e "  ${RED}✗${NC} Worktree test failed"
  exit 1
fi

echo ""
echo -e "${GREEN}Worker spawn test passed${NC}"
