# Implementation Plan: web-client-pixel-match

## Overview

Order: spikes and assets first, then the pure rules (colours, event lines, empty lines, modes), then the shell and its parts at 1440x900, then the responsive layers, then the fixture and the screenshot tests, then docs and the manual check. Each property test carries its design ID (`P1` to `P7`) in its name. Verify per package (`pnpm --filter @seance/web typecheck`, `... test`, `... lint`; `pnpm --filter @seance/ircd test`), because root turbo runs may time out in this environment; rebuild the runner (`pnpm --filter @seance/runner build`) before ircd tests that import it. Read `apps/web/node_modules/next/dist/docs/` for any Next API before using it (the web `AGENTS.md` warns that this version differs). `SEANCE_E2E_FIXTURES` and `SEANCE_DIST_DIR` are the only new variables. No new npm dependency. Never delete a test to make it pass; change a test only where a requirement intentionally changes behaviour, and say why in the commit. Fixing a bug starts with a failing test. Keep `static-safety.test.ts` green: no `style=`, no `innerHTML`.

## Tasks

- [x] 0.0 Copy the 23 Figma icon SVGs to `apps/web/design/figma-icons/` (done while writing this spec)

- [x] 0. Spikes and inputs
  - [x] 0.1 Export Frame_01 (1:1093) at scale 1 as PNG and commit it as `apps/web/e2e/figma/01-main-1440x900.png`
    - The Talk-to-Figma export returns the image inline only; use Figma's own Export (File, Export, scale 1x) or the Figma power `get_screenshot`, then save the file; check it is 1440x900
    - _Requirements: 14.2_
  - [x] 0.2 Read the Next.js docs in `node_modules/next/dist/docs/` for `pageExtensions`, `distDir`, app-router file conventions and `notFound`; note any difference from the plan in `design.md`
    - _Requirements: 13.4, 13.5_
  - [x] 0.3 Scrollbar spike: a static HTML page with `::-webkit-scrollbar` parts using the sliced SVG paths as data-URI backgrounds and a `border-image` thumb; check Chromium and Safari; decide D6 and record the result in `design.md`
    - Done in Chromium (result in `design.md` Open Point 6: `:single-button` draws no arrows, `:start:decrement`/`:end:increment` does; box-shadow thumb). Safari (WebKit not installed) and the pressed arrows are left to the manual check (task 11)
    - _Requirements: 7.2, 7.3_
  - [x] 0.4 Re-run the gap comparison list against the app screenshot and the Figma_Export and add any gap not in `requirements.md` to the Open Points
    - _Requirements: 15.1_

- [x] 1. Assets, tokens, colours
  - [x] 1.1 Add `apps/web/scripts/gen-icons.mjs`; generate `src/components/icons/*.tsx` and `index.ts` for the 23 files with the slices of Requirement 3.4
    - Strip `width`/`height`, add `shape-rendering="crispEdges"`, `aria-hidden="true"`, `focusable="false"`; `currentColor` only for `mdi-child-channel` and `switch-channel`; slices keep path data unchanged
    - _Requirements: 3.1 to 3.4_
  - [x] 1.2 Draw and add the extra icons listed in `design.md` (researcher ghost, four pressed buttons, four pressed scroll arrows, overflow chevrons, query child icon) as SVG files in `design/figma-icons-extra/` and generate components from them
    - _Requirements: 3.5_
  - [x] 1.3 Replace `Icon` and its callers with the new components; delete `Icon.tsx` and update `Icon.test.tsx` to the new set
    - _Requirements: 3.6, 3.7_
  - [x] 1.4 Write **Property 1: Icon fidelity** (`P1 icon fidelity`) over all source files
    - _Requirements: 3.8_
  - [x] 1.5 Add layout tokens to `app/globals.css` and `src/layout/metrics.ts` (same numbers); write **Property 7: Layout sum** (`P7 layout sum`) comparing the CSS tokens to the TypeScript constants and the sum to 900 and 870
    - _Requirements: 1.1, 1.8_
  - [x] 1.6 Write `scripts/irc-palette.mjs`; update `--color-irc-N` in `globals.css`; add `src/irc/colors.ts` with `readableClass`; use it in `Spans.spanClass`
    - Test first: the current palette fails for index 2 and 12
    - _Requirements: 10.1, 10.2, 10.5_
  - [x] 1.7 Write **Property 2: Readable colours** (`P2 readable colours`) for the 16 foregrounds and 256 pairs; extend `contrast.test.ts` with the new tokens
    - _Requirements: 10.3, 10.4_
  - [x] 1.8 Switch the human nick colour to Figma's `#e08a2e`
    - `--color-nick-human` in `app/globals.css`; in `.kiro/steering/web-ui.md` drop "human nicks" from the accent orange row and set the `Humans` row of the nick colour table to `#e08a2e`; `--color-ghost-orange` stays `#c8761f`
    - `contrast.test.ts` keeps the `nick-human` on `ghost-bg` pair (7.34:1)
    - _Requirements: 6.5_

- [x] 2. Reducer and line rules
  - [x] 2.1 Add `EVENT_LINE_KINDS` and the `invite` kind; map `341` and `INVITE` in `reducer.ts`; use the constant in `ChatLine.lineClass`
    - Test first: `341` currently lands in Status as a numeric line
    - _Requirements: 6.1 to 6.3_
  - [x] 2.2 Write **Property 3: Event colour** (`P3 event colour`)
    - _Requirements: 6.1, 6.3_
  - [x] 2.3 Reject invisible lines in `appendTo`/`appendStatus` for the listed kinds; keep `WhoisLines` unchanged and add a test to `WhoisLines.test.tsx` that the first and last rows of the block are the `[hh:mm] -` separators of Frame 04
    - Test first: a `NOTICE` with only control codes currently adds a row
    - _Requirements: 9.1, 9.2_
  - [x] 2.4 Write **Property 4: No empty lines** (`P4 no empty lines`)
    - _Requirements: 9.3_

- [x] 3. Ircd: channel modes `n` and `t`
  - [x] 3.1 Extend `ChannelRegistry.modes`, `canSpeak`, `topic.ts`, `mode.ts` (`groupChanges`, no-op filtering), `324` and `004`
    - Test first: `MODE #c +mnt` currently answers `472`
    - _Requirements: 12.1 to 12.7_
  - [x] 3.2 Keep `irc.mode` for `o`, `v`, `m` only; confirm `runner-wiring.ts` still typechecks
    - _Requirements: 12.8_
  - [x] 3.3 Update existing ircd tests that assert `324 +` or one `MODE` per flag, with the reason in each changed test
    - _Requirements: 12.10_
  - [x] 3.4 Write **Property 5: Modes** (`P5 channel modes match model`) in `apps/ircd/test`
    - _Requirements: 12.2 to 12.5_
  - [x] 3.5 Update `DESIGN.md` §3 (`+n`, `+t`, defaults, grouped `MODE`) and the `irc-protocol` skill's mode list
    - _Requirements: 12.10_

- [x] 4. Checkpoint: `pnpm --filter @seance/irc-protocol test`, `pnpm --filter @seance/ircd test`, `pnpm --filter @seance/web test`

- [x] 5. Shell at 1440x900
  - [x] 5.1 Build the grid `Shell` with the frame bevel, region rows, gaps and the optional tray row; add `.bevel-frame`, `.bevel-field`
    - _Requirements: 1.1, 1.4, 1.5, 1.8_
  - [x] 5.2 Remove the `MdiChild` header; add the child icon and child buttons (with pressed icons) to `MenuBar`; make restore `aria-disabled` with its title
    - Tests first: the existing tests that look for `mdi-title` change with the requirement
    - _Requirements: 2.1 to 2.3, 2.7_
  - [x] 5.3 Move the topic bar into the shell as `TopicField`; absent for Status and query
    - _Requirements: 2.5, 2.6_
  - [x] 5.4 Title bar: app candle icon, caption buttons from the new icons, title via `titleOf`
    - _Requirements: 2.4, 3.1_
  - [x] 5.5 Toolbar: item list, separators, offsets, label; keep roving focus
    - _Requirements: 4.1 to 4.6_
  - [x] 5.6 Menus: enable Favorites with the single disabled item; slot widths
    - _Requirements: 5.1 to 5.3_
  - [x] 5.7 Chat pane bevel and the always-visible scrollbar from spike 0.3; Firefox fallback
    - _Requirements: 7.1 to 7.6_
  - [x] 5.8 Switchbar icons and states; credits panel with candle slice and HTML text; tray bar 176x24; status bar panel widths
    - _Requirements: 1.6, 1.7, 8.1 to 8.3_
  - [x] 5.9 Nick list: new ghost icons and away glyph, row pitch 22, footer position
    - _Requirements: 1.2, 3.7_
  - [x] 5.10 Component tests for 5.1 to 5.9 (class-based geometry, order, ARIA)
    - _Requirements: 1.8, 2.7, 4.6_

- [x] 6. Responsive layers
  - [x] 6.1 `useFit` and menu overflow (`»` menu, submenu keyboard behaviour); write **Property 6: Menu fit** (`P6 menu fit`)
    - _Requirements: 11.4_
  - [x] 6.2 `NickOverlay` with store flag, focus handling, Escape and outside tap; toolbar agents button behaviour per breakpoint
    - _Requirements: 4.5, 11.4_
  - [x] 6.3 Medium: nick list 140 px, status bar panels scale; Compact: toolbar label hidden, status bar two panels, switchbar horizontal scroll, credits compact, topic truncation with `title`
    - _Requirements: 11.2 to 11.4_
  - [x] 6.4 `useVisualViewport` and `--app-height`; viewport meta in `app/layout.tsx`
    - _Requirements: 11.5, 11.7_
  - [x] 6.5 Coarse-pointer hit areas by padding or pseudo-element; no change on fine pointers
    - _Requirements: 11.6_
  - [x] 6.6 Component tests for the Compact behaviour (jsdom with an injected `matchMedia` and `ResizeObserver`)
    - _Requirements: 11.1, 11.4_

- [x] 7. Checkpoint: `pnpm --filter @seance/web typecheck`, `test`, `lint`, then `pnpm --filter @seance/web build`

- [x] 8. Fixture
  - [x] 8.1 Add `src/fixtures/figma-01-main.ts` (IRC lines of Frame_01) and `src/fixtures/shell.tsx`; unit-test that the store ends in the Frame_01 state (windows, members, modes, topic, credits, away, minimised)
    - _Requirements: 13.1 to 13.3_
  - [x] 8.2 Add `app/fixtures/01-main/page.fixture.tsx`; update `next.config.ts` (`pageExtensions`, `distDir`); add `.next-e2e` to `.gitignore`
    - _Requirements: 13.4, 13.5_
  - [x] 8.3 Update `e2e/harness/stack.ts` to build and start with `SEANCE_E2E_FIXTURES=1` and `SEANCE_DIST_DIR=.next-e2e`
    - _Requirements: 13.5_
  - [x] 8.4 Add the bundle test: a normal `pnpm build` output has no `SEANCE_FIXTURE_01_MAIN`; the e2e output has it
    - _Requirements: 13.6_

- [x] 9. Screenshot tests
  - [x] 9.1 Add `e2e/pixel.spec.ts` and the five Playwright projects; geometry, overflow, hit-area and CSP checks
    - _Requirements: 14.1, 14.3 to 14.5_
  - [x] 9.2 Generate the five app baselines; add the separate 1440 Figma comparison, skipped with "Figma export missing" while `e2e/figma/01-main-1440x900.png` is absent; when the file exists, run it with `maxDiffPixelRatio: 1`, record the measured ratio, set the limit, write it in `design.md` Open Point 7; add the masks
    - _Requirements: 14.2, 14.6_
  - [x] 9.3 Run the existing e2e specs (`csp`, `flow`, `smoke`) against the new build; fix any selector that changed
    - _Requirements: 13.7, 14.7_

- [x] 10. Docs
  - [x] 10.1 Update `DESIGN.md` §3 and the web section: layout metrics link, Compact behaviour, modes; update `.kiro/steering/web-ui.md` with the Compact rules and the icon source of truth
    - _Requirements: 12.10_
  - [x] 10.2 Update `apps/web/README.md`: how to regenerate icons, how to update baselines, the two new variables
    - _Requirements: 14.6_
  - [x] 10.3 Case-insensitive search for the forbidden trademark term (built from two fragments) over the changed files and this spec
    - _Requirements: 15.3_
  - [x] 10.4 Add the Kiro features used to `docs/KIRO_USAGE.md`
    - _Requirements: 15.4_

- [ ] 11. Manual side-by-side check (record the result in the pull request)
  - [ ] 11.1 Frame 01: open the Fixture at 1440x900 next to the Figma export. Check: 3 px frame; title bar candle and three buttons; menu bar `#` icon at the left and three buttons at the right; seven menus aligned with the mockup; toolbar order and separators; topic text colours; chat line colours (all `***` green); the mention row; nick list rows, ghosts and footer; scrollbar arrows; input caret; tray bar; switchbar icons and bold active; credits panel; status bar panels
    - Also (left open by spike 0.3): the pressed scrollbar arrows while held, and the scrollbar in Safari
  - [ ] 11.2 Frame 02: connect, then compare the Status window (MOTD art, `372` rows)
  - [ ] 11.3 Frame 03: kick `coder` and compare the exorcism line and the nick list
  - [ ] 11.4 Frame 04: run `/whois coder` and compare the block, including the two `[hh:mm] -` separators
  - [ ] 11.5 Resize through 1440, 1280, 1024, 900, 768, 600, 390, 360 and check by eye: no horizontal scroll, the `»` menu, the overlay, the keyboard case on a phone or in device emulation with the keyboard shown

- [x] 12. Final checkpoint
  - Run `pnpm build`, `pnpm typecheck`, `pnpm lint`, `pnpm test --force`, then `pnpm test:e2e` (apps/web)

## Notes

- Decisions of 2026-11-08: WHOIS separators stay (Requirement 9); `+nt` default stays; human nick `#e08a2e`; the contrast lifts for timestamp, away grey and inactive caption stay; Open Points 4 to 9 of `design.md` accepted.
- Task 0.1 (Figma PNG export) and task 11 (side-by-side check) need a person with the Figma file. Until the export exists, the 1440 Figma comparison skips with a reason and the app baselines cover all five sizes.
- Spike 0.3 runs in the browser of the e2e stack; its result decides D6 and is written into `design.md` Open Point 6.
- Every test sub-task is required; properties P1 to P7 of `design.md` each have a named test.
- Root `pnpm typecheck` and `pnpm test` may time out under turbo; per-package runs are acceptable.

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["0.1", "0.2", "0.3", "0.4", "1.1", "1.5", "1.6", "1.8", "2.1", "2.3", "3.1"] },
    { "id": 1, "tasks": ["1.2", "1.7", "2.2", "2.4", "3.2", "3.3", "3.4", "3.5"] },
    { "id": 2, "tasks": ["1.3", "1.4"] },
    { "id": 3, "tasks": ["5.1"] },
    { "id": 4, "tasks": ["5.2", "5.3", "5.4", "5.5", "5.6", "5.7", "5.8", "5.9"] },
    { "id": 5, "tasks": ["5.10", "6.1", "6.2", "6.3", "6.4", "6.5"] },
    { "id": 6, "tasks": ["6.6", "8.1"] },
    { "id": 7, "tasks": ["8.2", "8.3"] },
    { "id": 8, "tasks": ["8.4", "9.1"] },
    { "id": 9, "tasks": ["9.2", "9.3"] },
    { "id": 10, "tasks": ["10.1", "10.2", "10.3", "10.4"] },
    { "id": 11, "tasks": ["11.1", "11.2", "11.3", "11.4", "11.5"] }
  ]
}
```
