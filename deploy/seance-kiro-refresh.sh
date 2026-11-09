#!/bin/sh
# Keeps the Kiro login of the seance user alive (spec deploy-aws). Run by seance-kiro-refresh.service
# as the seance user (User=seance), never as root: the script writes into a directory that seance
# owns, so a privileged run would follow whatever links a compromised seance planted there.
# bootstrap.sh installs it as /usr/local/sbin/seance-kiro-refresh.
#
# Why: kiro-cli 3.1.0 with a social (Google) login keeps a one-hour access token and refreshes only
# an EXPIRED token. A failed refresh after expiry deletes the login, and every agent then fails with
# "session/new timed out" or "Authentication required". A refresh forced BEFORE expiry works and
# chains (each refresh rotates the token). See docs/SANDBOX.md for the open Kiro issues.
#
# How, in this order:
#   1. one run at a time (flock) and no run while a process writes the live database (its WAL);
#   2. copy the database with SQLite's backup API into a private HOME, set the copy's expires_at into
#      the past and run kiro-cli whoami against the copy;
#   3. only when the copy's expires_at moved forward, and the live login is still the one read at the
#      start (a manual re-login is never overwritten), install the copy over data.sqlite3 with an
#      atomic rename inside the auth directory.
# Prints timestamps and verdicts only, never the stored values.
#
# Exit codes: 0 refreshed (or another run holds the lock), 1 not refreshed (the login is untouched).
set -eu
umask 077

PATH=/usr/local/bin:/usr/bin:/bin
export PATH

# The same names as deploy/bootstrap.sh.
SEANCE_USER=${SEANCE_USER:-seance}
SEANCE_HOME=${SEANCE_HOME:-/home/seance}
AUTH_DIR=${AUTH_DIR:-$SEANCE_HOME/.local/share/kiro-cli}

DB_NAME=data.sqlite3
FORCED_EXPIRY=2000-01-01T00:00:00Z

log() { printf 'seance-kiro-refresh: %s\n' "$*"; }
fail() {
  log "$*" >&2
  exit 1
}

# SQLite access with parameterised queries. Subcommands:
#   expiry <db>            print expires_at of the login row (exit 3: no row or no table)
#   live-expiry <db>       the same for the LIVE database, opened read-only
#   expire <db> <value>    set expires_at of the login row
#   moved <before> <after> exit 0 when <after> is later than <before>
#   backup <src> <dst>     copy a live database (opened read-only) with sqlite3.Connection.backup
#   checkpoint <db>        PRAGMA wal_checkpoint(TRUNCATE); exit 5 when it could not finish
py() {
  python3 - "$@" <<'PY'
import json
import sqlite3
import sys
from datetime import datetime, timezone
from urllib.parse import quote

KEY = "kirocli:social:token"


def connect(path, read_only=False):
    # The live database is only ever read, so it is opened read-only; the copy stays read-write.
    if read_only:
        return sqlite3.connect("file:" + quote(path) + "?mode=ro", uri=True, timeout=10)
    return sqlite3.connect(path, timeout=10)


def parse(text):
    try:
        return datetime.fromtimestamp(float(text), tz=timezone.utc)
    except ValueError:
        pass
    when = datetime.fromisoformat(text.replace("Z", "+00:00"))
    return when if when.tzinfo is not None else when.replace(tzinfo=timezone.utc)


def columns(con):
    return [row[1] for row in con.execute("PRAGMA table_info(auth_kv)")]


def read_row(con):
    # The expiry is either its own column or a field of the JSON value.
    cols = columns(con)
    if not cols:
        return None
    if "expires_at" in cols:
        row = con.execute("SELECT expires_at FROM auth_kv WHERE key = ?", (KEY,)).fetchone()
        return None if row is None else ("column", row[0])
    row = con.execute("SELECT value FROM auth_kv WHERE key = ?", (KEY,)).fetchone()
    return None if row is None else ("json", row[0])


def main(argv):
    cmd = argv[1]
    if cmd == "moved":
        return 0 if parse(argv[3]) > parse(argv[2]) else 1
    if cmd == "backup":
        src = connect(argv[2], read_only=True)
        dst = sqlite3.connect(argv[3])
        try:
            src.backup(dst)
        finally:
            dst.close()
            src.close()
        return 0
    con = connect(argv[2], read_only=(cmd == "live-expiry"))
    try:
        if cmd == "checkpoint":
            busy, _log, _done = con.execute("PRAGMA wal_checkpoint(TRUNCATE)").fetchone()
            return 5 if busy else 0
        found = read_row(con)
        if found is None:
            return 3
        shape, raw = found
        if cmd in ("expiry", "live-expiry"):
            if shape == "column":
                value = raw
            else:
                text = raw.decode("utf-8") if isinstance(raw, bytes) else raw
                value = json.loads(text).get("expires_at")
            if value is None:
                return 3
            print(value)
            return 0
        if cmd == "expire":
            if shape == "column":
                con.execute("UPDATE auth_kv SET expires_at = ? WHERE key = ?", (argv[3], KEY))
            else:
                was_bytes = isinstance(raw, bytes)
                doc = json.loads(raw.decode("utf-8") if was_bytes else raw)
                doc["expires_at"] = argv[3]
                new = json.dumps(doc)
                con.execute("UPDATE auth_kv SET value = ? WHERE key = ?", (new.encode("utf-8") if was_bytes else new, KEY))
            con.commit()
            return 0
        return 2
    finally:
        con.close()


try:
    sys.exit(main(sys.argv))
except (sqlite3.Error, ValueError, KeyError, AttributeError, TypeError) as err:
    # The class only: messages can quote stored values.
    print("seance-kiro-refresh: database error (" + type(err).__name__ + ")", file=sys.stderr)
    sys.exit(4)
PY
}

[ "$(id -un)" = "$SEANCE_USER" ] || fail "must run as $SEANCE_USER, not $(id -un) (the unit sets User=$SEANCE_USER)"
live_db=$AUTH_DIR/$DB_NAME
[ -f "$live_db" ] || fail "no Kiro login database at $live_db; log in first (docs/DEPLOY.md, step 5)"

# 1a. One run at a time.
command -v flock >/dev/null 2>&1 || fail "flock not found (Debian: package util-linux)"
exec 9>"$AUTH_DIR/.refresh.lock"
status=0
flock -n 9 || status=$?
if [ "$status" -ne 0 ]; then
  log "another refresh is running"
  exit 0
fi

# 1a'. Staged copies of an earlier run that was killed (they hold a token). Safe under the lock.
rm -f -- "$AUTH_DIR"/.data.sqlite3.*

# 1b. Before any network call: a non-empty write-ahead log means a kiro-cli process is writing.
live_wal_busy() { [ -s "$live_db-wal" ]; }
if live_wal_busy; then
  fail "refresh skipped, login kept: $live_db-wal is not empty, a kiro-cli process is writing"
fi

work=''
staged=''
cleanup() {
  [ -z "$work" ] || rm -rf -- "$work"
  [ -z "$staged" ] || rm -f -- "$staged"
}
trap cleanup EXIT
trap 'exit 1' HUP INT TERM

# 2. A private HOME for kiro-cli (mktemp makes it 0700): the database through the backup API, the
# other files of the login directory as plain copies.
work=$(mktemp -d)
data=$work/.local/share/kiro-cli
mkdir -p "$data"
for entry in "$AUTH_DIR"/* "$AUTH_DIR"/.[!.]*; do
  [ -e "$entry" ] || continue
  case ${entry##*/} in
    "$DB_NAME" | "$DB_NAME"-wal | "$DB_NAME"-shm | .refresh.lock | ."$DB_NAME".*) continue ;;
    *) cp -pR -- "$entry" "$data/" ;;
  esac
done
copy_db=$data/$DB_NAME
py backup "$live_db" "$copy_db" || fail "refresh skipped, login kept: cannot copy the login database"

status=0
old=$(py expiry "$copy_db") || status=$?
case $status in
  0) ;;
  3) fail "no kirocli:social:token login row in $live_db; log in again (docs/DEPLOY.md, step 5)" ;;
  *) fail "cannot read the login row in $live_db; log in again (docs/DEPLOY.md, step 5)" ;;
esac

py expire "$copy_db" "$FORCED_EXPIRY" || fail "refresh FAILED, login kept (expires $old)"

# Output and errors are dropped: whoami prints the account name.
status=0
env -i "HOME=$work" "PATH=$SEANCE_HOME/.local/bin:/usr/bin:/bin" timeout 60 kiro-cli whoami >/dev/null 2>&1 || status=$?

new=$(py expiry "$copy_db" 2>/dev/null) || new=''
if [ -z "$new" ] || ! py moved "$FORCED_EXPIRY" "$new" 2>/dev/null; then
  fail "refresh FAILED, login kept (expires $old)"
fi
log "kiro-cli whoami exited $status; token refreshed on the copy (expires $new)"

# 3a. A login that changed meanwhile (a manual re-login) is never overwritten.
now=$(py live-expiry "$live_db" 2>/dev/null) || now=''
if [ "$now" != "$old" ]; then
  fail "refresh aborted, login changed during refresh (login kept, expires ${now:-unreadable})"
fi
if live_wal_busy; then
  fail "refresh dropped, login kept (expires $old): $live_db-wal is not empty, a kiro-cli process is writing"
fi

# 3b. Fold the copy's write-ahead log into its main file, then rename it over the live database.
py checkpoint "$copy_db" || fail "refresh FAILED, login kept (expires $old): the copy could not be checkpointed"
staged=$(mktemp "$AUTH_DIR/.$DB_NAME.XXXXXX")
cat -- "$copy_db" > "$staged"
chmod 0600 "$staged"
# Flush the file to disk first, so a power loss after the rename cannot leave an empty login.
sync "$staged" 2>/dev/null || sync
mv -f -- "$staged" "$live_db"
staged=''
log "refreshed, login expires $new (was $old)"
