# @seance/web

The Séance web client: a retro, keyboard-first IRC client built with Next.js, Tailwind and Zustand. It speaks plain IRC over WebSocket to the Ircd. See [DESIGN.md](../../DESIGN.md) for the UI design.

## Window chrome

The layout follows the Figma mockup (see [docs/KIRO_USAGE.md](../../docs/KIRO_USAGE.md) for the frames used). From top to bottom:

- **Title bar**: app icon, title and caption buttons. The title is `Séance — [#chan (+mnt): topic]` for a channel, `Séance — [Status: nick (+i) on host]` for the status window and `Séance — [nick]` for a query. Empty topics and empty mode strings are left out. The document title is the same text. Minimise and maximise are disabled; close quits when connected.
- **Menu bar**: File, View, Favorites, Tools, Commands, Window, Help, with `Alt+<letter>` mnemonics and arrow-key navigation. Items that need an argument put the command into the input line (for example `/join #`) instead of opening a dialog.
- **Toolbar**: 16 px icons for connect, options, channel list, agents and logs, plus the `Theme: Ghost` label.
- **MDI child windows**: each window has its own title bar with minimise, maximise and close. Minimised windows move to a tray above the switchbar and stay in the switchbar; click the bar to restore. The status window cannot be closed.
- **Switchbar**: one button per window (unread in link blue, mention in orange) and a credits counter at the right end. The counter sums the latest `total` per agent from `320` WHOIS lines like `credits: #dev 9.60 / total 12.00`. It reads `credits: 0.0` until such a line arrives.
- **Status bar**: `Connected to <host> as <nick>` (with ` (TLS)` for `wss:`), `lag <s>s`, and `<a> agents · <w> away · <o> ops`. Lag comes from a `PING :seance-lag-<n>` sent every 30 s; it reads `lag –` before the first reply.

### Modes and away tracking

The client sends `MODE <channel>` once after joining and keeps channel flags (such as `+mnt`) from `324` and later `MODE` changes. Flags with a parameter (`o`, `v`, `b`, `k`, `l`, `e`, `I`) are not part of the shown string. User modes come from `221` and `MODE <ownnick>`. Away state comes from `301`, `305`, `306` and inbound `AWAY`; away members are dimmed in the nick list and counted in the status bar. The client never polls WHOIS for away state.

### Line formats

- Chat: `[HH:MM] <@nick> text`, `<+nick>` for voiced, `<nick>` otherwise.
- Events: `*** nick (user@host) has joined #chan`, `has left`, `has quit`, `is now known as`, `sets mode:`, `sets topic:`.
- WHOIS: classic lines, each starting with the nick in bold, for example `coder is user@host * Real name`, `coder on #chan`, then each `320` line as received, then `coder End of /WHOIS list.`.
- Exorcism: a kick of a known agent reads `*** coder has been exorcised by alice (reason)`. When the reason is empty or equals the kicker nick, the parentheses are dropped. The agent stays in the nick list, struck through, until it rejoins, the window closes or the client reconnects.

### Disabled items

These render greyed out with `aria-disabled` and do nothing: the Favorites menu, Options, Channel list, the theme toggle, and the title bar minimise and maximise buttons. The Options dialog, channel list window, Classic theme, CRT scanlines and floating ghosts are out of scope for now.

## Run against a local Ircd

1. Start the Ircd and allow the origin the browser will use:

   ```sh
   IRCD_WS_ALLOWED_ORIGINS=http://localhost:3000 pnpm --filter @seance/ircd dev
   ```

2. Start the web client:

   ```sh
   pnpm --filter @seance/web dev
   ```

3. Open `http://localhost:3000`, pick a nick, connect, then `/join #test`.

The Ircd listens for WebSocket clients on port 6680 by default, which matches the default `NEXT_PUBLIC_IRCD_WS_URL` of `ws://127.0.0.1:6680`. Browsers refuse ports 6665-6669 (Fetch "bad port", `net::ERR_UNSAFE_PORT`), so the Ircd rejects those values for `IRCD_WS_PORT`; TCP 6667 for classic IRC clients is unaffected.

### Allowed origins

`IRCD_WS_ALLOWED_ORIGINS` is read by the Ircd, not by the web app. It is a comma-separated list of origins (`scheme://host[:port]`, no path, case-insensitive), or `*`.

- A browser always sends an `Origin` header. If it is not listed, the Ircd refuses the upgrade with HTTP 403.
- If the variable is empty or unset, every browser upgrade is refused. Clients that send no `Origin` header (irssi, HexChat, scripts) are always accepted.
- The browser does not expose the 403, so the connect dialog can only say the origin may have been refused.

`localhost` and `127.0.0.1` are different origins. List the one you type in the address bar, or both:

```sh
IRCD_WS_ALLOWED_ORIGINS=http://localhost:3000,http://127.0.0.1:3000
```

## Environment

See [`.env.example`](./.env.example).

| Variable | Used by | Meaning |
| --- | --- | --- |
| `NEXT_PUBLIC_IRCD_WS_URL` | web (build time) | Default Ircd WebSocket URL (`ws:` or `wss:`). Default `ws://127.0.0.1:6680` |
| `IRCD_WS_ALLOWED_ORIGINS` | Ircd | Page origins the Ircd accepts |

`NEXT_PUBLIC_IRCD_WS_URL` is inlined into the bundle at build time. Changing it requires a rebuild; setting it when running `next start` has no effect. The origin of this URL also becomes the CSP `connect-src`, so it is the only non-local WebSocket origin the page may open. An invalid value fails the build with an error.

## Build

```sh
pnpm --filter @seance/web build
```

The build script runs `next build --webpack`.

## Tests

Unit, property and component tests (vitest, no network):

```sh
pnpm --filter @seance/web test
pnpm --filter @seance/web typecheck
pnpm --filter @seance/web lint
```

End-to-end tests (Playwright) are opt-in and are not part of `pnpm test`. They build the app, start an Ircd and a Runner with a fake Kiro binary, and drive a real browser:

```sh
pnpm --filter @seance/web test:e2e
```
