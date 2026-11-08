import { PASTE_INTERVAL_MS, PASTE_MAX_LINES } from "../irc/types.js";

// The one place that defines the keyboard shortcuts of the client (web-client-extras R4). Handlers
// import their key names and matchers from here, and the Keyboard shortcuts dialog is generated
// from `SHORTCUTS`, so the help text cannot drift from what the code does.

export type ShortcutGroup = "Windows" | "Menus" | "Input line" | "Dialogs" | "Toolbar";

export interface Shortcut {
  readonly id: string;
  readonly group: ShortcutGroup;
  /** Display text of the key or key combination. */
  readonly keys: string;
  readonly action: string;
}

/** Menu bar model: label and index of the underlined mnemonic letter. Order is the bar order. */
export const MENU_DEFS = [
  { id: "file", label: "File", mnemonic: 0 },
  { id: "view", label: "View", mnemonic: 0 },
  { id: "favorites", label: "Favorites", mnemonic: 1 },
  { id: "tools", label: "Tools", mnemonic: 0 },
  { id: "commands", label: "Commands", mnemonic: 0 },
  { id: "window", label: "Window", mnemonic: 0 },
  { id: "help", label: "Help", mnemonic: 0 },
] as const;

export type MenuId = (typeof MENU_DEFS)[number]["id"];

/** Key names the Input_Line reacts to. */
export const INPUT_KEYS = {
  complete: "Tab",
  historyUp: "ArrowUp",
  historyDown: "ArrowDown",
  submit: "Enter",
} as const;

export const CLOSE_KEY = "Escape";

/** Alt+1..9 → nth window; uses `code` because Alt changes `key` on some layouts. */
export function windowSwitchIndex(event: {
  readonly altKey: boolean;
  readonly ctrlKey: boolean;
  readonly metaKey: boolean;
  readonly code: string;
  readonly key: string;
}): number | null {
  if (!event.altKey || event.ctrlKey || event.metaKey) return null;
  const match = /^(?:Digit|Numpad)([1-9])$/.exec(event.code) ?? /^([1-9])$/.exec(event.key);
  return match?.[1] === undefined ? null : Number(match[1]);
}

/** Index of the menu whose mnemonic letter is `letter` (upper case), or -1. */
export function menuIndexForMnemonic(letter: string): number {
  return MENU_DEFS.findIndex((m) => m.label.charAt(m.mnemonic).toUpperCase() === letter);
}

/** The mnemonic letter (upper case) of a menu. */
export function mnemonicOf(def: { readonly label: string; readonly mnemonic: number }): string {
  return def.label.charAt(def.mnemonic).toUpperCase();
}

/** The paste behaviour sentence, built from the limits the Store enforces. */
export function pasteNote(): string {
  return `Pasted text is sent one line at a time, ${String(PASTE_INTERVAL_MS)} ms apart. A paste of more than ${String(PASTE_MAX_LINES)} lines asks for confirmation and only the first ${String(PASTE_MAX_LINES)} lines are sent.`;
}

export const SHORTCUTS: readonly Shortcut[] = [
  { id: "window-switch", group: "Windows", keys: "Alt+1 … Alt+9", action: "Switch to the nth window of the switchbar" },
  ...MENU_DEFS.map(
    (m): Shortcut => ({
      id: `menu-${m.id}`,
      group: "Menus",
      keys: `Alt+${mnemonicOf(m)}`,
      action: `Open the ${m.label} menu`,
    }),
  ),
  { id: "menu-move", group: "Menus", keys: "↑ ↓ Home End", action: "Move within an open menu" },
  { id: "menu-switch", group: "Menus", keys: "← →", action: "Open the neighbouring menu" },
  { id: "menu-letter", group: "Menus", keys: "A letter", action: "Jump to the next item that starts with it" },
  { id: "menu-close", group: "Menus", keys: "Esc", action: "Close the menu and return to the menu bar" },
  { id: "toolbar-move", group: "Toolbar", keys: "← → Home End", action: "Move along the toolbar" },
  { id: "input-complete", group: "Input line", keys: INPUT_KEYS.complete, action: "Complete a nick; press again to cycle through matches" },
  { id: "input-history", group: "Input line", keys: "↑ ↓", action: "Recall earlier input" },
  { id: "input-submit", group: "Input line", keys: INPUT_KEYS.submit, action: "Send the line or run the command" },
  { id: "dialog-close", group: "Dialogs", keys: "Esc", action: "Close the dialog, or the nick list overlay in the compact layout" },
  { id: "list-join", group: "Dialogs", keys: "Enter or double-click", action: "Join the selected channel in the channel list" },
];
