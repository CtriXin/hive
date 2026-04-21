#!/usr/bin/env bash
# Clean Hive installation directory before a fresh reinstall.
# Preserves ~/.hive/config.json and MMS config by default.
set -euo pipefail

HIVE_HOME="${HIVE_HOME:-$HOME/.hive-orchestrator}"
PURGE_CONFIG="${HIVE_PURGE_CONFIG:-0}"
PURGE_RUNS="${HIVE_PURGE_RUNS:-0}"

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo " Hive — Clean Install Reset"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""
echo "Install dir: $HIVE_HOME"

if [ -d "$HIVE_HOME" ]; then
  rm -rf "$HIVE_HOME"
  echo "✓ Removed install dir"
else
  echo "→ Install dir not found, skipping"
fi

if [ "$PURGE_RUNS" = "1" ]; then
  rm -rf "$HOME/.hive-orchestrator-runs"
  echo "✓ Removed optional run cache dir ~/.hive-orchestrator-runs"
fi

if [ "$PURGE_CONFIG" = "1" ]; then
  rm -rf "$HOME/.hive"
  echo "✓ Removed ~/.hive config dir"
else
  echo "→ Preserved ~/.hive config dir"
fi

echo ""
echo "Reinstall:"
echo "  curl -fsSL https://raw.githubusercontent.com/CtriXin/hive/main/scripts/setup.sh | bash"
echo ""
echo "Options:"
echo "  HIVE_INSTALL_REF=v2.1.3 curl -fsSL https://raw.githubusercontent.com/CtriXin/hive/main/scripts/setup.sh | bash"
echo "  HIVE_CHANNEL=main curl -fsSL https://raw.githubusercontent.com/CtriXin/hive/main/scripts/setup.sh | bash"
echo ""
