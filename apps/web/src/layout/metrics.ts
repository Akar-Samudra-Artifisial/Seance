// Frame_01 layout metrics (web-client-pixel-match R1). Pure: the same numbers as the
// `--layout-*` variables in app/globals.css; a test keeps both equal.

export const LAYOUT = {
  frame: 3,
  gap: 2,
  gapStatus: 1,
  title: 22,
  menu: 20,
  toolbar: 32,
  topic: 24,
  chat: 686,
  input: 24,
  tray: 28,
  switchbar: 26,
  status: 21,
  chatWidth: 1250,
  nickList: { desktop: 181, medium: 140, overlay: 240 },
} as const;

/** Breakpoints in CSS px, the same as Tailwind `md` and `lg`. */
export const BREAKPOINTS = { medium: 768, desktop: 1024 } as const;

/**
 * Height of the frame for a channel window at the Frame_01 chat height:
 * 900 with the minimised tray, 870 without it (the chat pane then grows by 30 px).
 */
export function totalHeight(withTray: boolean): number {
  const L = LAYOUT;
  const tray = withTray ? L.tray + L.gap : 0;
  return (
    2 * L.frame +
    L.title +
    L.menu +
    L.toolbar +
    L.gap +
    L.topic +
    L.gap +
    L.chat +
    L.gap +
    L.input +
    L.gap +
    tray +
    L.switchbar +
    L.gapStatus +
    L.status
  );
}

/** Menu bar slot widths in order File..Help (R5.2): text 8 px inside each slot. */
export const MENU_SLOTS = [42, 42, 49, 69, 56, 56] as const;

/** Width kept free in the menu bar: child icon (5 + 14 + 1) and child buttons (16 + 16 + 2 + 16 + 2). */
export const MENU_RESERVE = 20 + 52;

/** Width of the Compact `»` overflow button. */
export const MENU_OVERFLOW = 24;
