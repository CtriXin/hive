#!/usr/bin/env bash
# Clean Hive installation directory before a fresh reinstall.
# Preserves ~/.hive/config.json, project config, and MMS config by default.
set -euo pipefail

HIVE_HOME="${HIVE_HOME:-$HOME/.hive-orchestrator}"
PURGE_CONFIG="${HIVE_PURGE_CONFIG:-0}"
PURGE_RUNS="${HIVE_PURGE_RUNS:-0}"
PURGE_PROJECT="${HIVE_PURGE_PROJECT:-0}"
PROJECT_ROOT="${HIVE_PROJECT_ROOT:-}"
DRY_RUN="${HIVE_DRY_RUN:-0}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEFAULT_REF="v3.1.0"
if [ -f "$SCRIPT_DIR/../package.json" ]; then
  DEFAULT_REF="v$(node -e "console.log(require('$SCRIPT_DIR/../package.json').version)" 2>/dev/null || echo 3.1.0)"
fi

remove_path() {
  local target="$1"
  local label="$2"
  if [ ! -e "$target" ]; then
    echo "→ $label not found, skipping"
    return
  fi
  if [ "$DRY_RUN" = "1" ]; then
    echo "DRY-RUN would remove: $target ($label)"
    return
  fi
  rm -rf "$target"
  echo "✓ Removed $label"
}

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo " Hive — Clean Install Reset"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""
echo "Install dir: $HIVE_HOME"
echo "Dry run: ${DRY_RUN}"

remove_path "$HIVE_HOME" "install dir"

for WRAPPER in "$HOME/.local/bin/hive" "$HOME/.local/bin/hive-config"; do
  if [ -f "$WRAPPER" ] && grep -Fq "Added by Hive installer" "$WRAPPER" 2>/dev/null; then
    if [ "$DRY_RUN" = "1" ]; then
      echo "DRY-RUN would remove: $WRAPPER (CLI shim)"
    else
      rm -f "$WRAPPER"
      echo "✓ Removed CLI shim $WRAPPER"
    fi
  fi
done

if [ "$PURGE_RUNS" = "1" ]; then
  remove_path "$HOME/.hive-orchestrator-runs" "optional run cache dir ~/.hive-orchestrator-runs"
fi

if [ "$PURGE_CONFIG" = "1" ]; then
  remove_path "$HOME/.hive" "~/.hive config dir"
else
  echo "→ Preserved ~/.hive config dir"
fi

if [ "$PURGE_PROJECT" = "1" ]; then
  if [ -z "$PROJECT_ROOT" ]; then
    echo "⚠ HIVE_PURGE_PROJECT=1 set but HIVE_PROJECT_ROOT is empty; skipping project cleanup"
  else
    echo "Project root: $PROJECT_ROOT"
    remove_path "$PROJECT_ROOT/.hive" "project .hive dir"
    remove_path "$PROJECT_ROOT/.ai" "project .ai dir"
  fi
else
  echo "→ Preserved project .hive/.ai dirs"
fi

echo ""
echo "Reinstall:"
echo "  curl -fsSL https://raw.githubusercontent.com/CtriXin/hive/main/scripts/setup.sh | bash"
echo ""
echo "Fresh reinstall (full clean + stable install):"
echo "  curl -fsSL https://raw.githubusercontent.com/CtriXin/hive/main/scripts/clean-install.sh | env HIVE_PURGE_CONFIG=1 HIVE_PURGE_RUNS=1 HIVE_PURGE_PROJECT=1 HIVE_PROJECT_ROOT=\"\$PWD\" bash && curl -fsSL https://raw.githubusercontent.com/CtriXin/hive/main/scripts/setup.sh | bash"
echo ""
echo "Dry-run fresh reinstall:"
echo "  curl -fsSL https://raw.githubusercontent.com/CtriXin/hive/main/scripts/clean-install.sh | env HIVE_DRY_RUN=1 HIVE_PURGE_CONFIG=1 HIVE_PURGE_RUNS=1 HIVE_PURGE_PROJECT=1 HIVE_PROJECT_ROOT=\"\$PWD\" bash"
echo ""
echo "Options:"
echo "  HIVE_INSTALL_REF=$DEFAULT_REF curl -fsSL https://raw.githubusercontent.com/CtriXin/hive/main/scripts/setup.sh | bash"
echo "  HIVE_CHANNEL=main curl -fsSL https://raw.githubusercontent.com/CtriXin/hive/main/scripts/setup.sh | bash"
echo ""
