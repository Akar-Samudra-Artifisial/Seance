"use client";

import { useEffect, useRef, useState } from "react";
import type { FormEvent, KeyboardEvent, ReactNode } from "react";
import { useClientStore } from "../store/react.js";

const fieldClass =
  "bevel-sunken w-full bg-ghost-bg px-1 py-0.5 font-chat text-[15px] text-ghost-text focus-visible:outline-2 focus-visible:outline-ghost-orange";
const errorClass = "font-chrome text-sm font-bold text-irc-5";
const buttonClass =
  "bevel-raised bg-chrome-face px-3 py-0.5 text-sm focus-visible:outline-2 focus-visible:outline-chrome-outline disabled:text-chrome-shadow";

const FOCUSABLE = "input:not([disabled]), button:not([disabled])";

function focusInputLine(): void {
  document.getElementById("input-line")?.focus();
}

export function ConnectDialog(): ReactNode {
  const connect = useClientStore((s) => s.connect);
  const reconnect = useClientStore((s) => s.reconnect);
  const phase = useClientStore((s) => s.client.phase);
  const connectError = useClientStore((s) => s.client.connectError);
  const nickError = useClientStore((s) => s.ui.nickError);
  const serverUrlError = useClientStore((s) => s.ui.serverUrlError);
  const storedNick = useClientStore((s) => s.ui.storedNick);
  const storedUrl = useClientStore((s) => s.ui.serverUrl);
  const [nick, setNick] = useState(storedNick ?? "");
  const [serverUrl, setServerUrl] = useState(storedUrl);
  const [password, setPassword] = useState("");
  const [dismissed, setDismissed] = useState(false);
  const [hadRegistered, setHadRegistered] = useState(false);
  const formRef = useRef<HTMLFormElement>(null);
  const nickRef = useRef<HTMLInputElement>(null);
  const urlRef = useRef<HTMLInputElement>(null);
  const passwordRef = useRef<HTMLInputElement>(null);
  const wasVisible = useRef(false);

  const visible = phase !== "registered" && !dismissed;

  // A registration reopens the dialog for the next disconnect.
  if (phase === "registered" && (!hadRegistered || dismissed)) {
    setHadRegistered(true);
    setDismissed(false);
  }

  // Focus the first empty field on open; return focus to the Input_Line on close.
  useEffect(() => {
    if (visible && !wasVisible.current) {
      const target =
        nick === "" ? nickRef.current : serverUrl === "" ? urlRef.current : passwordRef.current;
      target?.focus();
    } else if (!visible && wasVisible.current) {
      focusInputLine();
    }
    wasVisible.current = visible;
  }, [visible, nick, serverUrl]);

  if (!visible) return null;
  const busy = phase === "connecting" || phase === "registering";
  const canReconnect = hadRegistered && (phase === "disconnected" || phase === "failed");

  const code = connectError?.code;
  const nickMessage = nickError ?? (code === "in-use" || code === "erroneous" ? (connectError?.text ?? null) : null);
  const urlMessage =
    serverUrlError ?? (code === "socket" || code === "origin-or-network" ? (connectError?.text ?? null) : null);
  const passwordMessage = code === "password" ? (connectError?.text ?? null) : null;

  const onSubmit = (event: FormEvent): void => {
    event.preventDefault();
    connect({ nick, serverUrl, password: password === "" ? undefined : password });
  };
  const close = (): void => {
    setDismissed(true);
  };
  const onKeyDown = (event: KeyboardEvent): void => {
    if (event.key === "Escape") {
      event.preventDefault();
      close();
      return;
    }
    if (event.key !== "Tab") return;
    const items = Array.from(formRef.current?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? []);
    const first = items[0];
    const lastItem = items[items.length - 1];
    if (first === undefined || lastItem === undefined) return;
    const current = document.activeElement;
    if (event.shiftKey && current === first) {
      event.preventDefault();
      lastItem.focus();
    } else if (!event.shiftKey && current === lastItem) {
      event.preventDefault();
      first.focus();
    } else if (current instanceof HTMLElement && !items.includes(current)) {
      event.preventDefault();
      first.focus();
    }
  };

  return (
    <div className="fixed inset-0 z-10 flex items-center justify-center bg-ghost-bg/70">
      <form
        ref={formRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="connect-title"
        onSubmit={onSubmit}
        onKeyDown={onKeyDown}
        className="bevel-raised flex w-96 max-w-full flex-col gap-2 bg-chrome-face p-2 font-chrome text-chrome-outline"
      >
        <h2
          id="connect-title"
          className="bg-linear-to-r from-title-from to-title-to px-1 font-title text-xl font-bold text-chrome-highlight"
        >
          Connect to Séance
        </h2>
        <div className="flex flex-col gap-0.5 text-sm">
          <label htmlFor="connect-nick">Nick</label>
          <input
            id="connect-nick"
            ref={nickRef}
            type="text"
            value={nick}
            onChange={(e) => {
              setNick(e.target.value);
            }}
            autoComplete="off"
            spellCheck={false}
            aria-invalid={nickMessage !== null}
            aria-describedby={nickMessage !== null ? "connect-nick-error" : undefined}
            className={fieldClass}
          />
        </div>
        {nickMessage !== null ? (
          <p id="connect-nick-error" role="alert" className={errorClass}>
            {nickMessage}
          </p>
        ) : null}
        <div className="flex flex-col gap-0.5 text-sm">
          <label htmlFor="connect-url">Server URL</label>
          <input
            id="connect-url"
            ref={urlRef}
            type="text"
            value={serverUrl}
            onChange={(e) => {
              setServerUrl(e.target.value);
            }}
            autoComplete="off"
            spellCheck={false}
            aria-invalid={urlMessage !== null}
            aria-describedby={urlMessage !== null ? "connect-url-error" : undefined}
            className={fieldClass}
          />
        </div>
        {urlMessage !== null ? (
          <p id="connect-url-error" role="alert" className={errorClass}>
            {urlMessage}
          </p>
        ) : null}
        <div className="flex flex-col gap-0.5 text-sm">
          <label htmlFor="connect-password">Password (optional)</label>
          <input
            id="connect-password"
            ref={passwordRef}
            type="password"
            value={password}
            onChange={(e) => {
              setPassword(e.target.value);
            }}
            autoComplete="off"
            aria-invalid={passwordMessage !== null}
            aria-describedby={passwordMessage !== null ? "connect-password-error" : undefined}
            className={fieldClass}
          />
        </div>
        {passwordMessage !== null ? (
          <p id="connect-password-error" role="alert" className={errorClass}>
            {passwordMessage}
          </p>
        ) : null}
        <div className="flex justify-end gap-2">
          <button type="button" onClick={close} className={buttonClass}>
            Cancel
          </button>
          {canReconnect ? (
            <button type="button" onClick={reconnect} className={buttonClass}>
              Reconnect
            </button>
          ) : null}
          <button type="submit" disabled={busy} className={buttonClass}>
            {busy ? "Connecting…" : "Connect"}
          </button>
        </div>
      </form>
    </div>
  );
}
