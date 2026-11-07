# Implementation Plan: web-client-basic

## Overview

The plan builds `apps/web` in vertical slices. The first slice (tasks 1 to 5) reaches a runnable path against the real Ircd: connect, Status_Window, join, chat in a channel. The remaining tasks broaden the IRC_Core (full reducer, full command parser, formatter, linkify, ordering, mentions, history, completion), the Store (paste queue), the UI (MDI, switchbar, nick list, WHOIS, dialogs), the CSP proxy, accessibility, documentation and the opt-in Playwright e2e test.

All code is TypeScript (strict, ESM). The IRC_Core in `apps/web/src/irc` imports nothing but `@seance/irc-protocol` and relative files. Each property test carries its design property ID (`P1` to `P20`) in its test name and sits in its own file next to the code it checks. Unit tests for core modules are part of the implementation task of that module. Per-package runs (`pnpm --filter @seance/web typecheck` and `pnpm --filter @seance/web test`) are used for checkpoints because root turbo runs may time out on this machine; the final checkpoint also tries the root commands.

## Tasks

- [x] 1. Scaffold `apps/web` and confirm browser safety of the protocol package
  - [x] 1.1 Create the `@seance/web` package skeleton
    - Add `apps/web/package.json` with exact dependency versions (`next` 16.x, `react`, `react-dom`, `zustand` 5, `tailwindcss` 4, `@tailwindcss/postcss`, `typescript`, `@types/react`, `@types/react-dom`, `vitest`, `fast-check`, `jsdom`, `@testing-library/react`, `eslint`, `eslint-config-next`, `@playwright/test` as dev dependency) and `@seance/irc-protocol` as `workspace:*`; pin with `pnpm add --save-exact`
    - Add scripts `dev`, `build`, `start`, `typecheck` (app config plus `tsconfig.core.json`), `test` (`vitest run`, excluding `e2e/`), `lint` and the opt-in `test:e2e`
    - Add `tsconfig.json` extending `tsconfig.base.json` (only DOM lib, `jsx`, Next plugin and Bundler resolution as Next.js requires; no strictness change) and `tsconfig.core.json` compiling `src/irc` with `lib: ["ES2022"]` and `types: []`
    - Add `next.config.ts` (no rewrites, no API routes), `postcss.config.mjs`, `vitest.config.ts` (jsdom for `*.test.tsx`), `eslint.config.mjs` (next core-web-vitals plus rules forbidding `innerHTML`, `dangerouslySetInnerHTML`, `eval`, the `style` DOM prop and hex colours in components)
    - _Requirements: 1.1, 1.2, 1.3, 1.5, 11.1, 17.1, 17.9_

  - [x] 1.2 Add Tailwind tokens, fonts, layout and turbo wiring
    - Add `app/globals.css` with `@import "tailwindcss"`, the `@theme` tokens from the design (fonts, chrome, title gradient, ghost, nick colours, `--color-irc-0` to `--color-irc-15`) and `bevel-raised` / `bevel-sunken` utilities; hex values live only in this file
    - Add `app/layout.tsx` (fonts IBM Plex Mono, Arimo, VT323 via `next/font`, no runtime CDN request) and a placeholder `app/page.tsx`
    - Update `turbo.json`: `.next/**` (without cache) in `build.outputs`, `dev` depends on `^build`, no `test:e2e` task
    - _Requirements: 1.4, 1.6, 8.16, 8.17_

  - [x] 1.3 Confirm `@seance/irc-protocol` builds for the browser
    - Run `next build` for `@seance/web` with a page that imports `parse`, `serialize`, `LineFramer`, `Numerics`, `irc_lower` and `isValidNick`; confirm no Node polyfill is configured and the build passes
    - Add a vitest test asserting that `src/irc` imports only `@seance/irc-protocol` and relative files, and that no source under `app/` or `src/` contains the word "mIRC" in UI text
    - If the build fails because of a Node dependency in the protocol package, fix the protocol package without adding a polyfill
    - _Requirements: 1.8, 2.1, 2.2, 2.3, 2.4, 11.1_

- [x] 2. Build the minimal IRC_Core
  - [x] 2.1 Define core types, constants, case-mapping and line buffer
    - Create `src/irc/types.ts` (`ClientState`, `Window`, `Line`, `Member`, `ConnectionPhase`, `WhoisPending`, `PasteState`, constants `BUFFER_CAP`, `FRAME_MAX_BYTES`, `HISTORY_MAX`, `PASTE_MAX_LINES`, `PASTE_INTERVAL_MS`, `LINE_MAX_BYTES`), `casemap.ts` (`keyOf`, re-exports), `buffer.ts` (`appendLine`), `time.ts` (`formatClock`), `index.ts`
    - Add unit tests for `appendLine` and `formatClock`
    - _Requirements: 5.13, 6.1, 11.1, 11.2, 15.5_

  - [x] 2.2 Write property test for the line buffer cap
    - **Property 12: Buffers stay capped and keep the newest lines**
    - Test name `P12 buffers stay capped and keep newest lines`, cap 1 to 50, at least 100 runs
    - **Validates: Requirements 5.13, 15.5**

  - [x] 2.3 Implement the Connection_Machine
    - Create `src/irc/connection.ts` with `stepConnection(phase, event)` covering every transition in the state diagram (`connect`, `socket-open`, `welcome`, `reject`, `socket-closed`, `user-cancel`)
    - Add unit tests for each transition, including `failed` from error and close before `001`, and `disconnected` from close after `registered`
    - _Requirements: 3.4, 3.5, 3.6, 3.10, 3.11, 11.2, 17.6_

  - [x] 2.4 Implement the minimal reducer
    - Create `src/irc/reducer.ts`, `reducer.members.ts` and `reducer.route.ts` handling `001` (phase `registered`, Status_Window), `002` to `005`, `372/375/376` and server `NOTICE` to the Status_Window, own `JOIN` (open and activate Channel_Window), other `JOIN`, `353/366` members with `@` and `+` prefixes, channel `PRIVMSG` and `PING` (returns `PONG` in `send`)
    - Return `ReduceResult` (`state`, `send`, `mention`); never mutate input; unknown messages become Status_Window text
    - Add unit tests for these paths
    - _Requirements: 3.6, 3.13, 5.1, 5.2, 6.4, 9.1, 9.10, 11.3, 11.6_

  - [x] 2.5 Implement the minimal command parser
    - Create `src/irc/command-parser.ts` with `parseInput(text, ctx)` and `InputContext`: plain text to `PRIVMSG` for a Channel_Window or Query_Window, local line in the Status_Window ("no channel or query is active"), `//text`, and `/join <channel>[ <key>]` with `#` prepended when missing
    - Return `InputResult` kinds `send`, `local`, `error`, `confirm-paste`
    - Add unit tests
    - _Requirements: 7.1, 7.2, 7.3, 7.4, 7.5_

  - [x] 2.6 Implement frame decoding
    - Create `src/irc/framing.ts` with `decodeFrames(framer, frame)` wrapping `LineFramer`, returning lines or an overlong marker
    - Add unit tests for frames holding several lines and partial lines
    - _Requirements: 2.1, 2.5_

  - [x] 2.7 Write property test for chunking independence
    - **Property 11: Framing is independent of chunking**
    - Test name `P11 framing independent of chunking`; use lines with multi-byte characters and arbitrary frame partitions
    - **Validates: Requirements 2.5**

- [x] 3. Connect config and Store with socket
  - [x] 3.1 Implement connect configuration and URL validation
    - Create `src/config/connect-src.ts` with `computeConnectConfig(env)` (throws a descriptive error on a non-`ws:`/`wss:` `NEXT_PUBLIC_IRCD_WS_URL`; default `ws://127.0.0.1:6668`; development adds `ws://127.0.0.1:6668`) and `validateServerUrl(raw, allowedOrigins)` whose error names every allowed origin
    - Add unit tests
    - _Requirements: 3.1, 3.2, 3.3, 4.4, 15.6, 15.9_

  - [x] 3.2 Write property test for server URL validation
    - **Property 15: Server URL is accepted only for allowed origins**
    - Test name `P15 server url accepted only for allowed origins`
    - **Validates: Requirements 3.1, 3.2, 4.4, 17.18**

  - [x] 3.3 Implement the Store with socket and storage ports
    - Create `src/store/socket.ts` (`WebSocketLike` port and browser adapter), `storage.ts` (nick and server URL persistence port with validated reads; never the password), `client-store.ts` (`createClientStore(deps)` with `createStore`; actions `connect`, `reconnect`, `submitInput`, `setActiveWindow`, `quit`) and `react.ts`
    - On `connect`: validate nick (`isValidNick`) and URL, open the socket, on open send `PASS` (only when set), `NICK`, `USER`; decode frames with `LineFramer`, `parse`, `reduce`, send each outbound message with `serialize` as one frame; append the own `PRIVMSG` line to the Active_Window; write nick and server URL on `registered`; on `QUIT` send `QUIT` then close
    - Store is the only owner of the socket, framer and timers
    - _Requirements: 2.6, 3.4, 3.5, 3.6, 3.7, 3.14, 4.1, 4.2, 4.3, 4.5, 7.26, 11.4, 11.5_

  - [x] 3.4 Write Store tests with fake socket and storage
    - Create `src/store/client-store.test.ts`: registration frame order with and without password, `433`, `432` and `464` set the connect error, socket close before `001` yields `failed`, `PING` answered with `PONG` and no line, the password never appears in any storage call, nick and URL stored on `001`
    - Add cases that `connect` with a server URL outside the Connect_Src opens no socket and sets an error naming the allowed origins, and that a stored server URL outside the Connect_Src is ignored in favour of the default
    - Tests open no network connection and use no wall-clock sleep
    - _Requirements: 3.2, 3.5, 3.8, 3.9, 3.10, 3.13, 4.1, 4.2, 4.4, 17.6, 17.8, 17.18_

- [x] 4. Minimal UI slice
  - [x] 4.1 Build the first runnable UI
    - Create `components/ClientApp.tsx` (composition root, receives `defaultUrl` and `allowedOrigins` from the layout), a minimal `ConnectDialog.tsx` (nick, server URL, optional password, inline errors), `StatusWindow.tsx`, `ChannelWindow.tsx` with `ChatBuffer.tsx` (`role="log"`, `aria-live="polite"`, `[HH:MM]` prefix, text nodes only) and `InputLine.tsx`; update `app/layout.tsx` and `app/page.tsx` to pass the connect config
    - Components hold no IRC state and read from the Store
    - _Requirements: 3.3, 3.4, 3.6, 5.1, 5.2, 6.1, 7.1, 8.7, 11.4, 14.2_

- [x] 5. Checkpoint - First runnable slice
  - Run `pnpm --filter @seance/web typecheck` and `pnpm --filter @seance/web test`; ensure both pass
  - Manual smoke test (done by the user, not automated): start the Ircd with `IRCD_WS_ALLOWED_ORIGINS=http://localhost:3000`, run `pnpm --filter @seance/web dev`, then connect, see the Status_Window, `/join #test` and chat. Ask the user if questions arise.

- [x] 6. Complete the reducer
  - [x] 6.1 Implement mention detection
    - Create `src/irc/mention.ts` with `isMention(text, ownNick)` using whole-word matching under rfc1459 case-mapping; own lines never carry the flag
    - Add unit tests
    - _Requirements: 10.1, 10.2_

  - [x] 6.2 Write property test for mention detection
    - **Property 13: Mention detection is whole-word and case-mapped**
    - Test name `P13 mention detection whole word case mapped`
    - **Validates: Requirements 10.1, 10.2**

  - [x] 6.3 Implement line classification
    - Create `src/irc/classify.ts` exporting `KNOWN_AGENTS` (`coder`, `reviewer`, `researcher`) and `isKnownAgent(nick)` (rfc1459 case-mapped), and `classifyLine` mapping to `tool`, `tool-denied`, `exorcised`, `exorcised-kick`, `kick`, `action` and the text markers `[tool]`, `[denied]`, `[exorcised]`, `[kick]`, `[mention]`
    - A `KICK` of a Known_Agent returns kind `exorcised-kick` with `ExorcismParts` (`agent` as sent, `kicker`, `reason`) set on the Line; a `KICK` of any other nick stays `kick`
    - Add unit tests for each kind, plus the R17.19 cases: exorcism with a reason, exorcism without a reason (including a reason made only of control codes, which gives no parenthesis), the `Coder` case variant, a non-agent kick that stays `kick`, and control codes in the kicker and reason
    - _Requirements: 8.11, 8.12, 8.13, 8.14, 8.15, 8.18, 13.3, 13.5, 14.10, 17.19_

  - [x] 6.14 Write property test for kick classification
    - **Property 21: Kick classification follows the Known_Agent set**
    - Uses `formatMirc` from task 10.1 to compute the visible text, so it is scheduled in a later wave than 6.3
    - Test name `P21 kick classification follows known agent set`; targets from Known_Agent names in every case variant, unrelated nicks and near misses such as `coder2`; reasons including empty strings and control codes; check the rendered visible text contains the agent and kicker, shows the reason in parentheses only when it has a visible character, and holds no control character
    - **Validates: Requirements 8.14, 8.18**

  - [x] 6.4 Implement full member set operations
    - Extend `reducer.members.ts` for `PART`, `KICK`, `QUIT`, `NICK` and `MODE` (`±o`, `±v`) with the reference semantics from the design, keyed by `irc_lower(nick)`; drop the member set and close the window on own `PART` or `KICK`; ignore `MODE` for non-members
    - Add unit tests
    - _Requirements: 6.7, 6.8, 6.9, 6.10, 12.1, 12.3, 12.5_

  - [x] 6.5 Write property test for member sets against a reference model
    - **Property 2: Member sets match a reference model**
    - Test name `P2 member sets match reference model`; nick pool with rfc1459 case variants (`[`, `]`, `\`, `~`)
    - **Validates: Requirements 6.4, 6.7, 6.8, 6.9, 6.10, 12.1, 12.2, 12.3, 12.5, 17.3**

  - [x] 6.6 Route channel, query and mode events
    - Extend `reducer.route.ts` and `reducer.ts`: `331/332/TOPIC` topic bar text or placeholder, mode change lines, quit lines with reason, `NICK` renaming in channels and Query_Windows, own `PART` and `KICK` with `closedLines` and Status_Window activation, Query_Window opening on `PRIVMSG` and `NOTICE` to the own nick (not activated), `unread` and `mentioned` flags, `INVITE`, `305/306`, `NOTICE` routing, mention flag via `isMention`, line kinds via `classifyLine`
    - Reopening a closed Channel_Window restores its kept lines
    - _Requirements: 5.3, 5.5, 5.12, 6.2, 6.3, 6.8, 6.10, 8.13, 8.14, 9.7, 9.8, 9.9, 10.1, 13.2, 13.5_

  - [x] 6.7 Route WHOIS, LIST, NAMES and error numerics
    - Create `src/irc/reducer.whois.ts` collecting `311/319/312/320/317/301` per nick and emitting one block on `318`; `401` replaces the block with an error line; `322/323` rows to the Status_Window; user-issued `/names` prints one line (`expectingNames`); `4xx/5xx` answers to user commands shown in the Active_Window; `432/433/464` while `registering` set `connectError` without a window line
    - _Requirements: 3.8, 3.9, 9.2, 9.3, 9.4, 9.5, 9.6, 13.4_

  - [x] 6.8 Implement the reconnect reset
    - Create `src/irc/reset.ts` with `resetForReconnect(state)`: keep every window's lines, clear members, topics and `whoisPending`, set phase `connecting`
    - Call it from the `reconnect` action in `client-store.ts`
    - Add unit tests
    - _Requirements: 3.12, 3.15_

  - [x] 6.9 Write property test for the reconnect reset
    - **Property 18: Reconnect reset keeps text and drops membership**
    - Test name `P18 reconnect reset keeps text drops membership`
    - **Validates: Requirements 3.15**

  - [x] 6.10 Write property test for reducer totality and purity
    - **Property 1: Reducer is total and pure**
    - Test name `P1 reducer is total and pure`; arbitrary parsed messages (unknown commands, missing parameters, empty prefixes, up to 15 parameters, arbitrary Unicode) against deep-frozen state and message; check state invariants
    - **Validates: Requirements 11.3, 11.6, 17.2**

  - [x] 6.11 Write property test for silent PING handling
    - **Property 17: PING is answered silently**
    - Test name `P17 ping answered silently`
    - **Validates: Requirements 3.13**

  - [x] 6.12 Write property test for unread and mention flags
    - **Property 19: Unread and mention flags follow the active window**
    - Test name `P19 unread and mention flags follow active window`
    - **Validates: Requirements 5.12**

  - [x] 6.13 Write routing unit tests
    - Cover `/list`, `/names`, `305/306`, `INVITE`, `NOTICE` to the own nick, server `NOTICE`, unknown numeric, WHOIS grouping interleaved with channel lines, `401` replacement, agent `MODE` changes, agent `KICK` rendered as an exorcism (`exorcised-kick` with agent, kicker and reason), non-agent `KICK` staying a plain kick, exorcism `PART`, own `PART` closing and reopening a window
    - _Requirements: 5.5, 8.18, 9.1, 9.2, 9.3, 9.4, 9.5, 9.6, 9.7, 9.8, 9.9, 9.10, 13.2, 13.4, 13.5, 17.6, 17.19_

- [x] 7. Complete the command parser
  - [x] 7.1 Implement paste splitting
    - Create `src/irc/paste.ts` with `splitPaste(text)` and `PASTE_LIMITS`: split on CRLF, LF and CR, discard empty lines
    - Add unit tests for splitting and limits
    - _Requirements: 7.17, 7.19, 17.15_

  - [x] 7.2 Implement the full command set
    - Extend `command-parser.ts`: `/part`, `/msg`, `/topic`, `/invite`, `/kick`, `/mode`, `/whois`, `/names`, `/list`, `/away`, `/nick`, `/quit`, `/me` (CTCP ACTION), `/query` (with and without text), default channel from the Active_Window, usage errors for missing arguments, raw pass-through with upper-case command, 512-byte limit in UTF-8 bytes, NUL refusal, control-character refusal for raw commands, single-line rule for commands, multi-line text to one `PRIVMSG` per line, `confirm-paste` above 5 lines
    - _Requirements: 7.3, 7.4, 7.5, 7.6, 7.7, 7.8, 7.9, 7.10, 7.11, 7.13, 7.14, 7.15, 7.16, 7.17, 7.19_

  - [x] 7.3 Write property test for protocol round-trip of produced messages
    - **Property 6: Parsed input round-trips through the protocol**
    - Test name `P6 parsed input round trips through protocol`
    - **Validates: Requirements 7.4, 7.12, 17.5**

  - [x] 7.4 Write property test for control-character-free output
    - **Property 7: No produced line contains CR, LF or NUL**
    - Test name `P7 no produced line contains CR LF or NUL`; arbitrary text with control characters anywhere, with and without a leading `/`
    - **Validates: Requirements 7.13, 7.14, 7.15, 7.16, 7.22, 17.14**

  - [x] 7.5 Write property test for the UTF-8 byte limit
    - **Property 8: Byte limit is enforced in UTF-8 bytes**
    - Test name `P8 byte limit enforced in utf8 bytes`; lengths around 512 with multi-byte characters
    - **Validates: Requirements 7.11**

  - [x] 7.6 Write property test for multi-line paste splitting
    - **Property 9: Multi-line paste splits into plain messages**
    - Test name `P9 multi-line paste splits into plain messages`
    - **Validates: Requirements 7.17, 7.19**

  - [x] 7.7 Write property test for unknown slash commands
    - **Property 10: Unknown slash commands pass through unchanged**
    - Test name `P10 unknown slash commands pass through`
    - **Validates: Requirements 7.9**

  - [x] 7.8 Write command parser unit tests
    - Cover every command in the requirement list with defaults from the Active_Window, `#` prepend, `/me` wrap, `/query` local action, `//text`, NUL refusal, Raw_Command refusal with CR/LF/NUL, multi-line command refusal, paste of 1 to 5 lines and above 5 lines
    - _Requirements: 7.1, 7.2, 7.3, 7.4, 7.5, 7.6, 7.7, 7.8, 7.10, 7.14, 7.15, 7.16, 7.17, 7.19, 17.15_

- [x] 8. Checkpoint - Core complete
  - Run `pnpm --filter @seance/web typecheck` and `pnpm --filter @seance/web test`; ensure all tests pass, ask the user if questions arise.

- [x] 9. Paste queue in the Store
  - [x] 9.1 Implement the Paste_Queue and confirmation flow
    - Extend `client-store.ts` with `confirmPaste(accept)`: first message sent at once, then one per 500 ms through a Store-owned `setTimeout` chain; pastes above 5 lines create a pending paste and a Paste_Confirmation line; confirm sends at most 5 lines and reports dropped lines; decline or socket close empties the queue and reports unsent count; the core has no timer
    - _Requirements: 7.18, 7.19, 7.20, 7.21_

  - [x] 9.2 Write Paste_Queue tests with fake timers
    - Use `vi.useFakeTimers()`: immediate first message, 500 ms pacing, more than 5 lines needs confirmation, 5 sent and drop count line, decline and disconnect empty the queue; no real timer
    - _Requirements: 7.18, 7.19, 7.20, 17.15, 17.16_

- [x] 10. Formatter, linkify, ordering, history and completion
  - [x] 10.1 Implement the Formatter
    - Create `src/irc/formatter.ts` with `formatMirc(text)`: colour codes 0 to 15 with optional background, bold, underline, reset, bare `\x03` reset, out-of-range digits consumed without colour, tab to space, other control characters and 0x7f dropped
    - Add unit tests for the colour table and edge cases
    - _Requirements: 8.1, 8.2, 8.3, 8.4, 17.6_

  - [x] 10.2 Write property test for visible character preservation
    - **Property 4: Formatter preserves every visible character**
    - Test name `P4 formatter preserves visible characters`
    - **Validates: Requirements 8.4, 8.5, 17.4**

  - [x] 10.3 Write property test for control-code-free spans
    - **Property 5: Formatter emits no control codes**
    - Test name `P5 formatter emits no control codes`
    - **Validates: Requirements 8.1, 8.4, 8.6, 17.4**

  - [x] 10.4 Implement linkification
    - Create `src/irc/linkify.ts` with `linkify(text)`: `http` and `https` become link segments, every other scheme (`javascript:`, `data:`) stays text; handle trailing punctuation
    - Add unit tests
    - _Requirements: 8.8, 8.9, 17.6_

  - [x] 10.5 Write property test for linkify
    - **Property 14: Linkify keeps the text and links only http and https**
    - Test name `P14 linkify keeps text and links only http https`
    - **Validates: Requirements 8.8, 8.9**

  - [x] 10.6 Implement nick ordering
    - Create `src/irc/nick-order.ts` with `sortMembers` (operators, voiced, others; alphabetical under rfc1459 within each group) and a prefix helper (`@` wins over `+`)
    - Add unit tests
    - _Requirements: 6.5, 6.6, 13.1_

  - [x] 10.7 Write property test for nick ordering
    - **Property 3: Nick list ordering is a permutation grouped by rank**
    - Test name `P3 nick order permutation grouped by rank`
    - **Validates: Requirements 6.5, 6.6, 12.4, 13.1**

  - [x] 10.8 Implement command history
    - Create `src/irc/history.ts` with bounded `pushHistory` and `navigate` (100 entries, draft position)
    - Add unit tests
    - _Requirements: 7.23_

  - [x] 10.9 Write property test for bounded history
    - **Property 20: Command history is bounded**
    - Test name `P20 command history is bounded`
    - **Validates: Requirements 7.23**

  - [x] 10.10 Implement nick completion
    - Create `src/irc/complete.ts` with `completeNick(input, caret, nicks, cycle)`: completes a partial word, cycles on repeated calls, appends `: ` at the start of the line
    - Add unit tests
    - _Requirements: 7.24, 7.25_

- [x] 11. Complete the UI
  - [x] 11.1 Render chat lines with styles
    - Create `ChatLine.tsx` and `Spans.tsx`: formatter spans mapped to fixed `text-irc-N` classes (full literals, no inline style), linkified anchors with `target="_blank"` and `rel="noopener noreferrer"`, nick colours (`coder`, `reviewer`, `researcher`, human) chosen with `isKnownAgent` imported from `classify.ts` (no second agent list), `* nick text` for actions, distinct tool and denied styles, highlighted kick and exorcism lines, accent-orange mention highlight, text markers next to colour; update `ChatBuffer.tsx`
    - Render the `exorcised-kick` line as `*** <agent> has been exorcised by <kicker>` plus ` (<reason>)` only when the reason has a visible character: fixed pieces as React text nodes, and agent, kicker and reason each run through `formatMirc` and rendered as spans; exorcism style and the `[exorcised]` marker; no string-built markup
    - _Requirements: 6.1, 8.1, 8.2, 8.7, 8.8, 8.9, 8.10, 8.11, 8.12, 8.13, 8.14, 8.15, 8.16, 8.17, 8.18, 14.10_

  - [x] 11.2 Build the Topic_Bar and Nick_List
    - Create `TopicBar.tsx` (topic text or no-topic placeholder) and `NickList.tsx` (`role="list"`, accessible name with channel and member count, sorted via `sortMembers`, `@` and `+` prefixes, visible member count); update `ChannelWindow.tsx`
    - _Requirements: 6.2, 6.3, 6.5, 6.6, 6.11, 13.1, 14.7_

  - [x] 11.3 Build the MDI, window frame, switchbar and shortcuts
    - Create `Mdi.tsx` (CSS grid, no inline styles), `WindowFrame.tsx` (Win95 title bar with gradient and close control), `QueryWindow.tsx`, `Switchbar.tsx` (one button per window, active, unread and mention state in the accessible name), `MenuBar.tsx`, `Toolbar.tsx`, `StatusBar.tsx`; add Store actions `closeWindow` and `activateByIndex`; make the `/query` local action and `/msg` with text open and activate a Query_Window through the Store; `Alt+n` switches windows, `Esc` closes a dialog and returns focus to the Input_Line, activating a window clears its unread marker
    - _Requirements: 5.3, 5.4, 5.6, 5.7, 5.8, 5.9, 5.10, 5.11, 14.4, 14.8_

  - [x] 11.4 Add history and Tab completion to the Input_Line
    - Update `InputLine.tsx`: `Up` and `Down` through history, `Tab` completion and cycling with nicks of the Active_Window, submit through `submitInput`
    - _Requirements: 7.23, 7.24, 7.25_

  - [x] 11.5 Build the WHOIS block and Paste_Confirmation
    - Create `WhoisBlock.tsx` (grouped block with away text and the `320` lines) and `PasteConfirmation.tsx` (line count, confirm and decline by keyboard); render both inside `ChatBuffer`
    - _Requirements: 7.19, 9.2, 9.3, 13.4_

  - [x] 11.6 Complete the Connect_Dialog
    - Update `ConnectDialog.tsx`: `role="dialog"`, `aria-modal="true"`, labelled title and fields, inline errors linked with `aria-describedby`, focus on the first empty field and back to the Input_Line on close, nick and URL prefill from validated storage, errors for invalid nick, disallowed origin (naming allowed origins), `433`, `432`, `464`, socket failure (naming server down, wrong URL and the origin check), Reconnect button and "connection closed" Status_Window line, keyboard-only operation
    - _Requirements: 3.2, 3.7, 3.8, 3.9, 3.10, 3.11, 3.12, 4.3, 4.4, 14.4, 14.5, 14.6, 16.4_

  - [x] 11.7 Add the optional mention sound
    - Add `setMentionSound(enabled)` to the Store with an injected `audio` dependency; off by default; audio starts only after a user gesture; add a toggle in the menu bar and a unit test with a fake audio
    - _Requirements: 10.3, 10.4, 10.5_

  - [x] 11.8 Write Store boundary tests
    - Cover a binary frame (ignored with a diagnostic line), a frame above 64 KiB (socket closed, error line), an unparsable line and an overlong line (discarded with a diagnostic, later lines still processed), a faulty reducer injected so the error line names the step and command and processing continues, `serialize` failure, invalid stored values ignored, reconnect keeping Chat_Buffers
    - _Requirements: 3.15, 4.4, 11.7, 11.8, 15.4, 15.7_

  - [x] 11.9 Write component tests
    - jsdom tests: Chat_Buffer `role="log"` and `aria-live="polite"`, Nick_List role and accessible name, Switchbar names with unread state, `Alt+n`, `Esc`, `Tab` completion with `: `, Connect_Dialog refuses a disallowed origin and ignores a stored disallowed origin, `aria-describedby` links, focus on the first empty field
    - _Requirements: 5.10, 5.11, 7.24, 7.25, 14.2, 14.5, 14.6, 14.7, 14.8, 17.18_

- [x] 12. Checkpoint - Client feature complete
  - Run `pnpm --filter @seance/web typecheck`, `pnpm --filter @seance/web test` and `pnpm --filter @seance/web lint`; ensure all pass, ask the user if questions arise.

- [x] 13. Content-Security-Policy and request proxy
  - [x] 13.1 Implement the CSP builder
    - Create `src/config/csp.ts` with `buildCsp({ nonce, connectOrigins, dev })` following the directive table in the design: production `script-src` has the nonce and `'strict-dynamic'`, neither `'unsafe-inline'` nor `'unsafe-eval'`; `connect-src` is `'self'` plus the Connect_Src origins; `object-src 'none'`, `frame-ancestors 'none'`, no `upgrade-insecure-requests`
    - _Requirements: 15.3, 15.8, 15.9_

  - [x] 13.2 Write property test for the CSP builder
    - **Property 16: CSP header holds the required nonce and origins**
    - Test name `P16 csp header holds nonce and origins`; production and development modes; also calls the `proxy` function from task 13.3 twice and checks the nonces differ (scheduled after 13.3)
    - **Validates: Requirements 15.3, 15.8, 15.9, 15.10, 17.17**

  - [x] 13.3 Implement `proxy.ts` and nonce-aware layout, with tests
    - Create `proxy.ts` (Next.js 16, function `proxy`, `crypto.randomUUID` nonce via `btoa`, sets `x-nonce` and `Content-Security-Policy` on request and response, matcher skipping static assets and prefetches, headers only); make `app/layout.tsx` read the nonce from `headers()` so the page renders dynamically
    - Create `proxy.test.ts`: two calls in a production environment both carry a CSP whose `script-src` holds a nonce and neither `'unsafe-inline'` nor `'unsafe-eval'`, the nonces differ, and `connect-src` equals the Connect_Src
    - _Requirements: 1.5, 15.3, 15.8, 15.9, 15.10, 17.17_

- [x] 14. Accessibility and static checks
  - [x] 14.1 Add accessibility behaviour and contrast test
    - Add `prefers-reduced-motion: reduce` rules disabling animations and transitions, visible focus styles on every interactive element, keyboard reachability of connect, window switching, close, send and Reconnect; add a vitest test computing WCAG contrast ratios (4.5:1 body text, 3:1 large text and UI boundaries) for each documented text and background token pair on chrome and ghost surfaces
    - _Requirements: 14.1, 14.3, 14.4, 14.9_

  - [x] 14.2 Add static safety checks
    - Add a vitest test scanning `app/` and `src/` for `dangerouslySetInnerHTML`, `innerHTML`, `eval`, inline `style` props, hex colours in components and the word "mIRC"; ensure no `app/api` directory or route handler exists; ensure no code path passes message text to `parseInput`
    - _Requirements: 1.5, 1.8, 8.7, 8.16, 15.1, 15.2_

  - [x] 14.3 Add extra accessibility niceties
    - Add a skip link to the Input_Line and a screen-reader-only announcement when a window becomes unread; add a test for each
    - _Requirements: 14.4, 14.8_

- [x] 15. Documentation
  - [x] 15.1 Write the web README and environment documentation
    - Create `apps/web/README.md` (run against a local Ircd, required `IRCD_WS_ALLOWED_ORIGINS`, list the origin in use because `localhost` and `127.0.0.1` differ, unit tests, e2e command, note that `NEXT_PUBLIC_IRCD_WS_URL` is inlined at build time) and `apps/web/.env.example` with `NEXT_PUBLIC_IRCD_WS_URL` and `IRCD_WS_ALLOWED_ORIGINS` (no secrets, comment that changing the URL changes the CSP `connect-src` and that its origin is the only non-local WebSocket origin accepted); add the same two variables to the root README environment section
    - _Requirements: 16.1, 16.5, 18.2_

  - [x] 15.2 Update DESIGN.md and steering to Next.js 16
    - Change "Next.js 15" to "Next.js 16" in `DESIGN.md` section 11 and in `.kiro/steering/tech.md`
    - _Requirements: 1.7_

- [x] 16. End-to-end test (opt-in)
  - [x] 16.1 Spike: import the Ircd in-process under Playwright
    - Write a throwaway check in `apps/web/e2e/harness/` that imports `createServer`, `loadConfig` and `createIrcHost` from `apps/ircd/src` by relative path under the Playwright TypeScript loader and starts and stops a server on port 0
    - If `.js` specifiers pointing at `.ts` sources do not resolve, document the fallback (spawn the Ircd as a child process with the same environment and read its listening ports from its start-up log line) in the harness header comment and use it
    - _Requirements: 17.10, 17.13_

  - [x] 16.2 Build the e2e stack harness and Playwright config
    - Create `e2e/playwright.config.ts`, `e2e/harness/free-port.ts` and `e2e/harness/stack.ts`: pick free web and WebSocket ports, start the Ircd (`IRCD_TCP_PORT=0`, `IRCD_WS_PORT`, `IRCD_HOST=127.0.0.1`, `IRCD_WS_ALLOWED_ORIGINS=http://127.0.0.1:<webPort>`), start the Runner with `SEANCE_KIRO_BIN=apps/runner/test/fixtures/fake-kiro`, a temporary target repository and workspaces directory, a copy of `agents/`, and a `childEnv` that passes only `FAKE_AGENT_*` through the allow-list as the Ircd integration tests do, with `FAKE_AGENT_SCRIPT` holding a turn that replies to the human message; run `next build` with `NEXT_PUBLIC_IRCD_WS_URL=ws://127.0.0.1:<wsPort>` then `next start -p <webPort>`; teardown stops every process and socket and removes temporary directories
    - Ensure `pnpm test` does not run e2e and `test:e2e` is not a turbo task
    - _Requirements: 17.9, 17.10, 17.13_

  - [x] 16.3 Write the chat flow e2e spec
    - Create `e2e/flow.spec.ts`: connect as `op1`, `/join #flow`, `/invite coder #flow`, `/mode #flow +v coder`, send a message, assert a reply from `coder` whose nick element carries the `coder` colour class; then `/kick coder begone` and assert the highlighted line `*** coder has been exorcised by op1 (begone)` (with the `[exorcised]` marker) and that `coder` is absent from the Nick_List
    - The successful connection from the allowed web origin also shows that the Ircd accepts an allowed origin
    - _Requirements: 8.18, 13.1, 13.2, 13.3, 13.5, 16.3, 17.11, 17.12_

  - [x] 16.4 Write the CSP e2e spec
    - Create `e2e/csp.spec.ts`: two requests to `/` against `next start` both carry a CSP; nonces differ; `script-src` holds the nonce and neither `'unsafe-inline'` nor `'unsafe-eval'`; `connect-src` equals `'self' ws://127.0.0.1:<wsPort>`; no CSP violation console message during the flow
    - Also open a WebSocket to the Ircd from Node with an `Origin` header outside `IRCD_WS_ALLOWED_ORIGINS` and assert the upgrade is refused
    - _Requirements: 15.3, 15.8, 15.9, 16.2, 17.17_

- [x] 17. Kiro usage log
  - [x] 17.1 Record Kiro usage for this spec
    - Add an entry to `docs/KIRO_USAGE.md` covering spec creation, steering files, agents, hooks and Figma or Playwright tooling used for web-client-basic, and map the Figma frames `01 Main`, `02 Connect`, `03 Kick` and the Whois panel of `04 Whois+Options` to components as in the design
    - _Requirements: 18.1, 18.3_

- [x] 18. Final checkpoint - Ensure all tests pass
  - Run `pnpm --filter @seance/web typecheck`, `pnpm --filter @seance/web test` and `pnpm --filter @seance/web lint`, then try the root `pnpm typecheck && pnpm test` (report if turbo times out and fall back to per-package runs). Ensure all tests pass, ask the user if questions arise.

## Notes

- Tasks marked with `*` are optional polish and can be skipped for the demo: the mention sound, the component tests and extra accessibility niceties.
- All property tests (P1 to P20), the CSP header test, the no-CR/LF/NUL property and the e2e specs are not optional.
- Each property test sits in its own file so property tasks can run in parallel.
- The manual smoke test in task 5 needs the user to start the Ircd and the dev server; automated tasks never start long-running servers.
- Open points from the design (no exorcism line after `/kick`, build-time inlining of `NEXT_PUBLIC_IRCD_WS_URL`, Figma details to read at implementation time) are handled inside the tasks above.

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1.1"] },
    { "id": 1, "tasks": ["1.2"] },
    { "id": 2, "tasks": ["1.3", "2.1", "3.1", "13.1"] },
    { "id": 3, "tasks": ["2.2", "2.3", "2.6", "3.2", "6.1", "6.3", "7.1", "10.1", "10.4", "10.6", "10.8"] },
    { "id": 4, "tasks": ["2.4", "2.5", "2.7", "6.2", "10.2", "10.3", "10.5", "10.7", "10.9", "10.10", "6.14"] },
    { "id": 5, "tasks": ["3.3", "6.4", "7.2"] },
    { "id": 6, "tasks": ["3.4", "4.1", "6.5", "6.6", "7.3", "7.4", "7.5", "7.6", "7.7", "7.8"] },
    { "id": 7, "tasks": ["6.7", "6.8", "11.1", "11.2", "11.4", "11.6", "13.3", "15.1", "15.2"] },
    { "id": 8, "tasks": ["6.9", "6.10", "6.11", "6.12", "6.13", "9.1", "13.2"] },
    { "id": 9, "tasks": ["9.2", "11.3", "11.5", "11.8"] },
    { "id": 10, "tasks": ["11.7", "11.9", "14.1", "14.3", "16.1"] },
    { "id": 11, "tasks": ["14.2", "16.2"] },
    { "id": 12, "tasks": ["16.3", "16.4"] },
    { "id": 13, "tasks": ["17.1"] }
  ]
}
```
