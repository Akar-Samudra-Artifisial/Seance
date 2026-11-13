# shellcheck shell=sh
# Helpers for deploy/bootstrap.sh and deploy/update.sh (spec sandbox-api-key-auth, Requirement 15).
# Sourced, not executed: it sets no shell options. POSIX sh only, so the same text can be copied
# into deploy/seance-kiro-refresh.sh (which is /bin/sh); keep the env_value copies identical.
#
#   env_value NAME FILE   print the value of the last "NAME=value" line of FILE
#   sync_refresh_timer    enable or disable seance-kiro-refresh.timer (needs log and ENV_FILE)

# env_value NAME FILE
# Reads FILE line by line and keeps the value of the last line that starts with "NAME=" (a
# commented line cannot match). One pair of surrounding " or ' is removed (so "" and '' become empty). A value with no
# non-whitespace character prints nothing (blank is unset). A missing or unreadable FILE prints
# nothing. Always returns 0 so `v=$(env_value ...)` is safe under `set -e`. Nothing from FILE is
# sourced, evaluated or expanded, and no other line is ever printed.
env_value() {
  ev_name=$1
  ev_file=$2
  ev_val=
  if [ -r "$ev_file" ]; then
    while IFS= read -r ev_line || [ -n "$ev_line" ]; do
      case $ev_line in
        "$ev_name="*) ev_val=${ev_line#"$ev_name="} ;;
      esac
    done < "$ev_file"
  fi
  case $ev_val in
    \"*\") ev_val=${ev_val#\"}; ev_val=${ev_val%\"} ;;
    \'*\') ev_val=${ev_val#\'}; ev_val=${ev_val%\'} ;;
  esac
  case $ev_val in
    *[![:space:]]*) printf '%s\n' "$ev_val" ;;
  esac
  return 0
}

# sync_refresh_timer
# The Kiro login refresh job only makes sense when a login directory is configured. Uses log() and
# ENV_FILE of the caller.
sync_refresh_timer() {
  if [ -n "$(env_value SEANCE_SANDBOX_AUTH_DIR "$ENV_FILE")" ]; then
    systemctl enable --now seance-kiro-refresh.timer
  else
    log "no SEANCE_SANDBOX_AUTH_DIR: the Kiro login refresh timer stays off"
    systemctl disable --now seance-kiro-refresh.timer || true
  fi
}
