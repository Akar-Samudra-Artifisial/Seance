import type { ReactNode } from "react";

export type IconName =
  | "connect"
  | "options"
  | "channels"
  | "agents"
  | "logs"
  | "theme"
  | "status"
  | "hash"
  | "ghost-coder"
  | "ghost-reviewer"
  | "ghost-researcher"
  | "ghost-away";

export interface IconProps {
  readonly name: IconName;
  /** Extra classes for placement; colour comes from the icon itself or `currentColor`. */
  readonly className?: string;
}

/** Ghost colour per variant, as token utilities (no hex, no inline style). */
const ghostClass: Readonly<Record<string, string>> = {
  "ghost-coder": "text-nick-coder",
  "ghost-reviewer": "text-nick-reviewer",
  "ghost-researcher": "text-nick-researcher",
  "ghost-away": "text-away-grey",
};

/** 16x16 pixel-style glyphs. Shapes use `currentColor`; the cut-outs use `fill-rule="evenodd"`. */
const glyphs: Readonly<Record<Exclude<IconName, `ghost-${string}`>, ReactNode>> = {
  // Plug: two prongs, body, cable.
  connect: <path d="M5 1h2v4h2V1h2v4h1v4H4V5h1zM7 9h2v3h2v2H5v-2h2z" />,
  // Sliders: three bars with knobs.
  options: (
    <path d="M2 3h12v2H2zM9 2h3v4H9zM2 7h12v2H2zM4 6h3v4H4zM2 11h12v2H2zM10 10h3v4h-3z" fillRule="evenodd" />
  ),
  // Speech bubble with a tail.
  channels: <path d="M1 2h14v9H8l-3 3v-3H1zM3 4v5h10V4z" fillRule="evenodd" />,
  // Two heads and shoulders.
  agents: (
    <path d="M5 2h3v3H5zM3 6h7v3h1v4H2V9h1zM10 3h3v3h-3zM11 7h3v2h1v4h-3V9h-1z" fillRule="evenodd" />
  ),
  // Document with text lines.
  logs: <path d="M3 1h8l2 2v12H3zM5 5h6v1H5zM5 8h6v1H5zM5 11h4v1H5z" fillRule="evenodd" />,
  // Half-filled disc.
  theme: <path d="M8 1a7 7 0 1 0 0 14A7 7 0 0 0 8 1zm0 2v10a5 5 0 0 1 0-10z" fillRule="evenodd" />,
  // Monitor on a stand.
  status: <path d="M1 2h14v10H1zM3 4v6h10V4zM6 13h4v1h2v1H4v-1h2z" fillRule="evenodd" />,
  // Channel sign.
  hash: <path d="M5 1h2l-.5 4h3L10 1h2l-.5 4H14v2h-2.7l-.4 2H14v2h-3.4L10 15H8l.5-4h-3L5 15H3l.5-4H1V9h2.7l.4-2H1V5h3.4zm1.2 6-.4 2h3l.4-2z" fillRule="evenodd" />,
};

/** Decorative inline SVG. Always `aria-hidden`; the owning control supplies the accessible name. */
export function Icon({ name, className }: IconProps): ReactNode {
  const ghostColour = ghostClass[name];
  const classes = ["inline-block size-4 shrink-0", ghostColour, className].filter(Boolean).join(" ");
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 16 16"
      width={16}
      height={16}
      fill="currentColor"
      aria-hidden="true"
      focusable="false"
      className={classes}
      data-icon={name}
    >
      {ghostColour === undefined ? (
        glyphs[name as keyof typeof glyphs]
      ) : (
        // Ghost: dome head, wavy hem, two eye holes.
        <path d="M8 1c3 0 5 2 5 5v9l-2-2-1.5 2L8 13l-1.5 2L5 13l-2 2V6c0-3 2-5 5-5zM6 5v3h1.5V5zm3 0v3h1.5V5z" fillRule="evenodd" />
      )}
    </svg>
  );
}
