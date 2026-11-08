import type { ReactNode } from "react";
import { formatIrc, linkify, mentionSegments } from "../irc/index.js";
import { readableClass } from "../irc/colors.js";
import type { Span } from "../irc/index.js";

// Full class literals so Tailwind sees every name at build time. No inline style.
// Foreground classes come from readableClass (src/irc/colors.ts).
const BG: readonly string[] = [
  "bg-irc-0",
  "bg-irc-1",
  "bg-irc-2",
  "bg-irc-3",
  "bg-irc-4",
  "bg-irc-5",
  "bg-irc-6",
  "bg-irc-7",
  "bg-irc-8",
  "bg-irc-9",
  "bg-irc-10",
  "bg-irc-11",
  "bg-irc-12",
  "bg-irc-13",
  "bg-irc-14",
  "bg-irc-15",
];

/** Class names for one formatter span. Foregrounds always meet 4.5:1 (readableClass). */
export function spanClass(span: Span): string {
  const classes: string[] = [];
  if (span.fg !== undefined) classes.push(readableClass(span.fg, span.bg));
  if (span.bg !== undefined) {
    const c = BG[span.bg];
    if (c !== undefined) classes.push(c);
  }
  if (span.bold) classes.push("font-bold");
  if (span.underline) classes.push("underline");
  return classes.join(" ");
}

/** True when the formatted text holds at least one non-whitespace character. */
export function hasVisibleText(text: string): boolean {
  return formatIrc(text).some((span) => span.text.trim() !== "");
}

/** Renders formatter spans; http(s) URLs become anchors, everything else is a text node. */
export function Spans(props: { readonly spans: readonly Span[]; readonly highlight?: string }): ReactNode {
  const { highlight } = props;
  return props.spans.map((span, i) => (
    <span key={i} className={spanClass(span)}>
      {linkify(span.text).map((seg, j) =>
        seg.kind === "link" ? (
          <a
            key={j}
            href={seg.href}
            target="_blank"
            rel="noopener noreferrer"
            className="underline"
          >
            {seg.text}
          </a>
        ) : highlight === undefined ? (
          seg.text
        ) : (
          mentionSegments(seg.text, highlight).map((part, k) =>
            part.hit ? (
              <span key={k} className="font-bold text-ghost-orange">
                {part.text}
              </span>
            ) : (
              part.text
            ),
          )
        ),
      )}
    </span>
  ));
}

/** Formats untrusted text (colour codes, bold, underline) and renders it as spans. */
export function IrcText(props: { readonly text: string; readonly highlight?: string }): ReactNode {
  return <Spans spans={formatIrc(props.text)} {...(props.highlight !== undefined ? { highlight: props.highlight } : {})} />;
}
