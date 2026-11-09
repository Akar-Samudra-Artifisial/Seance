# Deployment notes (public server)

Notes for the public judge server, collected by spec `public-hardening`. The deployment itself (instance, Caddy, Podman units) is spec `deploy-aws`. With `IRCD_PUBLIC=1` the ircd refuses to start until every item in the first table is set; the error names each missing variable.

## Required with `IRCD_PUBLIC=1`

| Variable | Value on the public host | Why |
| --- | --- | --- |
| `IRCD_SERVER_PASSWORD` | 20+ random characters | Guest login. Guests may chat but never invite agents |
| `IRCD_ACCOUNTS_FILE` | file with one line per judge, mode `0600` | `PASS <nick>:<secret>`; create lines with `node tools/seance-account.mjs <nick>` |
| `IRCD_WS_ALLOWED_ORIGINS` | `https://<web host>` only, no `*` | Browser upgrades only from the web client |
| `IRCD_HOST` | `127.0.0.1` | Only Caddy reaches the ircd; TLS ends at Caddy |
| `IRCD_TRUSTED_PROXIES` | `127.0.0.1,::1` (loopback only) | Behind Caddy every peer is `127.0.0.1`. Without this list all users share one per-IP connection limit and one `PASS`-failure block, so one bad password locks everyone out |
| `SEANCE_INVITERS` | the account nicks of the judges | Only logged-in accounts on this list summon agents |
| `SEANCE_DAILY_CREDIT_CAP` | e.g. `20` | Credits per UTC day for all agents, channel and private sessions together |
| `SEANCE_SANDBOX=podman` + `SEANCE_SANDBOX_BLOCKED_CIDRS` | see [SANDBOX.md](./SANDBOX.md) | Agents run in rootless containers |

## Caddy must overwrite `X-Forwarded-For`

The ircd trusts `X-Forwarded-For` only from `IRCD_TRUSTED_PROXIES`, and from it takes the right-most address that is not a trusted proxy. That is only the real client if **Caddy replaces the header** with the address it sees, instead of appending to whatever the client sent. A client that can put its own value through could spread its connections over invented addresses and walk past the per-IP connection limit and the `PASS`-failure block.

Set the header explicitly on every `reverse_proxy` to the ircd, and do not configure Caddy's `trusted_proxies` (nothing in front of Caddy is trusted):

```caddyfile
# Web client
seance.example.com {
	reverse_proxy 127.0.0.1:3000
}

# ircd WebSocket (NEXT_PUBLIC_IRCD_WS_URL=wss://irc.seance.example.com)
irc.seance.example.com {
	reverse_proxy 127.0.0.1:6680 {
		# Overwrite, never append: the client's own X-Forwarded-For is discarded.
		header_up X-Forwarded-For {remote_host}
	}
}
```

With this, `IRCD_TRUSTED_PROXIES=127.0.0.1,::1` and `IRCD_HOST=127.0.0.1`. Check it once after deploying: connect twice with a forged `X-Forwarded-For: 203.0.113.1` header and confirm with `/whois` that both connections show your real address.

`IRCD_HOST` on loopback means plain TCP 6667 is not reachable from outside. Classic clients (irssi, HexChat) need a TLS TCP proxy in front of it, which Caddy's HTTP server does not provide; decide this in `deploy-aws`.

## Disk use: `SEANCE_WORKSPACES` needs a hard quota

**Required:** put `SEANCE_WORKSPACES` on a separate volume of fixed size, or under an XFS project quota. The size check below does not replace it.

The runner bounds a channel worktree at `SEANCE_WORKTREE_MAX_BYTES` (default 500 MiB). It checks the size after every finished tool call; over the cap it cancels the turn and resets the worktree, ignored files included (`git clean -fdx`), and a host commit of an oversized worktree is never made. This is a check, not a limit:

- Between two checks one tool call can write far more than the cap (a single `dd` or a download).
- `$HOME` and `/tmp` inside the container are tmpfs and count against the container memory, not this cap.
- The private session directories (`<SEANCE_WORKSPACES>/_private/...`) are not size-checked.
- The repository's object store grows with every host commit.

So the public host also needs a hard limit the agents cannot pass: put `SEANCE_WORKSPACES` on its own filesystem (a separate EBS volume or a loop-mounted image of fixed size), or use an XFS project quota on that directory. Then a full disk stops only the agents' writes, never the ircd, the credits file or the system. Watch free space on it during judging.

## Kiro account

Use a Kiro account created for the demo only, with a low spend limit, and revoke it (log out, delete the login state in `SEANCE_SANDBOX_AUTH_DIR`) right after judging. [SANDBOX.md](./SANDBOX.md) explains why: the login is readable inside the sandbox.

## Pause and budget

- `touch <SEANCE_WORKSPACES>/.seance-paused` stops new turns and invites at once; `rm` it to resume. No restart.
- `/whois <agent>` shows `budget: today X / CAP (UTC)` and `, paused` or `, reached` when they apply.
- Credits survive restarts in `<SEANCE_WORKSPACES>/.seance-credits.json`; delete it only with the runner stopped.
