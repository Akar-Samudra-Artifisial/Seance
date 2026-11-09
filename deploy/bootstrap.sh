#!/usr/bin/env bash
# Séance server bootstrap for Debian 13 (spec deploy-aws). Run as root; cloud-init runs it once from
# infra/user_data.sh.tftpl, and the operator may run it again at any time over SSM:
#
#   sudo /opt/seance/deploy/bootstrap.sh
#
# Idempotent: every step checks its state first. It installs packages, Node 26 and pnpm 11.7 (via
# corepack), rootless Podman 5 for the seance user, Caddy, kiro-cli, the XFS quota volume, builds the
# pinned commit and the sandbox images as seance, and installs the units. It starts the web client
# and Caddy, but starts the ircd (and with it the agents) only once `kiro-cli whoami` succeeds for
# seance, an account exists and SEANCE_INVITERS is set; until then it prints the next step.
set -euo pipefail

# ---- pinned versions (downloads with a checksum are pinned in deploy/pins.env) --------------
NODE_VERSION=26.7.0
PNPM_VERSION=11.7.0
COREPACK_VERSION=0.34.6

# ---- paths -----------------------------------------------------------------------------------
REPO_DIR=/opt/seance
CONF_DIR=/etc/seance
STATE_DIR=/var/lib/seance
DEPLOY_CONF=$CONF_DIR/deploy.conf
ENV_FILE=$CONF_DIR/seance.env
WEB_ENV_FILE=$CONF_DIR/web.env
ACCOUNTS_FILE=$CONF_DIR/accounts
WORKSPACES=/srv/seance/workspaces
TARGET_REPO=/srv/seance/target
SEANCE_USER=seance
SEANCE_HOME=/home/seance
AUTH_DIR=$SEANCE_HOME/.local/share/kiro-cli
NODE_DIR=/usr/local/lib/nodejs/node-v$NODE_VERSION-linux-x64
export DEBIAN_FRONTEND=noninteractive
export PATH=/usr/local/bin:$PATH
APT=(apt-get -o DPkg::Lock::Timeout=120)
# XFS project for SEANCE_WORKSPACES.
WS_PROJECT_ID=4201
WS_PROJECT_NAME=seance_ws

log() { printf '[bootstrap %s] %s\n' "$(date -u +%H:%M:%S)" "$*"; }
die() { printf '[bootstrap] ERROR: %s\n' "$*" >&2; exit 1; }

[ "$(id -u)" -eq 0 ] || die "run as root (sudo $0)"

# ---- configuration: from cloud-init on the first run, from deploy.conf afterwards ------------
mkdir -p "$CONF_DIR" "$STATE_DIR"
chmod 0755 "$CONF_DIR"
chmod 0700 "$STATE_DIR"
if [ -f "$DEPLOY_CONF" ]; then
  # shellcheck source=/dev/null
  . "$DEPLOY_CONF"
fi
: "${SEANCE_REPO_URL:?SEANCE_REPO_URL is not set (cloud-init passes it; see infra/user_data.sh.tftpl)}"
: "${SEANCE_GIT_REF:?SEANCE_GIT_REF is not set}"
: "${SEANCE_PUBLIC_HOSTNAME:?SEANCE_PUBLIC_HOSTNAME is not set}"
: "${SEANCE_WORKSPACES_VOLUME_ID:?SEANCE_WORKSPACES_VOLUME_ID is not set}"
: "${SEANCE_VPC_CIDR:?SEANCE_VPC_CIDR is not set}"
[[ $SEANCE_REPO_URL =~ ^https://[A-Za-z0-9._/-]+$ ]] || die "SEANCE_REPO_URL must match ^https://[A-Za-z0-9._/-]+$"
[[ $SEANCE_GIT_REF =~ ^[0-9a-f]{40}$ ]] || die "SEANCE_GIT_REF must be a full commit sha"
[[ $SEANCE_PUBLIC_HOSTNAME =~ ^[0-9]+-[0-9]+-[0-9]+-[0-9]+\.sslip\.io$ ]] || die "unexpected hostname $SEANCE_PUBLIC_HOSTNAME"
[[ $SEANCE_WORKSPACES_VOLUME_ID =~ ^vol-[0-9a-f]+$ ]] || die "unexpected volume id $SEANCE_WORKSPACES_VOLUME_ID"
[[ $SEANCE_VPC_CIDR =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+/[0-9]+$ ]] || die "unexpected VPC CIDR $SEANCE_VPC_CIDR"
umask 077
# %q quotes every value, so sourcing the file can never run a command.
{
  printf 'SEANCE_REPO_URL=%q\n' "$SEANCE_REPO_URL"
  printf 'SEANCE_GIT_REF=%q\n' "$SEANCE_GIT_REF"
  printf 'SEANCE_PUBLIC_HOSTNAME=%q\n' "$SEANCE_PUBLIC_HOSTNAME"
  printf 'SEANCE_WORKSPACES_VOLUME_ID=%q\n' "$SEANCE_WORKSPACES_VOLUME_ID"
  printf 'SEANCE_VPC_CIDR=%q\n' "$SEANCE_VPC_CIDR"
} > "$DEPLOY_CONF"
umask 022

# ---- 1. packages -----------------------------------------------------------------------------
missing_packages() {
  local p
  for p in "$@"; do
    dpkg-query -W -f='${Status}' "$p" 2>/dev/null | grep -q 'install ok installed' || printf '%s\n' "$p"
  done
}

install_packages() {
  local base=(ca-certificates curl git unzip xz-utils python3 openssl acl xfsprogs nftables caddy
    unattended-upgrades apt-listchanges)
  # Podman with its recommends, and the runtime pieces rootless mode needs listed explicitly.
  local container=(podman netavark aardvark-dns catatonit passt uidmap fuse-overlayfs crun
    containers-storage dbus-user-session)
  local missing=()
  mapfile -t missing < <(missing_packages "${base[@]}")
  if [ "${#missing[@]}" -gt 0 ]; then
    log "installing packages: ${missing[*]}"
    "${APT[@]}" update
    "${APT[@]}" install -y --no-install-recommends "${missing[@]}"
  fi
  mapfile -t missing < <(missing_packages "${container[@]}")
  if [ "${#missing[@]}" -gt 0 ]; then
    log "installing container packages (with recommends): ${missing[*]}"
    "${APT[@]}" update
    "${APT[@]}" install -y "${missing[@]}"
  fi
  # Security updates every day (Debian's unattended-upgrades default origin is the security suite).
  cat > /etc/apt/apt.conf.d/20auto-upgrades <<'EOF'
APT::Periodic::Update-Package-Lists "1";
APT::Periodic::Unattended-Upgrade "1";
EOF
  systemctl enable --now unattended-upgrades.service >/dev/null 2>&1 || true
  install -d -o caddy -g caddy -m 0755 /var/log/caddy
  local version
  version=$(podman version --format '{{.Client.Version}}')
  [ "${version%%.*}" -ge 5 ] || die "Podman $version is older than 5 (Debian 13 ships 5.x)"
  log "podman $version"
}

# ---- 2. the seance user and rootless Podman --------------------------------------------------
SEANCE_UID=""
setup_user() {
  if ! id "$SEANCE_USER" >/dev/null 2>&1; then
    log "creating user $SEANCE_USER"
    useradd --create-home --home-dir "$SEANCE_HOME" --shell /bin/bash --user-group "$SEANCE_USER"
  fi
  SEANCE_UID=$(id -u "$SEANCE_USER")
  grep -q "^$SEANCE_USER:" /etc/subuid || usermod --add-subuids 200000-265535 "$SEANCE_USER"
  grep -q "^$SEANCE_USER:" /etc/subgid || usermod --add-subgids 200000-265535 "$SEANCE_USER"
  # Delegate the cgroup controllers the runner's --memory/--cpus/--pids-limit need.
  mkdir -p /etc/systemd/system/user@.service.d
  cat > /etc/systemd/system/user@.service.d/seance-delegate.conf <<'EOF'
[Service]
Delegate=cpu cpuset io memory pids
EOF
  # seance-ircd talks to the user manager (cgroups, user bus): order it after user@<uid>.service.
  mkdir -p /etc/systemd/system/seance-ircd.service.d
  cat > /etc/systemd/system/seance-ircd.service.d/user-manager.conf <<EOF
# Rendered by deploy/bootstrap.sh: the uid of $SEANCE_USER is only known on the host.
[Unit]
After=user@$SEANCE_UID.service
Wants=user@$SEANCE_UID.service

[Service]
ReadWritePaths=/run/user/$SEANCE_UID
EOF
  systemctl daemon-reload
  loginctl enable-linger "$SEANCE_USER"
  systemctl start "user@$SEANCE_UID.service"
  local i
  for i in $(seq 1 30); do
    [ -S "/run/user/$SEANCE_UID/bus" ] && break
    [ "$i" -eq 30 ] && die "the user bus of $SEANCE_USER did not appear"
    sleep 1
  done
  install -d -o "$SEANCE_USER" -g "$SEANCE_USER" -m 0700 "$SEANCE_HOME/.config" "$SEANCE_HOME/.config/containers"
  install -d -o "$SEANCE_USER" -g "$SEANCE_USER" -m 0700 "$SEANCE_HOME/.local" "$SEANCE_HOME/.local/share"
  cat > "$SEANCE_HOME/.config/containers/containers.conf" <<'EOF'
[engine]
cgroup_manager = "systemd"
events_logger = "file"
EOF
  chown "$SEANCE_USER:$SEANCE_USER" "$SEANCE_HOME/.config/containers/containers.conf"
}

# Runs a command as seance with a clean environment (nothing of root's leaks in).
as_seance() {
  (cd "$SEANCE_HOME" && runuser -u "$SEANCE_USER" -- env -i \
    HOME="$SEANCE_HOME" USER="$SEANCE_USER" LOGNAME="$SEANCE_USER" LANG=C.UTF-8 \
    XDG_RUNTIME_DIR="/run/user/$SEANCE_UID" \
    DBUS_SESSION_BUS_ADDRESS="unix:path=/run/user/$SEANCE_UID/bus" \
    COREPACK_ENABLE_DOWNLOAD_PROMPT=0 \
    PATH="$SEANCE_HOME/.local/bin:/usr/local/bin:/usr/bin:/bin" "$@")
}

# The agents' egress rule limits seance to the agents' allow-list (no GitHub, no font CDN, no
# image registry). Network work as seance therefore runs with the rule (and so the ircd) stopped;
# the gate at the end starts both again.
NETWORK_PAUSED=0
need_seance_network() {
  [ "$NETWORK_PAUSED" -eq 1 ] && return
  if systemctl is-active --quiet seance-sandbox-nft.service; then
    log "stopping the ircd and the egress rule for downloads as $SEANCE_USER"
    systemctl stop seance-ircd.service seance-sandbox-nft.service
  fi
  NETWORK_PAUSED=1
}

# ---- 3. Node 26 and pnpm 11.7 via corepack ---------------------------------------------------
install_node() {
  if [ ! -x "$NODE_DIR/bin/node" ]; then
    log "installing Node $NODE_VERSION"
    local tmp file expected
    tmp=$(mktemp -d)
    file=node-v$NODE_VERSION-linux-x64.tar.xz
    curl -fsSLo "$tmp/SHASUMS256.txt" "https://nodejs.org/dist/v$NODE_VERSION/SHASUMS256.txt"
    curl -fsSLo "$tmp/$file" "https://nodejs.org/dist/v$NODE_VERSION/$file"
    expected=$(awk -v f="$file" '$2 == f { print $1 }' "$tmp/SHASUMS256.txt")
    [ -n "$expected" ] || die "no checksum for $file"
    echo "$expected  $tmp/$file" | sha256sum -c -
    mkdir -p /usr/local/lib/nodejs
    tar -xJf "$tmp/$file" -C /usr/local/lib/nodejs
    rm -rf "$tmp"
  fi
  ln -sf "$NODE_DIR/bin/node" /usr/local/bin/node
  ln -sf "$NODE_DIR/bin/npm" /usr/local/bin/npm
  ln -sf "$NODE_DIR/bin/npx" /usr/local/bin/npx
  # Node 25 and later no longer bundle corepack; install the pinned version once.
  if [ ! -x "$NODE_DIR/bin/corepack" ]; then
    log "installing corepack $COREPACK_VERSION"
    "$NODE_DIR/bin/npm" install --global --no-fund --no-audit "corepack@$COREPACK_VERSION"
  fi
  ln -sf "$NODE_DIR/bin/corepack" /usr/local/bin/corepack
  corepack enable --install-directory /usr/local/bin pnpm
  [ "$(node --version)" = "v$NODE_VERSION" ] || die "node --version is not v$NODE_VERSION"
  # pnpm runs as seance; its corepack cache is seance's own (~/.cache/node/corepack).
  if ! as_seance corepack pnpm@"$PNPM_VERSION" --version >/dev/null 2>&1; then
    need_seance_network
    as_seance corepack install --global "pnpm@$PNPM_VERSION"
  fi
  # shellcheck disable=SC2016 # $1 expands inside the child shell
  log "node $(node --version), pnpm $(as_seance bash -c 'cd "$1" && pnpm --version' _ "$REPO_DIR")"
}

# ---- 4. kiro-cli for the seance user (installer pinned by sha256 in deploy/pins.env) ---------
KIRO_BIN=""
install_kiro() {
  # shellcheck source=/dev/null # deploy/pins.env of the checked-out commit
  . "$REPO_DIR/deploy/pins.env"
  : "${KIRO_INSTALLER_URL:?KIRO_INSTALLER_URL missing in deploy/pins.env}"
  [[ ${KIRO_INSTALLER_SHA256:-} =~ ^[0-9a-f]{64}$ ]] || die "KIRO_INSTALLER_SHA256 in deploy/pins.env is missing or not a sha256"
  if ! as_seance bash -c 'command -v kiro-cli' >/dev/null 2>&1; then
    log "installing kiro-cli for $SEANCE_USER"
    need_seance_network
    local installer=$STATE_DIR/kiro-install.sh
    curl -fsSLo "$installer" "$KIRO_INSTALLER_URL"
    # Fail closed: an installer that differs from the pin never runs (see deploy/pins.env).
    echo "$KIRO_INSTALLER_SHA256  $installer" | sha256sum -c - ||
      die "the Kiro installer does not match KIRO_INSTALLER_SHA256 (update deploy/pins.env after reading the new script)"
    install -o "$SEANCE_USER" -g "$SEANCE_USER" -m 0500 "$installer" "$SEANCE_HOME/kiro-install.sh"
    as_seance bash "$SEANCE_HOME/kiro-install.sh" --no-modify-path </dev/null
    rm -f "$SEANCE_HOME/kiro-install.sh" "$installer"
  fi
  KIRO_BIN=$(readlink -f "$(as_seance bash -c 'command -v kiro-cli')")
  [ -x "$KIRO_BIN" ] || die "kiro-cli not found after install"
  log "kiro-cli $(as_seance kiro-cli --version 2>/dev/null | head -n1 || echo '(version unknown)')"
}

# ---- 5. the workspaces volume: XFS with a hard project quota ---------------------------------
setup_volume() {
  local dev=/dev/disk/by-id/nvme-Amazon_Elastic_Block_Store_${SEANCE_WORKSPACES_VOLUME_ID//-/}
  local i
  for i in $(seq 1 60); do
    [ -e "$dev" ] && break
    [ "$i" -eq 60 ] && die "volume $SEANCE_WORKSPACES_VOLUME_ID did not appear at $dev"
    log "waiting for $SEANCE_WORKSPACES_VOLUME_ID"
    sleep 5
  done
  if ! blkid -o value -s TYPE "$dev" >/dev/null 2>&1; then
    log "formatting $dev as XFS"
    mkfs.xfs -L seance-ws "$dev"
  fi
  [ "$(blkid -o value -s TYPE "$dev")" = "xfs" ] || die "$dev is not XFS"
  local uuid
  uuid=$(blkid -o value -s UUID "$dev")
  mkdir -p "$WORKSPACES"
  if ! grep -q "UUID=$uuid" /etc/fstab; then
    echo "UUID=$uuid $WORKSPACES xfs defaults,nofail,prjquota,x-systemd.device-timeout=60s 0 2" >> /etc/fstab
    systemctl daemon-reload
  fi
  mountpoint -q "$WORKSPACES" || mount "$WORKSPACES"
  findmnt -no OPTIONS "$WORKSPACES" | grep -q prjquota || die "$WORKSPACES is mounted without prjquota"
  grep -q "^$WS_PROJECT_ID:" /etc/projects 2>/dev/null || echo "$WS_PROJECT_ID:$WORKSPACES" >> /etc/projects
  grep -q "^$WS_PROJECT_NAME:" /etc/projid 2>/dev/null || echo "$WS_PROJECT_NAME:$WS_PROJECT_ID" >> /etc/projid
  # Hard limit 2 GiB below the volume size, so the filesystem itself never fills up.
  local size_g quota_g
  size_g=$(( $(blockdev --getsize64 "$dev") / 1024 / 1024 / 1024 ))
  quota_g=$(( size_g > 4 ? size_g - 2 : size_g - 1 ))
  xfs_quota -x -c "project -s $WS_PROJECT_NAME" "$WORKSPACES" >/dev/null
  xfs_quota -x -c "limit -p bhard=${quota_g}g $WS_PROJECT_NAME" "$WORKSPACES"
  chown "$SEANCE_USER:$SEANCE_USER" "$WORKSPACES"
  chmod 0750 "$WORKSPACES"
  log "workspaces: $WORKSPACES, XFS project quota ${quota_g} GiB"
}

# ---- 6. the repository at the pinned commit, owned by seance ---------------------------------
# Git runs as root (GitHub is outside seance's egress allow-list once the rule is loaded); the
# tree is handed to seance afterwards, and install and build run as seance.
repo_git() { git -c safe.directory="$REPO_DIR" -C "$REPO_DIR" "$@"; }

checkout_repo() {
  if [ ! -d "$REPO_DIR/.git" ]; then
    git clone --no-checkout "$SEANCE_REPO_URL" "$REPO_DIR"
  fi
  if [ "$(repo_git rev-parse HEAD 2>/dev/null || true)" != "$SEANCE_GIT_REF" ]; then
    repo_git fetch --quiet origin "$SEANCE_GIT_REF"
    repo_git -c advice.detachedHead=false checkout --quiet --detach "$SEANCE_GIT_REF"
  fi
  [ "$(repo_git rev-parse HEAD)" = "$SEANCE_GIT_REF" ] || die "checkout of $SEANCE_GIT_REF failed"
  chown -R "$SEANCE_USER:$SEANCE_USER" "$REPO_DIR"
}

# web.env exists before the build, so the client is built for wss://<host>/ws and never for the
# ws://127.0.0.1:6680 default.
write_web_env() {
  printf 'NEXT_PUBLIC_IRCD_WS_URL=wss://%s/ws\nNEXT_TELEMETRY_DISABLED=1\n' "$SEANCE_PUBLIC_HOSTNAME" > "$WEB_ENV_FILE"
  chmod 0644 "$WEB_ENV_FILE"
}

build_repo() {
  local web_url_built
  web_url_built=$(cat "$STATE_DIR/built-web-url" 2>/dev/null || true)
  if [ "$(cat "$STATE_DIR/built-ref" 2>/dev/null || true)" != "$SEANCE_GIT_REF" ] ||
     [ "$web_url_built" != "wss://$SEANCE_PUBLIC_HOSTNAME/ws" ] ||
     [ ! -f "$REPO_DIR/apps/web/.next/BUILD_ID" ]; then
    log "pnpm install and build at $SEANCE_GIT_REF as $SEANCE_USER"
    need_seance_network
    # shellcheck disable=SC2016 # $1 and $2 expand inside the child shell
    as_seance bash -c 'set -euo pipefail; set -a; . "$1"; set +a; cd "$2"; pnpm install --frozen-lockfile; pnpm build' \
      _ "$WEB_ENV_FILE" "$REPO_DIR"
    echo "$SEANCE_GIT_REF" > "$STATE_DIR/built-ref"
    echo "wss://$SEANCE_PUBLIC_HOSTNAME/ws" > "$STATE_DIR/built-web-url"
  fi
  [ -f "$REPO_DIR/apps/web/.next/BUILD_ID" ] || die "the web build has no BUILD_ID"
  install -d -o "$SEANCE_USER" -g "$SEANCE_USER" -m 0700 "$REPO_DIR/apps/web/.next/cache"
}

# ---- 7. the demo target repository -----------------------------------------------------------
make_target() {
  if [ ! -d "$TARGET_REPO/.git" ]; then
    log "creating the demo target repository $TARGET_REPO"
    python3 "$REPO_DIR/scripts/demo-journey.py" --make-target "$TARGET_REPO"
  fi
  chown -R "$SEANCE_USER:$SEANCE_USER" "$TARGET_REPO"
}

# ---- 8. sandbox images (pinned base images pulled by digest; agent image built locally) ------
SANDBOX_IMAGE=""
build_images() {
  local base bases=()
  mapfile -t bases < <(grep -h '^FROM ' "$REPO_DIR/sandbox/Dockerfile" "$REPO_DIR/apps/runner/test/fixtures/sandbox/Dockerfile" | awk '{ print $2 }' | sort -u)
  [ "${#bases[@]}" -gt 0 ] || die "no FROM line in the sandbox Dockerfiles"
  for base in "${bases[@]}"; do
    [[ $base == *@sha256:* ]] || die "base image $base is not pinned by digest"
    if ! as_seance podman image exists "$base"; then
      log "pulling $base"
      need_seance_network
      as_seance podman pull --quiet "$base" >/dev/null
    fi
  done
  local current
  current=$(sed -n 's/^SEANCE_SANDBOX_IMAGE=//p' "$ENV_FILE" 2>/dev/null || true)
  if [[ $current == localhost/seance-agent@sha256:* ]] && as_seance podman image exists "$current"; then
    SANDBOX_IMAGE=$current
    return
  fi
  log "building the agent image with $KIRO_BIN"
  need_seance_network
  local ctx=$SEANCE_HOME/sandbox-build
  rm -rf "$ctx"
  install -d -o "$SEANCE_USER" -g "$SEANCE_USER" -m 0700 "$ctx"
  cp "$REPO_DIR/sandbox/"* "$ctx/"
  cp "$KIRO_BIN" "$ctx/kiro-cli"
  chown -R "$SEANCE_USER:$SEANCE_USER" "$ctx"
  local sha
  sha=$(sha256sum "$ctx/kiro-cli" | cut -d' ' -f1)
  as_seance podman build --pull=never --quiet --build-arg "KIRO_CLI_SHA256=$sha" \
    -t localhost/seance-agent:build -f "$ctx/Dockerfile" "$ctx" >/dev/null
  local digest
  digest=$(as_seance podman image inspect --format '{{.Digest}}' localhost/seance-agent:build)
  [[ $digest == sha256:* ]] || die "no digest for localhost/seance-agent:build"
  SANDBOX_IMAGE=localhost/seance-agent@$digest
  rm -rf "$ctx"
  log "agent image $SANDBOX_IMAGE"
}

# ---- 9. configuration files ------------------------------------------------------------------
write_config() {
  if [ ! -f "$ENV_FILE" ]; then
    log "writing $ENV_FILE"
    local password
    password=$(openssl rand -base64 48 | tr -dc 'A-Za-z0-9' | head -c 32)
    [ "${#password}" -ge 20 ] || die "could not generate a server password"
    umask 077
    sed -e "s|@SEANCE_PUBLIC_HOSTNAME@|$SEANCE_PUBLIC_HOSTNAME|g" \
        -e "s|@GENERATED_SERVER_PASSWORD@|$password|" \
        -e "s|@VPC_CIDR@|$SEANCE_VPC_CIDR|" \
        -e "s|@SEANCE_UID@|$SEANCE_UID|" \
        -e "s|@SANDBOX_IMAGE_DIGEST_REF@|$SANDBOX_IMAGE|" \
        "$REPO_DIR/deploy/seance.env.example" > "$ENV_FILE"
    echo "DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/$SEANCE_UID/bus" >> "$ENV_FILE"
    umask 022
  else
    # Keep every operator edit; only the agent image follows a rebuild.
    sed -i "s|^SEANCE_SANDBOX_IMAGE=.*|SEANCE_SANDBOX_IMAGE=$SANDBOX_IMAGE|" "$ENV_FILE"
  fi
  chown root:root "$ENV_FILE"
  chmod 0600 "$ENV_FILE"
  if [ ! -f "$ACCOUNTS_FILE" ]; then
    printf '# One line per judge: node /opt/seance/tools/seance-account.mjs <nick> (secret on stdin)\n' > "$ACCOUNTS_FILE"
  fi
  chown "$SEANCE_USER:$SEANCE_USER" "$ACCOUNTS_FILE"
  chmod 0600 "$ACCOUNTS_FILE"
  # The agents' egress rule (sandbox/seance-sandbox.nft); the resolver is the VPC base + 2.
  local net a b c d
  net=${SEANCE_VPC_CIDR%/*}
  IFS=. read -r a b c d <<< "$net"
  mkdir -p /etc/nftables.d
  sed -e "s/@RUNNER_USER@/$SEANCE_USER/" \
      -e "s|@VPC_CIDR@|$SEANCE_VPC_CIDR|" \
      -e "s/@RESOLVER@/$a.$b.$c.$((d + 2))/" \
      "$REPO_DIR/sandbox/seance-sandbox.nft" > /etc/nftables.d/seance-sandbox.nft
  sed -e "s|@SEANCE_PUBLIC_HOSTNAME@|$SEANCE_PUBLIC_HOSTNAME|g" "$REPO_DIR/deploy/Caddyfile" > /etc/caddy/Caddyfile
}

# ---- 10. units ---------------------------------------------------------------------------------
install_units() {
  local unit
  for unit in seance-ircd.service seance-web.service seance-sandbox-nft.service \
              seance-egress-refresh.service seance-egress-refresh.timer \
              seance-kiro-refresh.service seance-kiro-refresh.timer; do
    install -m 0644 "$REPO_DIR/deploy/systemd/$unit" "/etc/systemd/system/$unit"
  done
  # Runs as seance (User= in the unit) but is owned by root, so the agents' user cannot edit it.
  install -m 0755 -o root -g root "$REPO_DIR/deploy/seance-kiro-refresh.sh" /usr/local/sbin/seance-kiro-refresh
  systemctl daemon-reload
  systemctl enable seance-web.service
  systemctl restart seance-web.service
  systemctl enable caddy.service
  systemctl reload-or-restart caddy.service
}

# ---- 11. the gate: agents only with a working Kiro login, an account and SEANCE_INVITERS ------
ready_for_agents() {
  local blocked=0
  if [ -d "$AUTH_DIR" ]; then
    # -h: never follow a symlink inside the seance-owned directory, so it cannot redirect root.
    chown -hR "$SEANCE_USER:$SEANCE_USER" "$AUTH_DIR"
    chmod 0700 "$AUTH_DIR"
  fi
  # The egress rule is stopped at this point (or was never loaded), so whoami can reach Kiro.
  if ! as_seance kiro-cli whoami >/dev/null 2>&1; then
    blocked=1
    cat <<EOF

NEXT STEP: log in to Kiro once as $SEANCE_USER (docs/DEPLOY.md, "Kiro login"):
  sudo systemctl stop seance-ircd.service seance-sandbox-nft.service
  sudo -iu $SEANCE_USER kiro-cli login --use-device-flow
  sudo -iu $SEANCE_USER kiro-cli whoami
Then run this script again (it loads the egress rule and starts the ircd).
EOF
  fi
  if ! grep -qv '^[[:space:]]*\(#\|$\)' "$ACCOUNTS_FILE"; then
    blocked=1
    cat <<EOF

NEXT STEP: add at least one judge account (docs/DEPLOY.md, "Accounts"):
  node $REPO_DIR/tools/seance-account.mjs <nick> | sudo -u $SEANCE_USER tee -a $ACCOUNTS_FILE
EOF
  fi
  if grep -q '^SEANCE_INVITERS=@SET_ME' "$ENV_FILE"; then
    blocked=1
    cat <<EOF

NEXT STEP: list the account nicks that may invite agents:
  sudo sed -i 's/^SEANCE_INVITERS=.*/SEANCE_INVITERS=<nick1,nick2>/' $ENV_FILE
EOF
  fi
  return "$blocked"
}

main() {
  install_packages
  setup_user
  setup_volume
  checkout_repo
  install_node
  write_web_env
  build_repo
  install_kiro
  make_target
  build_images
  write_config
  install_units
  if systemctl is-active --quiet seance-sandbox-nft.service; then
    # Nothing needed the network and the agents are running: leave them alone.
    systemctl enable --now seance-kiro-refresh.timer
    log "done: https://$SEANCE_PUBLIC_HOSTNAME/ (agents running, unchanged)"
  elif ready_for_agents; then
    log "starting the egress rule and the ircd"
    systemctl enable --now seance-sandbox-nft.service seance-egress-refresh.timer seance-kiro-refresh.timer
    systemctl enable seance-ircd.service
    systemctl restart seance-ircd.service
    log "done: https://$SEANCE_PUBLIC_HOSTNAME/ (agents enabled)"
  else
    log "done: https://$SEANCE_PUBLIC_HOSTNAME/ serves the web client; the ircd waits for the steps above"
  fi
}

main "$@"
