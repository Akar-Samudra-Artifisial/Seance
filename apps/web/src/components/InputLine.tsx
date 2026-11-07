"use client";

import { useLayoutEffect, useRef, useState } from "react";
import type { FormEvent, KeyboardEvent, ReactNode } from "react";
import { completeNick } from "../irc/index.js";
import type { CompletionCycle } from "../irc/index.js";
import { useClientStore } from "../store/react.js";

export function InputLine(): ReactNode {
  const submitInput = useClientStore((s) => s.submitInput);
  const navigateHistory = useClientStore((s) => s.navigateHistory);
  const members = useClientStore((s) => s.client.windows[s.client.activeKey]?.members);
  const [text, setText] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const cycle = useRef<CompletionCycle | null>(null);
  const pendingCaret = useRef<number | null>(null);

  // Place the caret after React has written the completed value into the input.
  useLayoutEffect(() => {
    if (pendingCaret.current !== null && inputRef.current !== null) {
      inputRef.current.setSelectionRange(pendingCaret.current, pendingCaret.current);
      pendingCaret.current = null;
    }
  }, [text]);

  const onSubmit = (event: FormEvent): void => {
    event.preventDefault();
    cycle.current = null;
    if (text === "") return;
    submitInput(text);
    setText("");
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>): void => {
    if (event.key === "Tab") {
      event.preventDefault();
      const input = event.currentTarget;
      const nicks = Object.values(members ?? {}).map((m) => m.nick);
      const done = completeNick(input.value, input.selectionStart ?? input.value.length, nicks, cycle.current);
      cycle.current = done.cycle;
      pendingCaret.current = done.caret;
      setText(done.input);
      return;
    }
    // Any other key (modifier presses alone do not end a cycle) resets it.
    if (event.key !== "Shift" && event.key !== "Control" && event.key !== "Alt" && event.key !== "Meta") {
      cycle.current = null;
    }
    if (event.key === "ArrowUp" || event.key === "ArrowDown") {
      event.preventDefault();
      const next = navigateHistory(event.key === "ArrowUp" ? "up" : "down", event.currentTarget.value);
      pendingCaret.current = next.length;
      setText(next);
    }
  };

  return (
    <form onSubmit={onSubmit} className="flex bg-chrome-face p-1">
      <input
        id="input-line"
        ref={inputRef}
        type="text"
        value={text}
        onChange={(e) => {
          setText(e.target.value);
        }}
        onKeyDown={onKeyDown}
        aria-label="Message or command"
        autoComplete="off"
        spellCheck={false}
        className="bevel-sunken w-full bg-ghost-bg px-1 py-0.5 font-chat text-[15px] text-ghost-text focus-visible:outline-2 focus-visible:outline-ghost-orange"
      />
    </form>
  );
}
