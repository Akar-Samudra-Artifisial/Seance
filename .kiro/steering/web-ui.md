---
inclusion: fileMatch
fileMatchPattern: "apps/web/**"
---

# Web UI Design System (apps/web)

The web client is a 1995-style IRC client with a Halloween "ghost" palette. The source of truth for visuals is the Figma mockup, frames:

`00 Style guide` · `01 Main` · `02 Connect` · `03 Kick` · `04 Whois+Options` · `05 Channel list` · `06 Classic`

Match the mockup before inventing anything. When a value is not listed here, read it from `00 Style guide`.

## Window chrome (Win95)

| Token | Value |
|---|---|
| Face / dialog background | `#c0c0c0` |
| Bevel highlight (top/left) | `#ffffff` |
| Bevel shadow (inner, bottom/right) | `#808080` |
| Bevel shadow (outer, bottom/right) | `#000000` |
| Active title bar | linear gradient `#000080` → `#1084d0` (left to right), white text |

- Raised controls use highlight top/left and shadow bottom/right; pressed/sunken controls invert it.
- MDI windows (status / channel / query), switchbar, 16px icon toolbar, nick list on the right with `@` / `+` prefixes.

## Ghost palette (chat surfaces)

| Token | Value |
|---|---|
| Background | `#0b0b0f` |
| Text | `#d8d4c8` |
| Accent orange (highlights, mentions, notices) | `#c8761f` |
| Green (success, joins) | `#6a9955` |
| Purple (system, researcher) | `#9a80c2` |

## Nick colors

| Nick | Color |
|---|---|
| `coder` | `#3b78ff` |
| `reviewer` | `#4caf50` |
| `researcher` | purple `#9a80c2` |
| Humans | orange `#e08a2e` |

Define all colors once as Tailwind theme tokens / CSS variables; never hardcode hex values in components.

## Typography

- Chat buffer and input: **IBM Plex Mono 15px**.
- UI chrome (menus, dialogs, buttons, nick list): **Arimo**.
- Titles and ASCII headers: **VT323**.
- Self-host fonts or load them through `next/font`; no runtime CDN dependency.

## Naming

- Never use the word **"mIRC"** anywhere in the UI, metadata, alt text, or assets (trademark). Say "classic IRC client" or "Séance".

## Accessibility and keyboard

- Text contrast meets **WCAG AA** (4.5:1 for body text, 3:1 for large text) on both chrome and ghost surfaces; verify any new color pair.
- Keyboard-first: every action is reachable without a mouse. Tab completes nicks in the input, `Alt+1..9` switches windows, `Esc` closes dialogs, focus is always visible.
- Use semantic elements and ARIA roles for windows, dialogs, menus and the nick list (`role="log"` with `aria-live="polite"` for the chat buffer).
- CRT scanlines and animations are optional and respect `prefers-reduced-motion`.

## Halloween touches

ASCII jack-o'-lantern in the status window on connect, MOTD "Server is haunted", `*** coder has been exorcised` on kick. Keep them tasteful and never block functionality.

## Icons

- The icons are the Figma drawings in `apps/web/design/figma-icons/` (plus `figma-icons-extra/` for pressed states and the few added icons). Never draw a look-alike in code.
- `node scripts/gen-icons.mjs` (in `apps/web`) generates `src/icons/*.tsx` and the scrollbar arrows in `app/scrollbar.css`; generated files are committed and never edited by hand. They are the only place outside `app/globals.css` with hex colours.

## Layout and breakpoints

- Region sizes live once in `app/globals.css` (`--layout-*`) and `src/layout/metrics.ts`; components use the tokens, never `style=`.
- Desktop (1024 px and up): Frame_01 metrics. Medium (768 to 1023): nick list 140 px, status panels scale.
- Compact (below 768): nick list as an overlay toggled by the toolbar agents button; menus that do not fit go into a `»` menu; toolbar label, lag and filler panels hidden; switchbar scrolls in its row; credits show candle and value only; topic truncates with `title`.
- Every control gets a 32x32 hit area on coarse pointers (`hit-target` or `pointer-coarse:`) without changing the drawn size on a fine pointer. No horizontal page overflow from 360 px up.

## Verifying UI

Use the Playwright MCP server (`.kiro/settings/mcp.json`) to open the running client, take screenshots, and compare with the Figma frames.
