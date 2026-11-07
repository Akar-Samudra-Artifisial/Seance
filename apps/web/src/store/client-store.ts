import { LineFramer, isParseError, parse, serialize } from "@seance/irc-protocol";
import type { IrcMessage } from "@seance/irc-protocol";
import { createStore } from "zustand/vanilla";
import type { StoreApi } from "zustand/vanilla";
import { validateServerUrl } from "../config/connect-src.js";
import {
  EMPTY_HISTORY,
  FRAME_MAX_BYTES,
  decodeFrames,
  initialState,
  isValidNick,
  navigate,
  PASTE_INTERVAL_MS,
  PASTE_MAX_LINES,
  parseInput,
  pushHistory,
  reduce,
  resetForReconnect,
  stepConnection,
} from "../irc/index.js";
import type { ClientState, ConnectParams, History, HistoryDirection, InputContext, LineKind } from "../irc/index.js";
import { channelKey, chatKey } from "../irc/casemap.js";
import { getOwn, withEntry, withoutEntry } from "../irc/record.js";
import { appendStatus, appendTo, openWindow, rememberClosed } from "../irc/reducer.route.js";
import type { LineSpec } from "../irc/reducer.route.js";
import type { CreateSocket, WebSocketLike } from "./socket.js";
import type { ClientStorage } from "./storage.js";

/** Audio output for the optional mention sound (Requirement 10.3). */
export interface MentionAudio {
  /** Create or resume the audio context. The Store calls this only from a user gesture. */
  unlock(): void;
  /** Play the short mention sound. */
  play(): void;
}

export interface StoreDeps {
  /** Optional: without it the mention sound is a no-op. */
  readonly audio?: MentionAudio;
  readonly createSocket: CreateSocket;
  readonly storage: ClientStorage;
  readonly now: () => number;
  readonly setTimeout: (fn: () => void, ms: number) => unknown;
  readonly clearTimeout: (handle: unknown) => void;
  readonly defaultServerUrl: string;
  readonly allowedOrigins: readonly string[];
}

export interface UiState {
  /** Inline error for the nick field of the Connect_Dialog; null = none. */
  readonly nickError: string | null;
  /** Inline error for the server URL field; null = none. */
  readonly serverUrlError: string | null;
  /** Validated stored nick, used to prefill the dialog; null = none. */
  readonly storedNick: string | null;
  /** Validated stored server URL, or the default. */
  readonly serverUrl: string;
  readonly mentionSound: boolean;
  /** Input_Line command history (R7.23). */
  readonly history: History;
}

export interface ClientStore {
  readonly client: ClientState;
  readonly ui: UiState;
  connect(params: { nick: string; serverUrl: string; password: string | undefined }): void;
  reconnect(): void;
  submitInput(text: string): void;
  /** Move through the Input_Line history; returns the text the line must show. */
  navigateHistory(direction: HistoryDirection, current: string): string;
  setActiveWindow(key: string): void;
  /** Close a window: query windows locally, channel windows by sending PART (the echo closes it). */
  closeWindow(key: string): void;
  /** Alt+n: activate the nth window (1-based) in Switchbar order. */
  activateByIndex(n: number): void;
  /** Answer the Paste_Confirmation: accept sends at most the first 5 lines, decline drops the paste. */
  confirmPaste(accept: boolean): void;
  quit(): void;
  /** Close the socket and clear timers; call when the owner unmounts. */
  dispose(): void;
  /** Toggle the mention sound (off by default). Call it from a user gesture: enabling unlocks audio. */
  setMentionSound(enabled: boolean): void;
}

const CLOSE_TOO_BIG = 1009;
const CLOSE_NORMAL = 1000;
const QUIT_REASON = "Leaving";
const ACTION_RE = /^\x01ACTION ?([^\x01]*)\x01?$/;

const REJECT_CODES: Readonly<Record<string, "in-use" | "erroneous" | "password">> = {
  "433": "in-use",
  "432": "erroneous",
  "464": "password",
};

const ORIGIN_HINT =
  "the server may be down, or the Ircd may have refused this page's origin (check IRCD_WS_ALLOWED_ORIGINS)";

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function createClientStore(deps: StoreDeps): StoreApi<ClientStore> {
  // The Store is the only owner of the socket, the framer and (later) the paste timer.
  let socket: WebSocketLike | null = null;
  let framer = new LineFramer();
  let last: ConnectParams | null = null;
  let url = deps.defaultServerUrl;

  const stored = deps.storage.read();

  const store = createStore<ClientStore>()((set, get) => {
    const update = (fn: (c: ClientState) => ClientState): void => {
      set((s) => ({ client: fn(s.client) }));
    };
    const status = (kind: LineKind, text: string): void => {
      update((c) => appendStatus(c, { kind, text }, deps.now()));
    };
    const setPhase = (event: Parameters<typeof stepConnection>[1]): void => {
      update((c) => ({ ...c, phase: stepConnection(c.phase, event) }));
    };
    const setConnectError = (code: "in-use" | "erroneous" | "password" | "socket" | "origin-or-network", text: string): void => {
      update((c) => ({ ...c, connectError: { code, text } }));
    };

    // Paste_Queue pacing: the Store owns the timer chain (Requirement 7.21).
    let pasteTimer: unknown = null;
    // Set only by setMentionSound(true), which runs inside a user gesture (Requirement 10.5).
    let audioUnlocked = false;

    /** Empty the Paste_Queue and report how many messages were not sent. */
    const clearQueue = (why: string): void => {
      if (pasteTimer !== null) {
        deps.clearTimeout(pasteTimer);
        pasteTimer = null;
      }
      const n = get().client.paste.queue.length;
      if (n === 0) return;
      update((c) => ({ ...c, paste: { ...c.paste, queue: [] } }));
      status("local", `*** ${n} queued message${n === 1 ? "" : "s"} not sent (${why})`);
    };

    const sendNextQueued = (): void => {
      pasteTimer = null;
      const [msg, ...rest] = get().client.paste.queue;
      if (msg === undefined) return;
      const s = socket;
      if (s === null || get().client.phase !== "registered") {
        clearQueue("not connected");
        return;
      }
      update((c) => ({ ...c, paste: { ...c.paste, queue: rest } }));
      if (!sendMessage(s, msg)) {
        clearQueue("send failed");
        return;
      }
      const target = msg.params[0];
      const text = msg.params[1];
      if (msg.command.toUpperCase() === "PRIVMSG" && target !== undefined && text !== undefined) {
        update((c) => appendTo(c, chatKey(target), echoSpec(text, c.ownNick), deps.now()));
      }
      if (rest.length > 0) pasteTimer = deps.setTimeout(sendNextQueued, PASTE_INTERVAL_MS);
    };

    const enqueue = (msgs: readonly IrcMessage[]): void => {
      update((c) => ({ ...c, paste: { ...c.paste, queue: [...c.paste.queue, ...msgs] } }));
      if (pasteTimer === null) sendNextQueued();
    };

    /** Detach and close the current socket without reacting to its events. */
    const release = (code: number, reason: string): void => {
      clearQueue("connection closed");
      const s = socket;
      socket = null;
      framer = new LineFramer();
      if (s === null) return;
      s.onopen = null;
      s.onmessage = null;
      s.onerror = null;
      s.onclose = null;
      try {
        s.close(code, reason);
      } catch (err) {
        status("error", `error: closing the socket failed: ${errorMessage(err)}`);
      }
    };

    const sendMessage = (s: WebSocketLike, msg: IrcMessage): boolean => {
      try {
        s.send(serialize(msg));
        return true;
      } catch (err) {
        status("error", `error: send failed on ${msg.command}: ${errorMessage(err)}`);
        return false;
      }
    };

    const onOpen = (s: WebSocketLike): void => {
      if (socket !== s || last === null) return;
      setPhase({ type: "socket-open" });
      const { nick, password } = last;
      if (password !== undefined && password !== "") sendMessage(s, { command: "PASS", params: [password] });
      sendMessage(s, { command: "NICK", params: [nick] });
      sendMessage(s, { command: "USER", params: [nick, "0", "*", nick] });
    };

    const onRejected = (msg: IrcMessage, code: "in-use" | "erroneous" | "password"): void => {
      const text = msg.params[msg.params.length - 1] ?? msg.command;
      setPhase({ type: "reject" });
      setConnectError(code, text);
      release(CLOSE_NORMAL, "registration rejected");
    };

    const onMessage = (msg: IrcMessage): void => {
      const before = get().client;
      const rejectCode = Object.hasOwn(REJECT_CODES, msg.command) ? REJECT_CODES[msg.command] : undefined;
      if (rejectCode !== undefined && before.phase === "registering") {
        onRejected(msg, rejectCode);
        return;
      }
      let result;
      try {
        result = reduce(before, msg, deps.now());
      } catch (err) {
        status("error", `error: reduce failed on ${msg.command}: ${errorMessage(err)}`);
        return;
      }
      const phase = msg.command === "001" ? stepConnection(before.phase, { type: "welcome" }) : before.phase;
      update(() => ({ ...result.state, phase }));
      if (result.mention && audioUnlocked && get().ui.mentionSound) {
        try {
          deps.audio?.play();
        } catch (err) {
          status("error", `error: playing the mention sound failed: ${errorMessage(err)}`);
        }
      }
      if (phase === "registered" && before.phase !== "registered") {
        try {
          deps.storage.write({ nick: result.state.ownNick, serverUrl: url });
        } catch (err) {
          status("error", `error: saving nick and server failed: ${errorMessage(err)}`);
        }
      }
      const s = socket;
      if (s === null) return;
      for (const out of result.send) sendMessage(s, out);
    };

    const onFrame = (s: WebSocketLike, data: unknown): void => {
      if (socket !== s) return;
      if (typeof data !== "string") {
        status("system", "diagnostic: ignored a non-text frame from the server");
        return;
      }
      // Cheap length check first: UTF-8 bytes are never fewer than UTF-16 code units.
      if (data.length > FRAME_MAX_BYTES || new TextEncoder().encode(data).length > FRAME_MAX_BYTES) {
        status("error", `error: server frame larger than ${FRAME_MAX_BYTES} bytes; closing the connection`);
        release(CLOSE_TOO_BIG, "frame too large");
        setPhase({ type: "socket-closed" });
        return;
      }
      for (const item of decodeFrames(framer, data)) {
        if (item.kind === "overlong") {
          status("system", "diagnostic: discarded an overlong line from the server");
          continue;
        }
        const parsed = parse(item.line);
        if (isParseError(parsed)) {
          status("system", `diagnostic: unparseable line ignored (${parsed.reason})`);
          continue;
        }
        onMessage(parsed);
        if (socket !== s) return;
      }
    };

    const onClose = (s: WebSocketLike, code: number): void => {
      if (socket !== s) return;
      socket = null;
      framer = new LineFramer();
      const before = get().client.phase;
      clearQueue("connection closed");
      setPhase({ type: "socket-closed" });
      if (before === "connecting") {
        setConnectError("origin-or-network", `Could not reach ${url}: ${ORIGIN_HINT}.`);
      } else if (before === "registering") {
        setConnectError("socket", "The connection closed before registration completed.");
      } else if (before === "registered") {
        status("system", `*** connection closed (code ${code})`);
      }
    };

    const startConnection = (params: ConnectParams): void => {
      release(CLOSE_NORMAL, "reconnecting");
      last = params;
      url = params.serverUrl;
      update((c) => {
        const { connectError: _dropped, ...rest } = c;
        void _dropped;
        const idle: ClientState = { ...rest, ownNick: params.nick, phase: "disconnected" };
        return { ...idle, phase: stepConnection("disconnected", { type: "connect" }) };
      });
      let s: WebSocketLike;
      try {
        s = deps.createSocket(params.serverUrl);
      } catch (err) {
        setPhase({ type: "socket-closed" });
        setConnectError("socket", `Could not open ${params.serverUrl}: ${errorMessage(err)}`);
        return;
      }
      socket = s;
      s.onopen = () => {
        onOpen(s);
      };
      s.onmessage = (event) => {
        onFrame(s, event.data);
      };
      s.onerror = () => {
        // The browser follows an error with a close event, which does the state change.
      };
      s.onclose = (event) => {
        onClose(s, event.code);
      };
    };

    const closeAfterQuit = (sendQuit: boolean): void => {
      const s = socket;
      const phase = get().client.phase;
      if (sendQuit && s !== null && (phase === "registered" || phase === "registering")) {
        sendMessage(s, { command: "QUIT", params: [QUIT_REASON] });
      }
      release(CLOSE_NORMAL, "quit");
      update((c) => {
        const next =
          c.phase === "registering"
            ? stepConnection(c.phase, { type: "user-cancel" })
            : c.phase === "registered"
              ? stepConnection(c.phase, { type: "socket-closed" })
              : "disconnected";
        return { ...c, phase: next };
      });
    };

    const echoSpec = (text: string, own: string): LineSpec => {
      const action = ACTION_RE.exec(text);
      return action !== null
        ? { kind: "action", text: action[1] ?? "", from: own, own: true }
        : { kind: "message", text, from: own, own: true };
    };

    return {
      client: initialState(stored.nick ?? ""),
      ui: {
        nickError: null,
        serverUrlError: null,
        storedNick: stored.nick,
        serverUrl: stored.serverUrl ?? deps.defaultServerUrl,
        mentionSound: false,
        history: EMPTY_HISTORY,
      },

      connect(params) {
        const nick = params.nick.trim();
        const nickError = isValidNick(nick)
          ? null
          : `"${nick}" is not a valid nick (letters, digits and [ ] \\ \` _ ^ { | } -, at most 30, not starting with a digit or "-").`;
        const checked = validateServerUrl(params.serverUrl, deps.allowedOrigins);
        const serverUrlError = checked.ok ? null : checked.error;
        set((s) => ({ ui: { ...s.ui, nickError, serverUrlError } }));
        if (nickError !== null || !checked.ok) return;
        const password = params.password !== undefined && params.password !== "" ? params.password : undefined;
        startConnection({ nick, serverUrl: checked.url, ...(password !== undefined ? { password } : {}) });
      },

      reconnect() {
        if (last === null) {
          status("error", "error: nothing to reconnect to; open the connect dialog first");
          return;
        }
        // Task 6.8: keep lines, clear members, topics and pending WHOIS before reconnecting.
        update(resetForReconnect);
        startConnection(last);
      },

      navigateHistory(direction, current) {
        const moved = navigate(get().ui.history, direction, current);
        set((s) => ({ ui: { ...s.ui, history: moved.history } }));
        return moved.text;
      },

      submitInput(text) {
        set((s) => ({ ui: { ...s.ui, history: pushHistory(s.ui.history, text) } }));
        const client = get().client;
        const active = getOwn(client.windows, client.activeKey);
        const ctx: InputContext = {
          ownNick: client.ownNick,
          active: { kind: active?.kind ?? "status", target: active?.name ?? "" },
          members: Object.values(active?.members ?? {}).map((m) => m.nick),
        };
        let result;
        try {
          result = parseInput(text, ctx);
        } catch (err) {
          update((c) => appendTo(c, c.activeKey, { kind: "error", text: `error: input failed: ${errorMessage(err)}` }, deps.now()));
          return;
        }
        const addLine = (spec: LineSpec, key?: string): void => {
          update((c) => appendTo(c, key ?? c.activeKey, spec, deps.now()));
        };
        switch (result.kind) {
          case "error":
            addLine({ kind: "error", text: result.text });
            return;
          case "local":
            if (result.action.type === "status-line") {
              update((c) => appendStatus(c, { kind: "local", text: result.action.type === "status-line" ? result.action.text : "" }, deps.now()));
            } else {
              const nick = result.action.nick;
              update((c) => openWindow(c, "query", nick, true));
            }
            return;
          case "confirm-paste": {
            const { lines, target } = result;
            update((c) => ({ ...c, paste: { ...c.paste, pending: { lines, target } } }));
            status(
              "local",
              `*** Paste_Confirmation: ${lines.length} lines to ${target}; only the first ${PASTE_MAX_LINES} can be sent. Confirm to send them, or cancel.`,
            );
            return;
          }
          case "send": {
            const s = socket;
            if (s === null || get().client.phase !== "registered") {
              addLine({ kind: "error", text: "error: not connected to a server" });
              return;
            }
            // /msg and /query with text open and activate the Query_Window (R5.4) before the echo lands.
            if (result.openQuery !== undefined) {
              const nick = result.openQuery;
              update((c) => openWindow(c, "query", nick, true));
            }
            if (result.messages.length > 1) {
              // Multi-line paste: first message at once, the rest paced by the Store timer.
              enqueue(result.messages);
              return;
            }
            let quitting = false;
            for (const msg of result.messages) {
              if (!sendMessage(s, msg)) return;
              const upper = msg.command.toUpperCase();
              if (upper === "QUIT") quitting = true;
              if (upper === "NAMES") {
                const channel = msg.params[0] ?? (active?.kind === "channel" ? active.name : undefined);
                if (channel !== undefined) {
                  const key = channelKey(channel);
                  update((c) =>
                    c.expectingNames.includes(key) ? c : { ...c, expectingNames: [...c.expectingNames, key] },
                  );
                }
              }
            }
            // The Ircd does not echo PRIVMSG to the sender, so show the own line here.
            for (const e of result.echo) {
              update((c) => appendTo(c, chatKey(e.target), echoSpec(e.text, c.ownNick), deps.now()));
            }
            // The /quit command already sent QUIT; do not send it a second time.
            if (quitting) closeAfterQuit(false);
            return;
          }
        }
      },

      confirmPaste(accept) {
        const pending = get().client.paste.pending;
        if (pending === undefined) return;
        update((c) => {
          const { pending: _dropped, ...paste } = c.paste;
          void _dropped;
          return { ...c, paste };
        });
        const total = pending.lines.length;
        if (!accept) {
          status("local", `*** Paste cancelled: ${total} lines not sent`);
          return;
        }
        if (socket === null || get().client.phase !== "registered") {
          status("error", "error: not connected to a server; paste not sent");
          return;
        }
        const kept = pending.lines.slice(0, PASTE_MAX_LINES);
        const dropped = total - kept.length;
        if (dropped > 0) {
          status("local", `*** Paste truncated: ${dropped} line${dropped === 1 ? "" : "s"} dropped, sending the first ${kept.length}`);
        }
        enqueue(kept.map((line) => ({ command: "PRIVMSG", params: [pending.target, line] })));
      },

      setActiveWindow(key) {
        update((c) => {
          const win = getOwn(c.windows, key);
          if (win === undefined) return c;
          return {
            ...c,
            activeKey: key,
            windows: withEntry(c.windows, key, { ...win, unread: false, mentioned: false }),
          };
        });
      },

      closeWindow(key) {
        const win = getOwn(get().client.windows, key);
        if (win === undefined || win.kind === "status") return;
        const s = socket;
        if (win.kind === "channel" && s !== null && get().client.phase === "registered") {
          // The reducer closes the window when the Ircd echoes our PART (R5.5).
          sendMessage(s, { command: "PART", params: [win.name] });
          return;
        }
        update((c) => {
          return {
            ...c,
            windows: withoutEntry(c.windows, key),
            order: c.order.filter((k) => k !== key),
            activeKey: c.activeKey === key ? "status" : c.activeKey,
            closedLines: rememberClosed(c, key, win.lines),
          };
        });
      },

      activateByIndex(n) {
        if (!Number.isInteger(n) || n < 1) return;
        const key = get().client.order[n - 1];
        if (key !== undefined) get().setActiveWindow(key);
      },

      quit() {
        closeAfterQuit(true);
      },

      dispose() {
        if (pasteTimer !== null) {
          deps.clearTimeout(pasteTimer);
          pasteTimer = null;
        }
        release(CLOSE_NORMAL, "client closed");
      },

      setMentionSound(enabled) {
        if (enabled && deps.audio !== undefined) {
          try {
            deps.audio.unlock();
            audioUnlocked = true;
          } catch (err) {
            audioUnlocked = false;
            status("error", `error: enabling the mention sound failed: ${errorMessage(err)}`);
            return;
          }
        }
        set((s) => ({ ui: { ...s.ui, mentionSound: enabled } }));
      },
    };
  });

  return store;
}
