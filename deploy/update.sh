#!/usr/bin/env bash
# Deploy another commit of the public repository (spec deploy-aws). Run as root over SSM:
#
#   sudo /opt/seance/deploy/update.sh <40-character commit sha>
#
# Git runs as root (GitHub is outside the seance user's egress allow-list), then the tree is handed
# to seance, and `pnpm install --frozen-lockfile` and `pnpm build` run as seance with
# /etc/seance/web.env loaded (so the client is built for wss://<host>/ws). The build needs the
# network as seance (npm registry, the font files of next/font), so the ircd and the agents' egress
# rule are stopped for it and started again afterwards. On any failure, including the health check,
# the previous commit is deployed again and the script exits 1.
set -euo pipefail

REPO_DIR=/opt/seance
STATE_DIR=/var/lib/seance
DEPLOY_CONF=/etc/seance/deploy.conf
WEB_ENV_FILE=/etc/seance/web.env
SEANCE_USER=seance
SEANCE_HOME=/home/seance
export PATH=/usr/local/bin:$PATH
HEALTH_TRIES=30

log() { printf '[update %s] %s\n' "$(date -u +%H:%M:%S)" "$*"; }
die() { printf '[update] ERROR: %s\n' "$*" >&2; exit 1; }

[ "$(id -u)" -eq 0 ] || die "run as root (sudo $0 <sha>)"
NEW_REF=${1:-}
[[ $NEW_REF =~ ^[0-9a-f]{40}$ ]] || die "usage: $0 <full 40-character commit sha>"
[ -f "$DEPLOY_CONF" ] || die "$DEPLOY_CONF is missing: run deploy/bootstrap.sh first"
[ -f "$WEB_ENV_FILE" ] || die "$WEB_ENV_FILE is missing: run deploy/bootstrap.sh first"
SEANCE_UID=$(id -u "$SEANCE_USER")

repo_git() { git -c safe.directory="$REPO_DIR" -C "$REPO_DIR" "$@"; }

as_seance() {
  (cd "$SEANCE_HOME" && runuser -u "$SEANCE_USER" -- env -i \
    HOME="$SEANCE_HOME" USER="$SEANCE_USER" LOGNAME="$SEANCE_USER" LANG=C.UTF-8 \
    XDG_RUNTIME_DIR="/run/user/$SEANCE_UID" \
    DBUS_SESSION_BUS_ADDRESS="unix:path=/run/user/$SEANCE_UID/bus" \
    COREPACK_ENABLE_DOWNLOAD_PROMPT=0 \
    PATH="$SEANCE_HOME/.local/bin:/usr/local/bin:/usr/bin:/bin" "$@")
}

PREV_REF=$(repo_git rev-parse HEAD)
if [ "$PREV_REF" = "$NEW_REF" ]; then
  log "already at $NEW_REF"
  exit 0
fi

# The ircd (and its egress rule) is restarted and checked only when it was running before (it
# waits for the Kiro login otherwise).
AGENTS_WERE_ACTIVE=0
systemctl is-active --quiet seance-ircd.service && AGENTS_WERE_ACTIVE=1

deploy() {
  local ref=$1
  log "checking out $ref"
  repo_git fetch --quiet origin "$ref" || return 1
  repo_git -c advice.detachedHead=false checkout --quiet --detach "$ref" || return 1
  [ "$(repo_git rev-parse HEAD)" = "$ref" ] || return 1
  chown -R "$SEANCE_USER:$SEANCE_USER" "$REPO_DIR"
  log "stopping the ircd and the egress rule for the build"
  systemctl stop seance-ircd.service seance-sandbox-nft.service
  log "pnpm install --frozen-lockfile and pnpm build as $SEANCE_USER"
  # shellcheck disable=SC2016 # $1 and $2 expand inside the child shell
  as_seance bash -c 'set -euo pipefail; set -a; . "$1"; set +a; cd "$2"; pnpm install --frozen-lockfile; pnpm build' \
    _ "$WEB_ENV_FILE" "$REPO_DIR" || return 1
  [ -f "$REPO_DIR/apps/web/.next/BUILD_ID" ] || return 1
  install -d -o "$SEANCE_USER" -g "$SEANCE_USER" -m 0700 "$REPO_DIR/apps/web/.next/cache"
  local unit
  for unit in seance-ircd.service seance-web.service seance-sandbox-nft.service \
              seance-egress-refresh.service seance-egress-refresh.timer; do
    install -m 0644 "$REPO_DIR/deploy/systemd/$unit" "/etc/systemd/system/$unit"
  done
  systemctl daemon-reload
  systemctl restart seance-web.service
  if [ "$AGENTS_WERE_ACTIVE" -eq 1 ]; then
    systemctl start seance-sandbox-nft.service
    systemctl start seance-ircd.service
  fi
  echo "$ref" > "$STATE_DIR/built-ref"
}

healthy() {
  local _
  for _ in $(seq 1 "$HEALTH_TRIES"); do
    if curl -fsS -o /dev/null --max-time 5 http://127.0.0.1:3000/ &&
       { [ "$AGENTS_WERE_ACTIVE" -eq 0 ] || curl -fsS -o /dev/null --max-time 5 http://127.0.0.1:6680/healthz; }; then
      return 0
    fi
    sleep 2
  done
  return 1
}

if deploy "$NEW_REF" && healthy; then
  sed -i "s/^SEANCE_GIT_REF=.*/SEANCE_GIT_REF=$NEW_REF/" "$DEPLOY_CONF"
  log "deployed $NEW_REF (was $PREV_REF)"
  exit 0
fi

log "update to $NEW_REF failed; rolling back to $PREV_REF"
if deploy "$PREV_REF" && healthy; then
  log "rolled back to $PREV_REF"
else
  log "rollback to $PREV_REF is not healthy either: check journalctl -u seance-web -u seance-ircd"
fi
exit 1
