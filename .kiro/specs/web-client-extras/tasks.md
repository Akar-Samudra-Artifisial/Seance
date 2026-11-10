# Implementation Plan: web-client-extras

## Overview

Order: the runner label first (independent of the web work), then the pure channel-list core, the store and dialogs, the theme, the shortcut registry, the explained-disabled controls, the Playwright baseline, and the docs and final checks. Each property test carries its design ID (`P1` to `P4`) in its name. Verify per package (`pnpm --filter @seance/web typecheck`, `pnpm --filter @seance/web exec vitest run`, `pnpm --filter @seance/runner exec vitest run`); root turbo runs may time out here. Rebuild the runner (`pnpm --filter @seance/runner build`) before ircd tests that import `@seance/runner`. `apps/ircd` source is not changed. Never delete a test to make it pass; change a test only for an intended behaviour change, with a comment. The Figma export of frame 06 is a manual step (task 7.2) and blocks nothing.

## Tasks

- [x] 1. Runner WHOIS tools label
  - [x] 1.1 Add `apps/runner/src/whois/tools-label.ts` with `toolsLabel(raw, mode)`
    - Rewrites the `shell(...)` token (or a bare `shell`) to `shell(host)` for `none` and `shell(sandbox)` for `podman`; leaves other text, including `shellcheck`, alone
    - _Requirements: 6.1, 6.2_
  - [x] 1.2 Add `sandboxMode` to `InviteControllerDeps`, apply `toolsLabel` where the profile is registered in the Whois_Snapshot, and pass `sandboxConfig.mode` from `runner.ts`
    - _Requirements: 6.2_
  - [x] 1.3 Write tests
    - `apps/runner/test/tools-label.test.ts` for both modes, a bare token and unrelated text
    - Update `apps/ircd/test/runner/credits.integration.test.ts` to expect `tools: fs, git, shell(host)` (sandbox none), with a comment
    - _Requirements: 6.1_

- [x] 2. Channel list core (pure)
  - [x] 2.1 Add `ListRow` and `ChannelList` types and the `LIST_*` limits to `irc/types.ts`; add `list?` to `ClientState`
    - _Requirements: 1.3, 1.4_
  - [x] 2.2 Add `irc/channel-list.ts`: `parseListRow`, `filterRows`, `sortRows`, `nextSort`, `batchNames`, `summarise`
    - Row validation (name 1 to 200 characters without spaces or commas, count `^\d{1,9}$`, topic clipped to 512); filter on `irc_lower(plain(...))`; unknown agent counts pass Min agents and sort last in both directions; `batchNames` measures UTF-8 bytes by hand because the core has no `TextEncoder`
    - _Requirements: 1.4, 1.6, 1.7, 2.2, 2.3_
  - [x] 2.3 Add `irc/reducer.list.ts`: `startList`, `failList`, `clearList`, `onListReply`, `countListNames`, `finishListNames`; route 321, 322, 323, 353 and 366 in `reducer.ts`; clear `list` in `resetForReconnect`
    - 321, 322 and 323 go to the list only while `status === "loading"`; otherwise they keep landing in the Status window
    - 323 fills agent counts from joined windows and returns `NAMES` batches in `send`; 353 and 366 for requested channels are counted and finish the row
    - _Requirements: 1.3, 1.4, 1.10, 2.1, 2.2, 2.4_
  - [x] 2.4 Write tests
    - `channel-list.test.ts`: `parseListRow` table, filter, sort, `nextSort` cycle, `summarise`
    - **Property 1: Filter is a subset and idempotent** (`P1 filter is a subset and idempotent`)
    - **Property 2: Sort is a permutation** (`P2 sort is a permutation`)
    - **Property 4: Batches stay within the byte limit and cover every channel in order** (`P4 batches stay within the byte limit`, multi-byte names)
    - `reducer.list.test.ts`: collects while loading, old Status behaviour when not loading, late 322 ignored, invalid rows dropped, cap, joined and pending counts, 366 finish, unrelated 353 and 366 ignored, `failList`, reconnect reset
    - **Property 3: The row cap never exceeds 500** (`P3 the row cap holds for any number of replies`)
    - Existing `reducer.route.test.ts` and `reducer.whois.test.ts` stay unchanged and green
    - **Validates: Requirements 1.3, 1.4, 1.6, 1.7, 2.2 to 2.4**

- [x] 3. Store actions and dialogs
  - [x] 3.1 Add `channelListOpen`, `shortcutsOpen` and `theme` to `UiState`; add `openChannelList`, `refreshChannelList`, `closeChannelList`, `joinFromList`, `openShortcuts`, `closeShortcuts`, `setTheme`, `toggleTheme` to the store
    - `LIST` is sent only when registered; a 15 s timer (`deps.setTimeout`) marks a still-loading list failed; the timer is stopped on refresh, close, disconnect, quit and `dispose`; a new connection drops the old list; `joinFromList` submits the join command and closes
    - _Requirements: 1.1, 1.5, 1.8, 1.10_
  - [x] 3.2 Add `components/Dialog.tsx` in the style of Figma frame 04
    - Navy gradient title bar, 16x14 `?` and `X` buttons, `role="dialog" aria-modal`, Tab trap, Esc closes, focus returns to the opener
    - _Requirements: 1.9, 4.1_
  - [x] 3.3 Add `components/ChannelListDialog.tsx` (Figma frame 05)
    - Match text, Min agents, Hide channels without a topic, Apply filter; sortable header buttons with `aria-sort`; roving-tabindex rows; Enter and double-click join; Loading, No channels and failure text; footer with counts and listed time; Join, Refresh, Close; `?` toggles a keyboard hint; topics through `plain()`
    - _Requirements: 1.2, 1.5 to 1.9, 2.3_
  - [x] 3.4 Enable the toolbar Channel list button while registered, add Commands, Channel list, and render `ChannelListDialog` and `ShortcutsDialog` in `Shell`
    - _Requirements: 1.1_
  - [x] 3.5 Write tests
    - `store/extras.test.ts`: not registered is a no-op, `LIST` sent, timeout, refresh clears the old timer, join, close on disconnect, list dropped on a new connection
    - `components/extras.test.tsx`: Loading until 323, rows and plain topics, a dash for unknown counts, empty state, filter on Apply only, sort with `aria-sort`, Enter and double-click join, Join explained while nothing is selected, Esc, Refresh, `?` hint
    - **Validates: Requirements 1.1 to 1.10**

- [x] 4. Theme
  - [x] 4.1 Add the Classic token block under `html[data-theme="classic"]` in `app/globals.css` and the `--color-mention-fill` token; use `bg-mention-fill` for mention rows in `ChatLine.tsx`
    - Values from Figma frame 06; colours that fail 4.5:1 are lifted and commented, as listed in `design.md`; no inline style, CSP and `proxy.ts` unchanged
    - _Requirements: 3.2, 3.4_
  - [x] 4.2 Add `--classic` mode to `scripts/irc-palette.mjs` and write the Classic `--color-irc-fg-N` values
    - _Requirements: 3.4_
  - [x] 4.3 Add `THEME_KEY`, `isTheme`, `readTheme` and `writeTheme` to `store/storage.ts`; `ui.theme` starts as Ghost and `loadStoredTheme()` applies the stored name; add `components/ThemeSync.tsx` (calls `loadStoredTheme()` and sets `data-theme`, both in layout effects, so hydration matches the server render; review finding 7)
    - A failed write leaves the theme set and adds an error line to the Status window
    - _Requirements: 3.1, 3.3_
  - [x] 4.4 Toolbar: Toggle theme button and `Theme: Ghost` or `Theme: Classic` label; View menu: checked Ghost theme and Classic theme items
    - _Requirements: 3.1_
  - [x] 4.5 Let the Playwright fixture read the stored theme (`themeOnlyBackend` in `fixtures/shell.tsx`)
    - _Requirements: 3.5_
  - [x] 4.6 Write tests
    - `a11y/contrast.test.ts`: parse the Ghost set apart from the Classic block; every text token on white and on the mention fill; accent on its 20 % fill; mention bar 3:1; focus ring 3:1; selected row
    - `store/extras.test.ts`: default Ghost, invalid stored values ignored, stored Classic read, toggle stores only the name, failed write reported
    - `Toolbar.test.tsx`: toggle changes theme and label
    - **Validates: Requirements 3.1 to 3.4**

- [x] 5. Keyboard shortcuts
  - [x] 5.1 Add `shortcuts/shortcuts.ts`: `MENU_DEFS`, `INPUT_KEYS`, `CLOSE_KEY`, `windowSwitchIndex`, `menuIndexForMnemonic`, `mnemonicOf`, `pasteNote`, `SHORTCUTS`
    - _Requirements: 4.2, 4.3_
  - [x] 5.2 Use the module in the real handlers: `Shell` (Alt+digit), `MenuBar` (menus built from `MENU_DEFS`, mnemonics, `aria-keyshortcuts`), `InputLine` (Tab, ArrowUp, ArrowDown), `Dialog` (Esc)
    - _Requirements: 4.2_
  - [x] 5.3 Add `components/ShortcutsDialog.tsx` and enable Help, Keyboard shortcuts
    - Rows generated from `SHORTCUTS` by group; paste note from `PASTE_MAX_LINES` and `PASTE_INTERVAL_MS`
    - _Requirements: 4.1, 4.3_
  - [x] 5.4 Write drift tests in `components/extras.test.tsx`
    - One dialog row per registry entry, paste note contains both constants, Esc closes
    - `windowSwitchIndex` matches Alt+1 to 9 only; every menu button announces the registry mnemonic; Alt+H opens Help; the Input_Line reacts to the registry keys
    - **Validates: Requirements 4.1 to 4.3**

- [x] 6. Explained disabled controls
  - [x] 6.1 Add `reason` to `MenuEntry` and render it as `title` and `aria-description` in `MenuPopup`; give every disabled entry in `MenuBar` a specific reason
    - _Requirements: 5.1, 5.2, 5.4_
  - [x] 6.2 Add `description` to `CaptionButton`; use it for the title-bar minimise and maximise (browser tab), the title-bar close when not connected (now inert), the menu-bar restore and close buttons
    - _Requirements: 5.1, 5.2_
  - [x] 6.3 Toolbar: `reason` on Connect, Options, Channel list and Agents (disabled outside a channel window); tooltip is the label, a colon and the reason
    - _Requirements: 5.1, 5.2, 5.4_
  - [x] 6.4 Write tests
    - `components/extras.test.tsx`: no unexplained disabled control in six client states (fresh, connecting, status, channel, two channels, dropped) across title bar, menu bar, every opened menu and toolbar; the named reasons; an explained control stays inert
    - `Toolbar.test.tsx`: update the title and disabled-list expectations for the intended change, with comments
    - **Validates: Requirements 5.1 to 5.4**

- [x] 7. Playwright
  - [x] 7.1 Refactor the Figma comparison of `e2e/pixel.spec.ts` into `compareWithFigma`; add the Frame_06 Classic fixture tests: token set applied, app baseline `06-classic.png` at five sizes, no CSP violation, frame 06 comparison that skips without its export
    - _Requirements: 3.5_
  - [x] 7.2 **Manual step (blocks nothing):** save the Figma export of frame 06 as `apps/web/e2e/figma/06-classic-1440x900.png`, run the comparison with `FIGMA_MAX_DIFF_RATIO_06` set to 0, read the measured ratio from the failure and set the limit to measured plus 20 % (design Open Point 1)
    - Done 2026-11-08: export from the Figma REST API (node 1:1623, 1440x900); measured 16,827 of 1,296,000 pixels (0.01298), limit 0.0156
    - _Requirements: 3.5_

- [x] 8. Docs and final checks
  - [x] 8.1 Update `README.md` and `apps/web/README.md` (disabled items, channel list, themes, shortcuts, frame 06 baseline)
    - _Requirements: 7.3_
  - [x] 8.2 Record the Figma calls and add the usage entries to `docs/KIRO_USAGE.md`
    - _Requirements: 7.3_
  - [x] 8.3 Run `pnpm build`, `pnpm typecheck`, `pnpm lint`, `pnpm test --force` and `pnpm --filter @seance/web test:e2e`; revert `apps/web/next-env.d.ts`
    - Confirm the word that names the trademarked client appears in none of the touched files
    - _Requirements: 7.1, 7.2_

- [x] 9. Tidy the dead controls (follow-up 2026-11-10)
  - [x] 9.1 Remove the toolbar Options button (and its separator), Tools › Options… and the Favorites menu; six menus, slots `[42, 42, 49, 69, 56, 56]`; update the tests that expected them (`Toolbar`, `MenuBar`, `extras`, `pixel-shell`, `flow.spec.ts`) and add Alt-key and arrow-wrap tests
    - _Requirements: 5.4_
  - [x] 9.2 Title-bar Maximise toggles browser full screen (`Full screen` / `Exit full screen`, follows `fullscreenchange`, inert with its reason where `fullscreenEnabled` is false, rejected promise swallowed); tests in `TitleBar.test.tsx` and `flow.spec.ts`
    - _Requirements: 5.5_

- [x] 10. Audit fixes (2026-11-10)
  - [x] 10.1 `/notice` and `/privmsg` are table commands (`textCommand`): target plus the whole rest of the line as one trailing parameter, echo like `/msg` (a notice echoes as `-nick-`), CR/LF/NUL rejected; tests in `audit-commands.test.ts` and `store/audit.test.ts`
  - [x] 10.2 `/help` (generated from `COMMAND_HELP`, one usage line per `COMMANDS` key, a test keeps the two key sets equal) and `/clear` are local actions; neither sends anything
  - [x] 10.3 Reconnect rejoins every open channel window and uses the last nick the server confirmed; the Connect dialog prefills it after a Quit
  - [x] 10.4 Closing the active window activates the next non-minimised window, else restores the Status window
  - [x] 10.5 Nick list: double-click and Enter open a query; context menu (right-click, Shift+F10, Menu key) with Whois, Query, Give/Take voice and Kick (inert with a reason unless channel operator); `MenuPopup` reused, focus returns to the row; tests in `NickList.actions.test.tsx`
  - [x] 10.6 The literal "12" before agent replies: root cause is the runner's `stripControls`, which removed `\x03` but left its digits, so `\x0312The veil` became `12The veil` before the runner added its own colour. It now removes whole colour sequences; regression test in `apps/runner/test/hardening.test.ts` (the web formatter was correct)
  - [x] 10.7 Compact `»` menu: unit test that every hidden menu opens its own menu, and a Playwright test at the compact viewports (`pixel.spec.ts`); no defect found in `MenuBar.tsx`
  - [x] 10.8 `/list` opens the Channel list dialog (`/list <args>` still sends `LIST`); `/mode #chan` prints `324` (and `329`) into the channel window, the automatic query on join stays silent; `367`/`368` lines go to the channel window
  - [x] 10.9 No ellipsis on Join, Query, Whois, Topic, Away (they only prefill); Connect… and Channel list… keep it; tests, e2e, README and shortcut texts updated
  - [x] 10.10 `app/icon.svg` (app candle on the ghost background) stops the favicon 404; the Agents button on Desktop and Medium focuses the nick list and prints `N agents in #chan` / `No agents in #chan` (`announceAgents`)
  - [x] 10.11 Bans: the ircd had no `+b` and nothing fed the runner's `BanList`. Implemented `MODE +b/-b` and the list (`367`/`368`), `474` on JOIN and INVITE of a banned nick (ircd-core criteria 9.11 to 9.15), mirrored agent-nick bans into the runner's ban list (`banNickOf`); `/ban` and `/unban` in the web client; `.kiro/steering/product.md` updated; tests in `apps/ircd/test/bans.test.ts`, `apps/runner/test/ban-nick.test.ts` and the exorcism integration test
  - [x] 10.12 Docs: `apps/web/README.md`, the in-app shortcuts (`Nick list` group), root README
  - [x] 10.13 ReDoS in ban matching: `globToRegExp` replaced by an iterative `globMatch` (two pointers, last `*`, no RegExp) used by `banMatches` and `isBanned`; `normalizeBanMask` collapses runs of `*`; tests in `apps/ircd/test/bans.test.ts` (case table, fast-check against a reference matcher, worst-case mask x 50 bans x 100 characters under 50 ms). ircd-core criterion 9.16
  - [x] 10.14 `MODE +b` replies: an invalid mask gets a server NOTICE naming it (no 461), a full list gets `478 ERR_BANLISTFULL` (new constant in `@seance/irc-protocol`), a duplicate stays silent; README and ircd-core criteria 9.17 and 9.18 say that `user` is client-supplied, that nick bans can be dodged and that host bans are recommended. No runner start-up mirror: ircd state and runner share one process and start empty, so the ircd's `474` check is the authority
  - [x] 10.15 Input line Tab/Shift+Tab: Tab completes only when a nick matches (or a completion is active), otherwise focus moves; Shift+Tab moves focus back unless it steps to the previous candidate (`completeNick(..., step)`, `cycleActive`); tests in `InputLine.test.tsx` and a `flow.spec.ts` step
  - [x] 10.16 Visible focus: the baseline `:focus-visible` rule was unlayered and beat every Tailwind `focus-visible:outline-*` utility, so dark surfaces got a black ring; it is now in `@layer base` with an accent-ring rule for `.bg-ghost-bg` surfaces (orange on Ghost, the lifted orange on Classic); the selected channel-list row gets a white ring; a Playwright test checks every focusable element's ring (contrast 3:1 against its backdrop) in Ghost and Classic at all five viewports. No focus is captured in the baselines
  - [x] 10.17 Nick menu: opens at the pointer (right-click) or under the row (Shift+F10, Menu key), kept inside the viewport (`MenuPopup` also clamps horizontally); closes and returns focus to the list when the nick leaves; menu ids are per instance (`useId`); tests in `NickList.actions.test.tsx`
  - [x] 10.18 Small UI fixes: `pluralise` for the status bar and nick list counts, status bar panels carry a `title` and Compact gives the counts a 3:2 share; `/msg`, `/notice`, `/privmsg` and `/query` to the own nick send nothing and show the line in the active window; the `»` list closes on an outside press and Esc and is clamped to the viewport
  - [x] 10.19 Credits counter shows two decimals (deployed host 2026-11-10: a 0.01-credit session read `credits: 0.0`): `CreditsCounter.tsx` `toFixed(2)`; tests in `Switchbar.test.tsx`, `pixel-shell.test.tsx`, `flow.spec.ts`; web-client-pixel-match R8.3 and the design's fixture note updated; the 360 px overflow test still passes; the ten app baselines regenerated (only the counter differs: 29 px at the fixed-width sizes, 286 px in Compact where the panel widens)
  - [x] 10.20 Update the counter without a manual `/whois` (the KICK and ChanServ triggers described here were removed in 10.21; decision: a silent WHOIS; the ChanServ `credits used` line names no agent and carries a cumulative per-channel amount, so its number stays unused): `ClientState.silentWhois` (keys, capped at `MAX_WHOIS_PENDING`) makes `318` and `401`/`402`/`406` end the request without a line while `320` still updates `credits`; the Store sends one 2 s after an agent's channel line, and one per agent with stored credits after the user's own KICK of an agent or a ChanServ `… credits used` line, at most once per agent every 30 s and 3 in flight; a user `/whois` during a silent one takes it over; cleared on disconnect, connect and reconnect, timers cancelled on disconnect and dispose. Tests: `irc/silent-whois.test.ts`, `store/silent-whois.test.ts`, a `flow.spec.ts` case; the e2e Fake_Agent script now meters 0.01 credits per turn
    - _Requirements: 8.18, 8.19, 8.20, 8.21_
  - [x] 10.21 Silent WHOIS review follow-up: removed the triggers on the own KICK and on ChanServ `… credits used` (on the deployed host a WHOIS of an agent in no channel has no `credits:` line); a 10 s timeout (`SILENT_WHOIS_TIMEOUT_MS`, `silentTimeouts`, `endSilentWhois`) ends a request without 318 or an error, and a `/whois` for an older entry is sent normally; `silentMessaged` (`markSilentMessaged`, set when the user sends a PRIVMSG or NOTICE to the nick) keeps a 401 that may answer the user visible. Tests in `store/silent-whois.test.ts` (no WHOIS on KICK or the ChanServ line, timeout, a `/whois` 11 s in with a late timer, 401 after `/msg` shown and otherwise swallowed, timeout cancelled on disconnect); the e2e case no longer expects a WHOIS after the kick. No pixel baseline changed
    - _Requirements: 8.18, 8.19, 8.20, 8.22, 8.23_
  - [x] 10.22 Late replies after a silent WHOIS timed out: the timeout now moves the key to `ClientState.silentExpired` (`expireSilentWhois`, capped at `MAX_WHOIS_PENDING`, oldest dropped); for such a key 311/312/319/317/301 are ignored, 320 only updates `credits`, and 318 or a 401/402/406 removes the key without a line (a late error after the user's own message to that nick is still shown, criterion 23); a user `/whois` removes the key first (`forgetSilentExpired`), and so does a new silent request for the nick; cleared with `silentWhois` in `stopSilent` and `resetForReconnect`. `silentSentAt` keeps only entries in flight or younger than the 30 s rate limit (`pruneSentAt`). Tests in `store/silent-whois.test.ts` and `irc/silent-whois.test.ts`. No pixel baseline changed
    - _Requirements: 8.22, 8.24_
  - Pixel baselines: the ten app baselines (`01-main.png`, `06-classic.png` at five sizes) were regenerated on purpose. The Input_Line has focus when the fixture loads, and its ring was black (the unlayered `:focus-visible` rule won) and is now the accent orange (10.16), so about 2,400 to 8,800 pixels per size differ. The Figma-export comparisons still pass within their limits.

## Notes

- Every test sub-task is a required step in this plan; design properties P1 to P4 are all in 2.4.
- Task 7.2 needed the user to export frame 06 from Figma (the tools cannot write the PNG); the export now exists and the frame 06 comparison runs.
- Tasks 4.1 and 4.2 produce the lifted Classic colours; each lift is commented in `globals.css` and tabled in `design.md`.
- Root `pnpm typecheck` and `pnpm test` may time out under turbo; per-package runs are acceptable. Tests use fake timers or injected `setTimeout` and bind sockets to port 0.

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1.1", "2.1", "4.1", "5.1", "6.1", "6.2"] },
    { "id": 1, "tasks": ["1.2", "2.2", "4.2", "4.3", "5.2", "6.3"] },
    { "id": 2, "tasks": ["1.3", "2.3", "3.2", "4.5", "5.3"] },
    { "id": 3, "tasks": ["2.4", "3.1", "4.4"] },
    { "id": 4, "tasks": ["3.3", "6.4"] },
    { "id": 5, "tasks": ["3.4", "4.6", "5.4"] },
    { "id": 6, "tasks": ["3.5", "7.1"] },
    { "id": 7, "tasks": ["8.1", "8.2"] },
    { "id": 8, "tasks": ["8.3"] },
    { "id": 9, "tasks": ["7.2"] }
  ]
}
```
