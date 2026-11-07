#!/usr/bin/env python3
"""Scripted Journey A + B (DESIGN.md) against a running ircd with the runner and real kiro-cli.

Run before every release to prove the runner works with a real agent (costs ~0.3 Kiro credits).

  1. Target repo with a known bug (login.js throws on a null email):
       python3 scripts/demo-journey.py --make-target /tmp/seance-demo/target
  2. Start the ircd (loopback only, so open invites are allowed):
       IRCD_HOST=127.0.0.1 IRCD_TCP_PORT=16667 IRCD_WS_PORT=16680 SEANCE_RUNNER=1 SEANCE_HARNESS=acp \
       SEANCE_TARGET_REPO=/tmp/seance-demo/target SEANCE_WORKSPACES=/tmp/seance-demo/workspaces \
       node apps/ircd/dist/index.js
  3. Run the journey (use a new channel name per run; worktrees are kept per channel):
       python3 scripts/demo-journey.py --port 16667 --channel '#fix-bug-1'

Exit code 0 only when every check passes: both agents join, an unmoded agent stays silent, the +o
coder fixes, tests and commits, WHOIS shows 320 lines, the kick exorcises it and a re-invite resumes.
"""

import argparse
import re
import socket
import subprocess
import sys
import time
from pathlib import Path

LOGIN_JS = """// Returns a greeting for the user who logs in.
function login(user) {
  const domain = user.email.split("@")[1];
  return `Welcome ${user.name} from ${domain}`;
}
module.exports = { login };
"""
LOGIN_TEST_JS = """const assert = require("node:assert");
const { login } = require("./login");
assert.strictEqual(login({ name: "Ana", email: "ana@x.io" }), "Welcome Ana from x.io");
assert.strictEqual(login({ name: "Bo", email: null }), "Welcome Bo");
console.log("ok");
"""


def make_target(path: Path) -> None:
    if path.exists() and any(path.iterdir()):
        sys.exit(f"{path} exists and is not empty")
    path.mkdir(parents=True, exist_ok=True)
    (path / "login.js").write_text(LOGIN_JS)
    (path / "login.test.js").write_text(LOGIN_TEST_JS)
    (path / "package.json").write_text(
        '{"name":"demo-target","private":true,"scripts":{"test":"node login.test.js"}}\n'
    )
    git = ["git", "-C", str(path)]
    subprocess.run([*git, "init", "-q", "-b", "main"], check=True)
    subprocess.run([*git, "add", "."], check=True)
    subprocess.run(
        [
            *git,
            "-c",
            "user.email=demo@seance.local",
            "-c",
            "user.name=demo",
            "commit",
            "-qm",
            "init: login with NPE on null email",
        ],
        check=True,
    )
    print(f"target repo ready: {path}")


class Irc:
    def __init__(self, host: str, port: int) -> None:
        self.s = socket.create_connection((host, port))
        self.s.settimeout(0.5)
        self.buf = b""
        self.t0 = time.time()
        self.seen: list[str] = []

    def send(self, line: str) -> None:
        print(f"[{time.time() - self.t0:6.1f}] >> {line}", flush=True)
        self.s.sendall((line + "\r\n").encode())

    def pump(self, seconds: float, until: str | None = None) -> bool:
        """Read for up to `seconds`; return True as soon as a line matches `until`."""
        end = time.time() + seconds
        while time.time() < end:
            try:
                data = self.s.recv(65536)
                if not data:
                    print("!! disconnected")
                    return False
                self.buf += data
            except socket.timeout:
                continue
            while b"\r\n" in self.buf:
                raw, self.buf = self.buf.split(b"\r\n", 1)
                line = raw.decode(errors="replace")
                if line.startswith("PING"):
                    self.s.sendall(("PONG" + line[4:] + "\r\n").encode())
                    continue
                clean = re.sub(r"[\x00-\x1f]", "", line)
                self.seen.append(clean)
                print(f"[{time.time() - self.t0:6.1f}] << {clean[:300]}", flush=True)
                if until and re.search(until, clean):
                    return True
        return False


def journey(host: str, port: int, ch: str) -> int:
    irc = Irc(host, port)
    checks: list[tuple[str, bool]] = []

    def check(name: str, ok: bool) -> None:
        checks.append((name, ok))
        print(f"----- {'PASS' if ok else 'FAIL'}: {name}", flush=True)

    def step(title: str) -> int:
        print(f"\n===== {title}", flush=True)
        return len(irc.seen)

    irc.send("NICK op")
    irc.send("USER op 0 * :demo operator")
    check("registered", irc.pump(5, r" 001 "))
    step("A1 join")
    irc.send(f"JOIN {ch}")
    check("joined", irc.pump(5, r" 366 "))
    step("A2 topic")
    irc.send(f"TOPIC {ch} :Fix NPE on login when email is null")
    irc.pump(3, r"TOPIC")
    step("A3 invite coder + reviewer")
    irc.send(f"INVITE coder {ch}")
    check("coder joined", irc.pump(60, r":coder!\S* JOIN"))
    irc.send(f"INVITE reviewer {ch}")
    check("reviewer joined", irc.pump(60, r":reviewer!\S* JOIN"))
    mark = step("A3b an agent without a mode stays silent")
    irc.send(f"PRIVMSG {ch} :coder: say hello in one short line")
    irc.pump(20)
    check(
        "unmoded coder silent",
        not any(re.search(r":coder!\S* PRIVMSG", l) for l in irc.seen[mark:]),
    )
    step("A4 voice coder")
    irc.send(f"MODE {ch} +v coder")
    irc.pump(3, r"MODE")
    irc.send(f"PRIVMSG {ch} :coder: in one short line, what does login.js do?")
    check("voiced coder replies", irc.pump(120, r":coder!\S* PRIVMSG"))
    irc.pump(15)
    mark = step("A5 op coder, ask for the fix")
    irc.send(f"MODE {ch} +o coder")
    irc.pump(3, r"MODE")
    irc.send(
        f"PRIVMSG {ch} :coder: fix the TypeError in login.js when email is null (return 'Welcome <name>' "
        "without the domain), run `node login.test.js`, then git commit with message "
        "'fix: handle null email in login'. Reply in at most 3 short lines."
    )
    irc.pump(300, r":coder!\S* PRIVMSG .*(?i:commit)")
    irc.pump(30)
    a5 = irc.seen[mark:]
    check("no permission denied for +o coder", not any("denied" in l for l in a5))
    check(
        "coder reports a commit",
        any(
            re.search(r":coder!\S* PRIVMSG .*(?i:committed|commit [0-9a-f]{7})", l)
            for l in a5
        ),
    )
    mark = step("A6 whois coder")
    irc.send("WHOIS coder")
    irc.pump(5, r" 318 ")
    check("whois has 320 lines", sum(" 320 " in l for l in irc.seen[mark:]) >= 4)
    mark = step("B1 kick coder")
    irc.send(f"KICK {ch} coder :scope creep")
    irc.pump(20)
    irc.send(f"NAMES {ch}")
    irc.pump(3, r" 366 ")
    names = [l for l in irc.seen[mark:] if " 353 " in l]
    check(
        "coder gone after kick", not any(re.search(r"[ :@+]coder\b", l) for l in names)
    )
    step("B2 re-invite coder (resume with summary)")
    irc.send(f"INVITE coder {ch}")
    check(
        "coder resumes with a message",
        irc.pump(90, rf":coder!\S* PRIVMSG {re.escape(ch)}"),
    )
    irc.pump(20)
    irc.send("QUIT :demo done")
    irc.pump(3)

    failed = [name for name, ok in checks if not ok]
    print(
        f"\n{len(checks) - len(failed)}/{len(checks)} checks passed"
        + (f"; FAILED: {', '.join(failed)}" if failed else "")
    )
    return 1 if failed else 0


def main() -> int:
    p = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    p.add_argument("--host", default="127.0.0.1")
    p.add_argument("--port", type=int, default=16667)
    p.add_argument("--channel", default="#fix-bug-123")
    p.add_argument(
        "--make-target",
        type=Path,
        metavar="DIR",
        help="create the demo target repo and exit",
    )
    a = p.parse_args()
    if a.make_target:
        make_target(a.make_target)
        return 0
    return journey(a.host, a.port, a.channel)


if __name__ == "__main__":
    sys.exit(main())
