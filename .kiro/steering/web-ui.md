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
| Accent orange (highlights, mentions, human nicks) | `#c8761f` |
| Green (success, joins) | `#6a9955` |
| Purple (system, researcher) | `#9a80c2` |

## Nick colors

| Nick | Color |
|---|---|
| `coder` | `#3b78ff` |
| `reviewer` | `#4caf50` |
| `researcher` | purple `#9a80c2` |
| Humans | orange `#c8761f` |

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

## Verifying UI

Use the Playwright MCP server (`.kiro/settings/mcp.json`) to open the running client, take screenshots, and compare with the Figma frames.
