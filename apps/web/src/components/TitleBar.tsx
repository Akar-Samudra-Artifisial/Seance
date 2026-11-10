"use client";

import { useEffect, useSyncExternalStore } from "react";
import type { ReactNode } from "react";
import { titleOf } from "../irc/index.js";
import { useClientStore } from "../store/react.js";
import { AppCandle } from "../icons/index.js";
import { CaptionButton } from "./CaptionButton.js";
import { IrcText } from "./Spans.js";

/** Host part of the server URL for the status title; falls back to the raw text when it is not a URL. */
export function hostOf(serverUrl: string): string {
  try {
    const host = new URL(serverUrl).host;
    return host === "" ? serverUrl : host;
  } catch {
    return serverUrl;
  }
}

/** Why the window controls of the app title bar do nothing: the page lives in a browser tab. */
const BROWSER_TAB = "Not available in a browser tab";

function subscribeFullscreen(onChange: () => void): () => void {
  document.addEventListener("fullscreenchange", onChange);
  return () => {
    document.removeEventListener("fullscreenchange", onChange);
  };
}
const isFullscreen = (): boolean => document.fullscreenElement != null;
const canFullscreen = (): boolean => document.fullscreenEnabled === true;
const never = (): boolean => false;
const noSubscription = (): (() => void) => () => undefined;

/**
 * Enters or leaves browser full screen. A rejected request (no user gesture, a policy, a user who
 * dismissed the prompt) and a missing implementation are swallowed on purpose: the label follows the
 * real state through `fullscreenchange`, so a refusal just leaves the button as it was.
 */
function toggleFullscreen(): void {
  try {
    const pending = isFullscreen() ? document.exitFullscreen() : document.documentElement.requestFullscreen();
    void Promise.resolve(pending).catch(() => undefined);
  } catch {
    // Not supported or not allowed right now.
  }
}

/** Application title bar. Also keeps `document.title` equal to the displayed text. */
export function TitleBar(): ReactNode {
  // The server render has no document: both read `false`, so the first client render matches it.
  const fullscreen = useSyncExternalStore(subscribeFullscreen, isFullscreen, never);
  const fullscreenAvailable = useSyncExternalStore(noSubscription, canFullscreen, never);
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

  // Frame_01: candle 10x16 at x6, title at x24, buttons 16x14 at x1382/1398/1416 (2 px gap before close).
  return (
    <div
      data-testid="title-bar"
      data-active={modalOpen ? "false" : "true"}
      className={`flex h-[22px] shrink-0 items-center pl-1.5 pr-0.5 font-chrome text-xs font-bold ${surface}`}
    >
      <AppCandle />
      <span className="ml-2 min-w-0 flex-1 truncate">
        <IrcText text={title} />
      </span>
      <CaptionButton kind="min" label="Minimise" description={BROWSER_TAB} inert />
      {fullscreenAvailable ? (
        <CaptionButton
          kind={fullscreen ? "restore" : "max"}
          label={fullscreen ? "Exit full screen" : "Full screen"}
          title={fullscreen ? "Exit full screen" : "Full screen"}
          onClick={toggleFullscreen}
        />
      ) : (
        <CaptionButton kind="max" label="Maximise" description={BROWSER_TAB} inert />
      )}
      <CaptionButton
        kind="close"
        label="Close"
        className="ml-0.5"
        inert={!connected}
        description={connected ? undefined : "Not connected"}
        onClick={quit}
      />
    </div>
  );
}
