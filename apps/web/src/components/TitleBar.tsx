"use client";

import { useEffect } from "react";
import type { ReactNode } from "react";
import { titleOf } from "../irc/index.js";
import { useClientStore } from "../store/react.js";
import { Icon } from "./Icon.js";
import { IrcText } from "./Spans.js";

const captionClass =
  "bevel-raised flex h-3.5 w-4 items-center justify-center bg-chrome-face font-chrome text-[11px] leading-none text-chrome-outline focus-visible:outline-2 focus-visible:outline-chrome-outline aria-disabled:text-chrome-shadow";

/** Host part of the server URL for the status title; falls back to the raw text when it is not a URL. */
export function hostOf(serverUrl: string): string {
  try {
    const host = new URL(serverUrl).host;
    return host === "" ? serverUrl : host;
  } catch {
    return serverUrl;
  }
}

/** Application title bar. Also keeps `document.title` equal to the displayed text. */
export function TitleBar(): ReactNode {
  // The selector returns a string, so a new chat line leaves the selection equal and skips the render.
  const title = useClientStore((s) => titleOf(s.client, hostOf(s.ui.serverUrl)));
  const connected = useClientStore((s) => s.client.phase === "registered");
  const quit = useClientStore((s) => s.quit);
  // The Connect_Dialog is modal and visible whenever the client is not registered.
  const modalOpen = !connected;

  useEffect(() => {
    document.title = title;
  }, [title]);

  const surface = modalOpen
    ? "bg-linear-to-r from-title-inactive-from to-title-inactive-to text-title-inactive-text"
    : "bg-linear-to-r from-title-from to-title-to text-chrome-highlight";

  return (
    <div
      data-testid="title-bar"
      data-active={modalOpen ? "false" : "true"}
      className={`flex h-[22px] shrink-0 items-center gap-1 px-1 font-chrome text-xs font-bold ${surface}`}
    >
      <Icon name="status" />
      <span className="min-w-0 flex-1 truncate">
        <IrcText text={title} />
      </span>
      <button type="button" aria-label="Minimise" aria-disabled="true" className={captionClass}>
        <span aria-hidden="true">_</span>
      </button>
      <button type="button" aria-label="Maximise" aria-disabled="true" className={captionClass}>
        <span aria-hidden="true">□</span>
      </button>
      <button
        type="button"
        aria-label="Close"
        className={captionClass}
        onClick={() => {
          if (connected) quit();
        }}
      >
        <span aria-hidden="true">×</span>
      </button>
    </div>
  );
}
