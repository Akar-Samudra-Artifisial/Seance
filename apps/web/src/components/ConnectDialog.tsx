"use client";

import { useEffect, useRef, useState } from "react";
import type { FormEvent, ReactNode } from "react";
import { useClientStore } from "../store/react.js";
import { Dialog } from "./Dialog.js";

const fieldClass =
  "bevel-sunken w-full bg-ghost-bg px-1 py-0.5 font-chat text-[15px] text-ghost-text focus-visible:outline-2 focus-visible:outline-ghost-orange";
const errorClass = "font-chrome text-sm font-bold text-irc-5";
const buttonClass =
  "bevel-raised bg-chrome-face px-3 py-0.5 text-sm focus-visible:outline-2 focus-visible:outline-chrome-outline disabled:text-chrome-shadow";

function focusInputLine(): void {
  document.getElementById("input-line")?.focus();
}

export function ConnectDialog(): ReactNode {
  const connect = useClientStore((s) => s.connect);
  const reconnect = useClientStore((s) => s.reconnect);
  const phase = useClientStore((s) => s.client.phase);
  const connectError = useClientStore((s) => s.client.connectError);
  const cancelConnect = useClientStore((s) => s.cancelConnect);
  const nickError = useClientStore((s) => s.ui.nickError);
  const serverUrlError = useClientStore((s) => s.ui.serverUrlError);
  const storedNick = useClientStore((s) => s.ui.storedNick);
  const storedUrl = useClientStore((s) => s.ui.serverUrl);
  const [nick, setNick] = useState(storedNick ?? "");
  // Audit 10.3: the nick the server confirmed (and a later /nick) is the next prefill, also after a Quit.
  const [seenStoredNick, setSeenStoredNick] = useState(storedNick);
  if (storedNick !== seenStoredNick) {
    setSeenStoredNick(storedNick);
    setNick(storedNick ?? "");
  }
  const [serverUrl, setServerUrl] = useState(storedUrl);
  const [password, setPassword] = useState("");
  const connectRequests = useClientStore((s) => s.ui.connectRequests);
  const [dismissed, setDismissed] = useState(false);
  const [seenRequests, setSeenRequests] = useState(connectRequests);
  const [hadRegistered, setHadRegistered] = useState(false);
  const wasVisible = useRef(false);

  const visible = phase !== "registered" && !dismissed;

  // A request from the Toolbar or menu reopens a dismissed dialog.
  if (connectRequests !== seenRequests) {
    setSeenRequests(connectRequests);
    setDismissed(false);
  }
  // A registration reopens the dialog for the next disconnect.
  if (phase === "registered" && (!hadRegistered || dismissed)) {
    setHadRegistered(true);
    setDismissed(false);
  }

  // The Dialog focuses the field marked `data-autofocus` (the first empty one) when it opens; this
  // returns focus to the Input_Line when it closes (the Dialog alone would restore the previous
  // element, which is the page body on first load).
  useEffect(() => {
    if (!visible && wasVisible.current) focusInputLine();
    wasVisible.current = visible;
  }, [visible]);

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
    cancelConnect();
    setDismissed(true);
  };
  // Window chrome, Esc, the Tab trap and initial focus come from the shared Dialog; the caption X and
  // Esc call `close`, exactly like the Cancel button (the dialog can always be dismissed).
  const firstEmpty = nick === "" ? "nick" : serverUrl === "" ? "url" : "password";
  return (
    <Dialog
      title="Connect to Séance"
      titleId="connect-title"
      onClose={close}
      className="w-96"
      overlayClassName="z-10 bg-ghost-bg/70"
    >
      <form onSubmit={onSubmit} className="flex flex-col gap-2 p-2">
        <div className="flex flex-col gap-0.5 text-sm">
          <label htmlFor="connect-nick">Nick</label>
          <input
            id="connect-nick"
            data-autofocus={firstEmpty === "nick" ? "true" : undefined}
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
            data-autofocus={firstEmpty === "url" ? "true" : undefined}
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
            data-autofocus={firstEmpty === "password" ? "true" : undefined}
            type="password"
            value={password}
            onChange={(e) => {
              setPassword(e.target.value);
            }}
            autoComplete="off"
            aria-invalid={passwordMessage !== null}
            aria-describedby={
              passwordMessage !== null ? "connect-password-help connect-password-error" : "connect-password-help"
            }
            className={fieldClass}
          />
          <span id="connect-password-help" className="text-xs">
            Account secret, or the server password
          </span>
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
    </Dialog>
  );
}
