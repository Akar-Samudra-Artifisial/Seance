# @seance/web

The Séance web client: a retro, keyboard-first IRC client built with Next.js, Tailwind and Zustand. It speaks plain IRC over WebSocket to the Ircd. See [DESIGN.md](../../DESIGN.md) for the UI design.

## Window chrome

The layout follows the Figma mockup (see [docs/KIRO_USAGE.md](../../docs/KIRO_USAGE.md) for the frames used). From top to bottom:

At 1440x900 the regions match Frame_01 to the pixel box (3 px frame, title 22, menu 20, toolbar 32, topic 24, chat 686, input 24, tray 28, switchbar 26, status 21). The sizes live once in `app/globals.css` (`--layout-*`) and in `src/layout/metrics.ts`; a test keeps them equal.

- **Title bar**: app candle, title and caption buttons. The title is `Séance — [#chan (+mnt): topic]` for a channel, `Séance — [Status: nick (+i) on host]` for the status window and `Séance — [nick]` for a query. Empty topics and empty mode strings are left out. The document title is the same text. Minimise is inert ("Not available in a browser tab"). Maximise toggles browser full screen (`Full screen` / `Exit full screen`, following the browser's own state, so Esc is honoured); where the browser does not allow full screen it is inert with the same reason. Close quits when connected and is inert, with a reason, otherwise.
- **Menu bar**: the active window's icon at the left, then File, View, Tools, Commands, Window, Help in fixed slots, with `Alt+<letter>` mnemonics and arrow-key navigation, and the active window's minimise, restore and close buttons at the right. Items that need an argument put the command into the input line (for example `/join #`) instead of opening a dialog.
- **Toolbar**: connect | channel list, agents | logs | theme, plus the `Theme: Ghost` or `Theme: Classic` label. Channel list opens the channel list dialog; Toggle theme switches the theme.
- **Maximised window**: the active window fills the frame with no title bar of its own (its title is in the title bar). A channel window shows the topic field, the chat pane with an always-visible Win95 scrollbar, and the nick list. Minimised windows move to a tray above the switchbar and stay in the switchbar; click the bar to restore. The status window cannot be closed.
- **Switchbar**: one button per window (unread in navy, mention in orange) and a credits panel at the right end. The counter sums the latest `total` per agent from `320` WHOIS lines like `credits: #dev 9.60 / total 12.00`. It reads `credits: 0.0` until such a line arrives.
- **Status bar**: `Connected to <host>` plus ` (TLS)` for `wss:`, then ` as <nick>`, `lag <s>s`, and `<a> agents · <w> away · <o> ops`. Lag comes from a `PING :seance-lag-<n>` sent every 30 s; it reads `lag –` before the first reply.

### Modes and away tracking

The client sends `MODE <channel>` once after joining and keeps channel flags (such as `+mnt`) from `324` and later `MODE` changes. Flags with a parameter (`o`, `v`, `b`, `k`, `l`, `e`, `I`) are not part of the shown string. User modes come from `221` and `MODE <ownnick>`. Away state comes from `301`, `305`, `306` and inbound `AWAY`; away members are dimmed in the nick list and counted in the status bar. The client never polls WHOIS for away state.

### Line formats

- Chat: `[HH:MM] <@nick> text`, `<+nick>` for voiced, `<nick>` otherwise. The prefix is the sender's mode when the line arrived, so older lines keep it after a later `+o`.
- Events: `*** nick (user@host) has joined #chan`, `has left`, `has quit`, `is now known as`, `sets mode:`, `sets topic:`.
- Session start: `--- Session start: Fri Nov 06 23:38:02 2026` in local time.
- Away: `* nick is away (text)`, then `* nick is back (gone hh:mm:ss)` when the away line was seen (plain `is back` otherwise).
- Notices: `-nick- text` with only `-nick-` in orange. Agent tool notices (`using tool: …`) read `-tool- …` in grey; denied ones read `[denied] -tool- …`, struck through.
- WHOIS: classic lines, each starting with the nick in bold, for example `coder is user@host * Real name`, `coder on #chan`, then each `320` line as received, then `coder End of /WHOIS list.`.
- Exorcism: a kick of a known agent reads `*** coder has been exorcised by alice (reason)`. When the reason is empty or equals the kicker nick, the parentheses are dropped. The agent stays in the nick list, struck through, until it rejoins, the window closes or the client reconnects.

### Disabled items

Every disabled or inert toolbar, menu and title bar control carries `aria-disabled` (or `disabled`), a `title` and an `aria-description` that say why: "Disconnect first" (Connect while connected), "Connect first", "Switch to a channel window first", "Already the last window", "Already the first window", "The Status window cannot be closed", "Not available in a browser tab" (title bar minimise, and maximise where full screen is not allowed) and the restore button while the window is not minimised. A test renders the controls in six client states and fails on any disabled control without a reason.

### Channel list

The toolbar button and Commands → Channel list… send `LIST` and open a dialog (Figma frame 05). It shows "Loading…" until `323`, filters by text (name or topic), minimum agents and "Hide channels without a topic" when you press Apply filter, sorts by a column header (ascending, descending, server order), and joins the chosen channel on Enter, double-click or Join. At most 500 rows are kept. The Agents column is counted in the client: for channels you have not joined it sends `NAMES` (batched) and counts the known agents (`coder`, `reviewer`, `researcher`), the same definition as the nick list; until a count arrives it shows "—" and the Min agents filter ignores that row. The server's `322` format is unchanged.

### Themes

Ghost (dark, default) and Classic (light, Figma frame 06). Switch with the toolbar button or View → Ghost theme / Classic theme. Classic is a set of CSS custom properties under `html[data-theme="classic"]` in `app/globals.css`; only the theme name is stored in `localStorage` (`seance.theme`), and any other stored value is ignored. Colours that fail 4.5:1 in the frame are darkened and listed in the spec design (`.kiro/specs/web-client-extras/design.md`).

### Keyboard shortcuts

Help → Keyboard shortcuts lists them. The list is generated from `src/shortcuts/shortcuts.ts`, which the real handlers (Alt+digit, menu mnemonics, input line keys) also use.

### Responsive layout

- Desktop (1024 px and up): the Frame_01 layout; the chat pane takes the remaining width.
- Medium (768 to 1023 px): the nick list is 140 px; the status bar panels scale.
- Compact (below 768 px): the nick list opens as an overlay from the toolbar agents button (Escape or a tap outside closes it); menus that do not fit move into a `»` menu; the theme label, the lag and the filler panels are hidden; the switchbar scrolls; the credits panel shows the candle and the value. The shell follows `visualViewport`, so the input line stays above an on-screen keyboard. On touch screens every control has a 32x32 hit area. An Options dialog (and with it the Options button and Favorites menu, which were removed because nothing was behind them), channel list window, Classic theme, CRT scanlines and floating ghosts are out of scope for now.

## Run against a local Ircd

1. Start the Ircd and allow the origin the browser will use:

   ```sh
   pnpm --filter @seance/ircd build
   IRCD_HOST=127.0.0.1 IRCD_WS_ALLOWED_ORIGINS=http://localhost:3000 node apps/ircd/dist/index.js
   ```

   Run it from the repository root. The Ircd has no watch mode; rebuild and restart it after a change.

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
| `NEXT_PUBLIC_IRCD_WS_URL` | web server (per request) | Default Ircd WebSocket URL (`ws:` or `wss:`). Default `ws://127.0.0.1:6680` |
| `IRCD_WS_ALLOWED_ORIGINS` | Ircd | Page origins the Ircd accepts |
| `SEANCE_E2E_FIXTURES` | web (build time, tests only) | `1` adds the fixture route (`*.fixture.tsx` pages) |
| `SEANCE_DIST_DIR` | web (build time, tests only) | Build output directory, a `.next*` name inside `apps/web` (e2e uses `.next-e2e`) |

`NEXT_PUBLIC_IRCD_WS_URL` is read on the server for each request (`proxy.ts` and `app/page.tsx` pass `process.env` to `computeConnectConfig`, so Next.js does not inline it), and the page hands the value to the browser as a prop. Set it in the environment of `next start` (or `next dev`); changing it needs a restart, not a rebuild. The origin of this URL also becomes the CSP `connect-src`, so it is the only non-local WebSocket origin the page may open. An invalid value makes page requests fail with an error that names the variable.

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

The `flows` project runs the behaviour specs. Five pixel projects (`desktop-1440`, `desktop-1024`, `medium-768`, `compact-390`, `compact-360`) open the fixture page `/fixtures/01-main` (the Frame_01 content fed through an in-memory socket) and check screenshots, horizontal overflow, region boxes at 1440x900, touch hit areas and CSP violations.

- The fixture route exists only in a build made with `SEANCE_E2E_FIXTURES=1`; the harness sets it and `SEANCE_DIST_DIR=.next-e2e`, so the deployable `.next` output never contains fixture code (`src/fixtures/bundle.test.ts` checks both outputs; locally it skips a missing output, with `CI=true` it fails, so CI must run `pnpm build` and the e2e build before `pnpm test`).
- Baselines live in `e2e/__screenshots__/<project>/` without a platform suffix and were generated with macOS Chromium. After an intended visual change, or on another OS, regenerate them:

  ```sh
  pnpm --filter @seance/web exec playwright test -c e2e/playwright.config.ts --update-snapshots
  ```

- The Figma comparison at 1440x900 uses `e2e/figma/01-main-1440x900.png` (Frame_01 exported from Figma at 1x) with `maxDiffPixelRatio: 0.0157` (measured 0.0131 plus 20 %; see design Open Point 7). Without the file the test is skipped with "Figma export missing". Frame 06 (Classic) works the same way with `e2e/figma/06-classic-1440x900.png` and `FIGMA_MAX_DIFF_RATIO_06`; the export is committed (Figma REST export of node 1:1623) and its limit is 0.0156 (measured 0.01298 on 2026-11-08, plus 20 %). After an intended visual change, re-measure it: set `FIGMA_MAX_DIFF_RATIO` in `e2e/pixel.spec.ts` to 0, read the ratio from the failure, then set it back to measured + 20 %.

## Icons

The icons are the Figma drawings. Sources are `design/figma-icons/*.svg` (from the mockup) and `design/figma-icons-extra/*.svg` (pressed states, the active researcher ghost, the `»` chevrons, the query child icon). A source `<path>` may only carry `d`, `fill`, `stroke`, `stroke-width`, `stroke-linecap`, `stroke-linejoin`, `fill-rule`, `clip-rule` and `opacity`; any other attribute, or attribute text the script cannot parse, stops the run with the file and path number, and values are escaped in the output. After changing a source, regenerate the components in `src/icons/`, `src/icons/sources.ts` and the scrollbar arrows in `app/scrollbar.css`:

```sh
node scripts/gen-icons.mjs
```

The generated files are committed; never edit them by hand. `src/icons/icons.test.tsx` checks that each component keeps the source's paths and colours.
