"use client";

import { useLayoutEffect, useRef, useState } from "react";
import type { FormEvent, KeyboardEvent, ReactNode } from "react";
import { completeNick, cycleActive } from "../irc/index.js";
import type { CompletionCycle } from "../irc/index.js";
import { INPUT_KEYS } from "../shortcuts/shortcuts.js";
import { useClientStore } from "../store/react.js";

export function InputLine(): ReactNode {
  const submitInput = useClientStore((s) => s.submitInput);
  const navigateHistory = useClientStore((s) => s.navigateHistory);
  const members = useClientStore((s) => s.client.windows[s.client.activeKey]?.members);
  const [text, setText] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const cycle = useRef<CompletionCycle | null>(null);
  const pendingCaret = useRef<number | null>(null);

  // A menu item prefilled the line: take the text, clear the slot and focus (R2.5).
  const draft = useClientStore((s) => s.ui.draft);
  const clearDraft = useClientStore((s) => s.clearDraft);
  // The text is adopted while rendering (derived-state pattern); the effect only does side effects.
  const [seenDraft, setSeenDraft] = useState<string | null>(null);
  if (draft !== seenDraft && (draft !== null || seenDraft !== null)) {
    setSeenDraft(draft);
    if (draft !== null) setText(draft);
  }
  useLayoutEffect(() => {
    if (draft === null) return;
    cycle.current = null;
    pendingCaret.current = draft.length;
    clearDraft();
    inputRef.current?.focus();
  }, [draft, clearDraft]);

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
    if (event.key === INPUT_KEYS.complete) {
      const input = event.currentTarget;
      const caret = input.selectionStart ?? input.value.length;
      // Audit 10.15: Tab must not trap keyboard users. Shift+Tab moves focus back unless it is stepping
      // through an active completion; Tab moves focus on when there is nothing to complete.
      if (event.shiftKey && !cycleActive(input.value, caret, cycle.current)) {
        cycle.current = null;
        return;
      }
      const nicks = Object.values(members ?? {}).map((m) => m.nick);
      const done = completeNick(input.value, caret, nicks, cycle.current, event.shiftKey ? -1 : 1);
      if (done.cycle === null) {
        cycle.current = null;
        return;
      }
      event.preventDefault();
      cycle.current = done.cycle;
      pendingCaret.current = done.caret;
      setText(done.input);
      return;
    }
    // Any other key (modifier presses alone do not end a cycle) resets it.
    if (event.key !== "Shift" && event.key !== "Control" && event.key !== "Alt" && event.key !== "Meta") {
      cycle.current = null;
    }
    if (event.key === INPUT_KEYS.historyUp || event.key === INPUT_KEYS.historyDown) {
      event.preventDefault();
      const next = navigateHistory(event.key === INPUT_KEYS.historyUp ? "up" : "down", event.currentTarget.value);
      pendingCaret.current = next.length;
      setText(next);
    }
  };

  return (
    // Input field (R1.1, R1.5): 24 px, two-step sunken bevel, text 8 px from the left, orange caret.
    <form onSubmit={onSubmit} className="mt-0.5 flex shrink-0 bg-chrome-face">
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
        className="bevel-field h-(--layout-input) w-full min-w-0 bg-ghost-bg px-2 py-0 font-chat text-[15px] leading-(--layout-input) text-ghost-text pointer-coarse:h-8 pointer-coarse:leading-8 caret-ghost-orange focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ghost-orange"
      />
    </form>
  );
}
