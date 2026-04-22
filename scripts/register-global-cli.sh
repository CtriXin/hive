#!/usr/bin/env bash
set -euo pipefail

HIVE_INSTALL_DIR="${1:-${HIVE_HOME:-$HOME/.hive-orchestrator}}"
HIVE_BIN_DIR="${HIVE_BIN_DIR:-$HOME/.local/bin}"
HIVE_PROFILE_FILE="${HIVE_SHELL_PROFILE:-}"
HIVE_RC_CHANGED=0
HIVE_PROFILE_USED=""

hive_info() { echo "→ $1"; }
hive_ok() { echo "✓ $1"; }
hive_warn() { echo "⚠ $1"; }

hive_choose_profile() {
  if [ -n "$HIVE_PROFILE_FILE" ]; then
    printf '%s\n' "$HIVE_PROFILE_FILE"
    return
  fi

  local shell_name="${SHELL##*/}"
  case "$shell_name" in
    zsh)
      printf '%s\n' "$HOME/.zshrc"
      return
      ;;
    bash)
      printf '%s\n' "$HOME/.bashrc"
      return
      ;;
  esac

  if [ -f "$HOME/.zshrc" ]; then
    printf '%s\n' "$HOME/.zshrc"
    return
  fi
  if [ -f "$HOME/.bashrc" ]; then
    printf '%s\n' "$HOME/.bashrc"
    return
  fi
  printf '%s\n' "$HOME/.profile"
}

hive_path_expr() {
  if [ "$HIVE_BIN_DIR" = "$HOME/.local/bin" ]; then
    printf '%s\n' '__DEFAULT_HOME_LOCAL_BIN__'
    return
  fi

  case "$HIVE_BIN_DIR" in
    "$HOME"/*)
      printf '\$HOME/%s\n' "${HIVE_BIN_DIR#"$HOME"/}"
      ;;
    *)
      printf '%s\n' "$HIVE_BIN_DIR"
      ;;
  esac
}

hive_path_line() {
  local path_expr
  path_expr="$(hive_path_expr)"
  if [ "$path_expr" = '__DEFAULT_HOME_LOCAL_BIN__' ]; then
    printf '%s\n' 'export PATH="$HOME/.local/bin:$PATH"'
    return
  fi
  printf 'export PATH="%s:$PATH"\n' "$path_expr"
}

hive_path_already_present() {
  case ":$PATH:" in
    *":$HIVE_BIN_DIR:"*)
      return 0
      ;;
    *)
      return 1
      ;;
  esac
}

hive_ensure_profile_path() {
  local profile line
  profile="$(hive_choose_profile)"
  line="$(hive_path_line)"
  HIVE_PROFILE_USED="$profile"

  mkdir -p "$(dirname "$profile")"
  touch "$profile"

  if grep -Fq "$line" "$profile"; then
    return
  fi

  {
    printf '\n# Added by Hive installer\n'
    printf '%s\n' "$line"
  } >> "$profile"
  HIVE_RC_CHANGED=1
}

hive_write_wrapper() {
  local name target wrapper
  name="$1"
  target="$2"
  wrapper="$HIVE_BIN_DIR/$name"

  if [ ! -x "$target" ]; then
    echo "Missing executable: $target" >&2
    exit 1
  fi

  cat > "$wrapper" <<WRAPPER
#!/usr/bin/env bash
# Added by Hive installer. Regenerated on upgrade.
exec "$target" "\$@"
WRAPPER
  chmod +x "$wrapper"
}

register_hive_cli() {
  mkdir -p "$HIVE_BIN_DIR"

  hive_write_wrapper "hive" "$HIVE_INSTALL_DIR/bin/hive"
  hive_write_wrapper "hive-config" "$HIVE_INSTALL_DIR/bin/hive-config"
  hive_ok "Registered CLI shims in $HIVE_BIN_DIR"

  if hive_path_already_present; then
    HIVE_PROFILE_USED="(already in PATH)"
    hive_ok "$HIVE_BIN_DIR already present in PATH"
    return
  fi

  hive_ensure_profile_path
  if [ "$HIVE_RC_CHANGED" -eq 1 ]; then
    hive_ok "Added $HIVE_BIN_DIR to PATH via $HIVE_PROFILE_USED"
    hive_info "Open a new shell or run: source $HIVE_PROFILE_USED"
  else
    hive_ok "PATH entry already configured in $HIVE_PROFILE_USED"
  fi
}

if [ "${BASH_SOURCE[0]}" = "$0" ]; then
  register_hive_cli
fi
