#!/usr/bin/env bash
# Spike S12 on the EC2 instance (spec deploy-aws task 1, agent-sandbox task 0.4). Run as root over
# SSM, after bootstrap.sh has installed the packages, the repository and the images:
#
#   sudo /opt/seance/deploy/spike-s12.sh              # checks 1 to 5, no Kiro prompt
#   sudo /opt/seance/deploy/spike-s12.sh --with-auth  # also s12-auth (one prompt, needs the login)
#
# Prints a pass/fail table and exits non-zero when any check fails. Results and logs go to
# /var/lib/seance/s12/; copy them into spikes/acp/FINDINGS.md section S12.
#
# Order matters: the base images are pulled and the fixture image is built while the egress rule is
# off (they need the network as seance), then the rule (seance-sandbox-nft.service) is loaded before
# the integration suite, because the runner's start-up probe fails when 1.1.1.1:443 is reachable.
set -euo pipefail

REPO_DIR=/opt/seance
SEANCE_USER=seance
SEANCE_HOME=/home/seance
WORKSPACES=/srv/seance/workspaces
OUT=/var/lib/seance/s12
RUN_DIR=$SEANCE_HOME/s12-run
PROBE_PROJECT_ID=4299
WITH_AUTH=0
[ "${1:-}" = "--with-auth" ] && WITH_AUTH=1

[ "$(id -u)" -eq 0 ] || { echo "run as root (sudo $0)" >&2; exit 2; }
id "$SEANCE_USER" >/dev/null 2>&1 || { echo "user $SEANCE_USER missing: run deploy/bootstrap.sh first" >&2; exit 2; }
SEANCE_UID=$(id -u "$SEANCE_USER")
mkdir -p "$OUT"
chmod 0700 "$OUT"

as_seance() {
  (cd "$SEANCE_HOME" && runuser -u "$SEANCE_USER" -- env -i \
    HOME="$SEANCE_HOME" USER="$SEANCE_USER" LOGNAME="$SEANCE_USER" LANG=C.UTF-8 \
    XDG_RUNTIME_DIR="/run/user/$SEANCE_UID" \
    DBUS_SESSION_BUS_ADDRESS="unix:path=/run/user/$SEANCE_UID/bus" \
    PATH="$SEANCE_HOME/.local/bin:/usr/local/bin:/usr/bin:/bin" "$@")
}

# Pulls and the fixture build need seance's network, which the egress rule limits: stop the ircd
# and the rule first (check 3 loads the rule again), and start the ircd again at the end.
IRCD_WAS_ACTIVE=0
systemctl is-active --quiet seance-ircd.service && IRCD_WAS_ACTIVE=1
systemctl stop seance-ircd.service seance-sandbox-nft.service 2>/dev/null || true

declare -a NAMES=() RESULTS=() DETAILS=()
record() { NAMES+=("$1"); RESULTS+=("$2"); DETAILS+=("$3"); }

# ---- 1. rootless Podman 5 with the cgroup controllers the runner needs ------------------------
check_podman() {
  local version rootless controllers
  version=$(as_seance podman version --format '{{.Client.Version}}' 2>/dev/null || echo "")
  rootless=$(as_seance podman info --format '{{.Host.Security.Rootless}}' 2>/dev/null || echo "")
  controllers=$(as_seance podman info --format '{{.Host.CgroupControllers}}' 2>/dev/null || echo "")
  if [ -z "$version" ]; then
    record "rootless Podman 5" FAIL "podman not usable as $SEANCE_USER"
  elif [ "${version%%.*}" -lt 5 ]; then
    record "rootless Podman 5" FAIL "version $version"
  elif [ "$rootless" != "true" ]; then
    record "rootless Podman 5" FAIL "not rootless ($rootless)"
  elif ! { [[ $controllers == *memory* ]] && [[ $controllers == *pids* ]] && [[ $controllers == *cpu* ]]; }; then
    record "rootless Podman 5" FAIL "cgroup controllers: $controllers"
  else
    record "rootless Podman 5" PASS "$version, rootless, controllers $controllers"
  fi
}

# ---- 2. the pinned base images (pulled before the egress rule is loaded) -----------------------
check_images() {
  local base bases=() missing=()
  mapfile -t bases < <(grep -h '^FROM ' "$REPO_DIR/sandbox/Dockerfile" "$REPO_DIR/apps/runner/test/fixtures/sandbox/Dockerfile" | awk '{ print $2 }' | sort -u)
  [ "${#bases[@]}" -gt 0 ] || missing+=("no FROM line found")
  for base in "${bases[@]}"; do
    if [[ $base != *@sha256:* ]]; then
      missing+=("$base (not pinned)")
    elif ! as_seance podman image exists "$base"; then
      as_seance podman pull --quiet "$base" >/dev/null 2>&1 || missing+=("$base")
    fi
  done
  if [ "${#missing[@]}" -eq 0 ]; then
    record "pinned base images" PASS "present by digest"
  else
    record "pinned base images" FAIL "missing: ${missing[*]}"
  fi
}

# ---- 3. the real-Podman integration suite passes, nothing skipped ------------------------------
check_integration() {
  rm -rf "$RUN_DIR"
  cp -a "$REPO_DIR" "$RUN_DIR"
  chown -R "$SEANCE_USER:$SEANCE_USER" "$RUN_DIR"
  # The fixture image's RUN steps need the network, which the egress rule takes away from seance:
  # build it now, with the same tag, file and context as the suite, so the suite's own build is
  # served from the layer cache.
  if ! (cd "$RUN_DIR" && runuser -u "$SEANCE_USER" -- env -i HOME="$SEANCE_HOME" LANG=C.UTF-8 \
      XDG_RUNTIME_DIR="/run/user/$SEANCE_UID" \
      DBUS_SESSION_BUS_ADDRESS="unix:path=/run/user/$SEANCE_UID/bus" \
      PATH="/usr/local/bin:/usr/bin:/bin" \
      podman build --pull=never -q -t localhost/seance-agent-test:build \
        -f apps/runner/test/fixtures/sandbox/Dockerfile .) > "$OUT/fixture-build.log" 2>&1; then
    record "sandbox.integration.test.ts" FAIL "fixture image build failed, see $OUT/fixture-build.log"
    return
  fi
  systemctl start seance-sandbox-nft.service || { record "sandbox.integration.test.ts" FAIL "egress rule did not load"; return; }
  local json=$RUN_DIR/s12-integration.json
  local code=0
  (cd "$RUN_DIR/apps/ircd" && runuser -u "$SEANCE_USER" -- env HOME="$SEANCE_HOME" \
      XDG_RUNTIME_DIR="/run/user/$SEANCE_UID" \
      DBUS_SESSION_BUS_ADDRESS="unix:path=/run/user/$SEANCE_UID/bus" \
      PATH="/usr/local/bin:/usr/bin:/bin" LANG=C.UTF-8 \
      ./node_modules/.bin/vitest run test/runner/sandbox.integration.test.ts \
        --reporter=json --outputFile="$json") > "$OUT/integration.log" 2>&1 || code=$?
  if [ ! -f "$json" ]; then
    record "sandbox.integration.test.ts" FAIL "no report (exit $code), see $OUT/integration.log"
    return
  fi
  cp "$json" "$OUT/integration.json"
  local summary
  # shellcheck disable=SC2016 # a JavaScript template literal, not a shell expansion
  summary=$(node -e '
    const r = JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8"));
    const ok = r.numPassedTests > 0 && r.numFailedTests === 0 && r.numPendingTests === 0 && r.numTodoTests === 0;
    console.log(`${ok ? "PASS" : "FAIL"} passed ${r.numPassedTests}, failed ${r.numFailedTests}, skipped ${r.numPendingTests}`);
  ' "$json")
  record "sandbox.integration.test.ts" "${summary%% *}" "${summary#* }"
}

# ---- 4. writes past the XFS project quota fail ------------------------------------------------
check_quota() {
  local report probe
  report=$(xfs_quota -x -c 'report -p -n -b' "$WORKSPACES" 2>/dev/null || true)
  if ! printf '%s\n' "$report" | grep -Eq '^#4201[[:space:]]+[0-9]+[[:space:]]+[0-9]+[[:space:]]+[1-9]'; then
    record "XFS project quota" FAIL "no hard limit for project 4201 on $WORKSPACES"
    return
  fi
  probe=$WORKSPACES/.s12-quota-probe
  rm -rf "$probe"
  install -d -o "$SEANCE_USER" -g "$SEANCE_USER" "$probe"
  xfs_quota -x -c "project -s -p $probe $PROBE_PROJECT_ID" "$WORKSPACES" >/dev/null
  xfs_quota -x -c "limit -p bhard=10m $PROBE_PROJECT_ID" "$WORKSPACES"
  local wrote=0
  if as_seance dd if=/dev/zero of="$probe/fill" bs=1M count=20 conv=fsync status=none 2> "$OUT/quota.log"; then
    wrote=1
  fi
  local size
  size=$(stat -c %s "$probe/fill" 2>/dev/null || echo 0)
  xfs_quota -x -c "limit -p bhard=0 $PROBE_PROJECT_ID" "$WORKSPACES"
  rm -rf "$probe"
  if [ "$wrote" -eq 0 ] && [ "$size" -le $((11 * 1024 * 1024)) ]; then
    record "XFS project quota" PASS "20 MiB write into a 10 MiB project failed at $size bytes; main project 4201 has a hard limit"
  else
    record "XFS project quota" FAIL "the write past the quota succeeded ($size bytes)"
  fi
}

# ---- 5. spike s12: the pinned podman flag spellings ------------------------------------------
check_s12() {
  local image
  image=$(sed -n 's/^SEANCE_SANDBOX_IMAGE=//p' /etc/seance/seance.env 2>/dev/null || true)
  if [[ $image != localhost/seance-agent@sha256:* ]]; then
    record "s12 flag spellings" FAIL "no agent image in /etc/seance/seance.env (run bootstrap.sh)"
    return
  fi
  # as_seance starts in $SEANCE_HOME, so change into the spike package inside the child shell.
  # shellcheck disable=SC2016 # $1 expands inside the child shell
  if as_seance env S12_IMAGE="$image" bash -c 'cd "$1" && node src/s12-podman.ts' _ "$RUN_DIR/spikes/acp" > "$OUT/s12.log" 2>&1; then
    record "s12 flag spellings" PASS "see $OUT/s12.log"
  else
    record "s12 flag spellings" FAIL "see $OUT/s12.log"
  fi
}

# ---- 6. spike s12-auth (optional, one prompt) ---------------------------------------------------
check_s12_auth() {
  if [ "$WITH_AUTH" -eq 0 ]; then
    record "s12-auth (one prompt)" SKIP "run with --with-auth after the Kiro login"
    return
  fi
  local image auth=$SEANCE_HOME/.local/share/kiro-cli
  image=$(sed -n 's/^SEANCE_SANDBOX_IMAGE=//p' /etc/seance/seance.env 2>/dev/null || true)
  if [ -z "$(ls -A "$auth" 2>/dev/null || true)" ]; then
    record "s12-auth (one prompt)" FAIL "no Kiro login in $auth"
    return
  fi
  # shellcheck disable=SC2016 # $1 expands inside the child shell
  if as_seance env S12_IMAGE="$image" S12_AUTH_DIR="$auth" bash -c 'cd "$1" && node src/s12-kiro-auth.ts' _ "$RUN_DIR/spikes/acp" > "$OUT/s12-auth.log" 2>&1; then
    record "s12-auth (one prompt)" PASS "see $OUT/s12-auth.log"
  else
    record "s12-auth (one prompt)" FAIL "see $OUT/s12-auth.log"
  fi
}

check_podman
check_images
check_integration
check_quota
check_s12
check_s12_auth

if [ "$IRCD_WAS_ACTIVE" -eq 1 ]; then
  systemctl start seance-sandbox-nft.service seance-ircd.service || echo "warning: the ircd did not start again" >&2
fi

failed=0
printf '\n%-30s %-5s %s\n' "check" "result" "detail"
printf '%-30s %-5s %s\n' "-----" "------" "------"
for i in "${!NAMES[@]}"; do
  printf '%-30s %-5s %s\n' "${NAMES[$i]}" "${RESULTS[$i]}" "${DETAILS[$i]}"
  [ "${RESULTS[$i]}" = "FAIL" ] && failed=1
done
{
  # /opt/seance is owned by seance: root's git needs safe.directory ("detected dubious ownership").
  echo "S12 on $(hostname) $(date -u +%FT%TZ), commit $(git -c safe.directory="$REPO_DIR" -C "$REPO_DIR" rev-parse HEAD)"
  for i in "${!NAMES[@]}"; do echo "${RESULTS[$i]} ${NAMES[$i]}: ${DETAILS[$i]}"; done
} > "$OUT/summary.txt"
echo
echo "summary: $OUT/summary.txt"
exit "$failed"
