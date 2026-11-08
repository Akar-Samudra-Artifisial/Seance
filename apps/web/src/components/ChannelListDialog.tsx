"use client";

import { useMemo, useState } from "react";
import type { FormEvent, KeyboardEvent, ReactNode } from "react";
import { NickAgentResearcher } from "../icons/index.js";
import { NO_FILTER, filterRows, formatClock, nextSort, plain, sortRows, summarise } from "../irc/index.js";
import type { ListRow, RowFilter, SortColumn, SortState } from "../irc/index.js";
import { useClientStore } from "../store/react.js";
import { Dialog } from "./Dialog.js";

const COLUMNS: readonly { readonly id: SortColumn; readonly label: string; readonly width: string }[] = [
  { id: "channel", label: "Channel", width: "w-[170px]" },
  { id: "agents", label: "Agents", width: "w-[80px]" },
  { id: "users", label: "Users", width: "w-[70px]" },
  { id: "topic", label: "Topic", width: "" },
];

const fieldClass =
  "bevel-field bg-ghost-bg px-1 font-chat text-[13px] text-ghost-text focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ghost-orange";
const buttonClass =
  "hit-target bevel-button active:bevel-button-pressed h-[23px] bg-chrome-face px-3 text-xs text-chrome-outline focus-visible:outline-2 focus-visible:-outline-offset-4 focus-visible:outline-chrome-outline aria-disabled:text-chrome-shadow";

const HINT =
  "Up and Down choose a channel, Enter or a double-click joins it, click a column header to sort, Esc closes.";

function ariaSort(sort: SortState | undefined, column: SortColumn): "ascending" | "descending" | "none" {
  if (sort === undefined || sort.column !== column) return "none";
  return sort.direction === "asc" ? "ascending" : "descending";
}

function Rows(props: {
  readonly rows: readonly ListRow[];
  readonly selected: string | null;
  readonly onSelect: (name: string) => void;
  readonly onJoin: (name: string) => void;
}): ReactNode {
  const { rows, selected, onSelect, onJoin } = props;
  // Roving tabindex: the selected row, or the first one, is the Tab stop.
  const stop = rows.some((r) => r.name === selected) ? selected : (rows[0]?.name ?? null);
  const move = (target: HTMLElement | null | undefined): void => {
    target?.focus();
  };
  const onKeyDown = (event: KeyboardEvent<HTMLTableSectionElement>): void => {
    const list = Array.from(event.currentTarget.querySelectorAll<HTMLElement>("tr[data-channel]"));
    const at = list.findIndex((el) => el === document.activeElement);
    switch (event.key) {
      case "ArrowDown":
        event.preventDefault();
        move(list[Math.min(at + 1, list.length - 1)]);
        return;
      case "ArrowUp":
        event.preventDefault();
        move(list[Math.max(at - 1, 0)]);
        return;
      case "Home":
        event.preventDefault();
        move(list[0]);
        return;
      case "End":
        event.preventDefault();
        move(list[list.length - 1]);
        return;
      case "Enter": {
        const name = list[at]?.dataset["channel"];
        if (name !== undefined) {
          event.preventDefault();
          onJoin(name);
        }
        return;
      }
      default:
    }
  };
  return (
    <tbody onKeyDown={onKeyDown}>
      {rows.map((row) => {
        const isSelected = row.name === selected;
        const topic = plain(row.topic);
        return (
          <tr
            key={row.name}
            data-channel={row.name}
            tabIndex={row.name === stop ? 0 : -1}
            aria-selected={isSelected}
            onFocus={() => {
              onSelect(row.name);
            }}
            onClick={() => {
              onSelect(row.name);
            }}
            onDoubleClick={() => {
              onJoin(row.name);
            }}
            className={`h-[22px] cursor-default font-chat text-[13px] focus-visible:outline-1 focus-visible:-outline-offset-2 focus-visible:outline-dotted ${
              isSelected ? "bg-title-from text-chrome-highlight" : "text-ghost-text"
            }`}
          >
            <td className="w-[170px] truncate px-1">{plain(row.name)}</td>
            <td className="w-[80px] px-1">
              <span className="inline-flex items-center gap-1">
                {row.agents !== null && row.agents > 0 ? (
                  <NickAgentResearcher className="block h-[10px] w-[8px] shrink-0" />
                ) : null}
                {row.agents === null ? (
                  <span title="Not known yet" aria-label="not known yet">
                    —
                  </span>
                ) : (
                  row.agents
                )}
              </span>
            </td>
            <td className="w-[70px] px-1">{row.users}</td>
            <td className="truncate px-1" title={topic === "" ? undefined : topic}>
              {topic}
            </td>
          </tr>
        );
      })}
    </tbody>
  );
}

/** Channel list (Figma frame 05): filters, sortable columns, Join on Enter or double-click. */
export function ChannelListDialog(): ReactNode {
  const open = useClientStore((s) => s.ui.channelListOpen);
  if (!open) return null;
  return <ChannelListBody />;
}

function ChannelListBody(): ReactNode {
  const list = useClientStore((s) => s.client.list);
  const server = useClientStore((s) => s.client.server ?? "server");
  const refresh = useClientStore((s) => s.refreshChannelList);
  const close = useClientStore((s) => s.closeChannelList);
  const join = useClientStore((s) => s.joinFromList);
  const [text, setText] = useState("");
  const [minAgents, setMinAgents] = useState("0");
  const [hideEmpty, setHideEmpty] = useState(false);
  const [applied, setApplied] = useState<RowFilter>(NO_FILTER);
  const [sort, setSort] = useState<SortState | undefined>(undefined);
  const [selected, setSelected] = useState<string | null>(null);
  const [helpOpen, setHelpOpen] = useState(false);

  const rows = list?.rows;
  const shown = useMemo(() => sortRows(filterRows(rows ?? [], applied), sort), [rows, applied, sort]);
  const status = list?.status ?? "loading";
  const { channels, agents } = summarise(shown);
  const selectedRow = shown.find((r) => r.name === selected);

  const apply = (event?: FormEvent): void => {
    event?.preventDefault();
    const n = Number.parseInt(minAgents, 10);
    setApplied({ text, minAgents: Number.isFinite(n) && n > 0 ? n : 0, hideEmptyTopics: hideEmpty });
  };

  let body: ReactNode = null;
  if (status === "loading") body = "Loading…";
  else if (status === "failed" && shown.length === 0) body = "The server did not finish the list. Choose Refresh to try again.";
  else if ((rows?.length ?? 0) === 0) body = "No channels";
  else if (shown.length === 0) body = "No channel matches the filter";

  const footer =
    status === "loading"
      ? "Loading…"
      : `${String(channels)} channel${channels === 1 ? "" : "s"} · ${String(agents)} agent${agents === 1 ? "" : "s"}${
          list?.listedAt !== undefined ? ` · listed ${formatClock(list.listedAt, -new Date().getTimezoneOffset())}` : ""
        }${list?.truncated === true ? " · list cut at 500 channels" : ""}${status === "failed" ? " · incomplete" : ""}`;

  return (
    <Dialog
      title={`Channels List — ${plain(server)}`}
      titleId="channel-list-title"
      onClose={close}
      onHelp={() => {
        setHelpOpen((v) => !v);
      }}
      helpExpanded={helpOpen}
      helpControls="channel-list-hint"
      className="h-[470px] w-[860px] max-h-full"
    >
      <form onSubmit={apply} className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1 px-2 py-2">
        <label htmlFor="list-match" className="flex items-center gap-1">
          Match text:
          <input
            id="list-match"
            data-autofocus
            type="text"
            value={text}
            onChange={(e) => {
              setText(e.target.value);
            }}
            autoComplete="off"
            spellCheck={false}
            className={`${fieldClass} h-[21px] w-[200px]`}
          />
        </label>
        <label htmlFor="list-min" className="flex items-center gap-1">
          Min agents:
          <input
            id="list-min"
            type="number"
            min={0}
            max={999}
            value={minAgents}
            onChange={(e) => {
              setMinAgents(e.target.value);
            }}
            className={`${fieldClass} h-[21px] w-[60px]`}
          />
        </label>
        <label htmlFor="list-hide" className="flex items-center gap-1">
          <input
            id="list-hide"
            type="checkbox"
            checked={hideEmpty}
            onChange={(e) => {
              setHideEmpty(e.target.checked);
            }}
            className="size-3.5"
          />
          Hide channels without a topic
        </label>
        <button type="submit" className={`${buttonClass} w-[92px]`}>
          Apply filter
        </button>
      </form>
      {helpOpen ? (
        <p id="channel-list-hint" className="px-2 pb-1">
          {HINT}
        </p>
      ) : null}
      <div className="bevel-sunken mx-2 flex min-h-0 flex-1 flex-col bg-ghost-bg">
        <div className="win95-scroll-y min-h-0 flex-1">
          <table className="w-full table-fixed border-collapse">
            <thead className="sticky top-0 z-10">
              <tr>
                {COLUMNS.map((c) => (
                  <th key={c.id} scope="col" aria-sort={ariaSort(sort, c.id)} className={`${c.width} p-0 text-left font-normal`}>
                    <button
                      type="button"
                      onClick={() => {
                        setSort((s) => nextSort(s, c.id));
                      }}
                      title={`Sort by ${c.label}`}
                      className="bevel-button active:bevel-button-pressed flex h-5 w-full items-center bg-chrome-face px-1 text-left text-xs text-chrome-outline focus-visible:outline-2 focus-visible:-outline-offset-4 focus-visible:outline-chrome-outline"
                    >
                      {c.label}
                      <span aria-hidden="true" className="ml-1">
                        {sort?.column === c.id ? (sort.direction === "asc" ? "▲" : "▼") : ""}
                      </span>
                    </button>
                  </th>
                ))}
              </tr>
            </thead>
            {body === null ? <Rows rows={shown} selected={selected} onSelect={setSelected} onJoin={join} /> : null}
          </table>
          {body !== null ? (
            <p role="status" className="px-2 py-2 font-chat text-[13px] text-ghost-text">
              {body}
            </p>
          ) : null}
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-2 px-2 py-2">
        <p aria-live="polite" className="min-w-0 flex-1 truncate text-chrome-outline">
          {footer}
        </p>
        <button
          type="button"
          aria-disabled={selectedRow === undefined ? "true" : undefined}
          title={selectedRow === undefined ? "Choose a channel first" : `Join ${plain(selectedRow.name)}`}
          aria-description={selectedRow === undefined ? "Choose a channel first" : undefined}
          onClick={() => {
            if (selectedRow !== undefined) join(selectedRow.name);
          }}
          className={`${buttonClass} h-[25px] w-[90px] font-bold`}
        >
          Join
        </button>
        <button type="button" onClick={refresh} className={`${buttonClass} w-[88px]`}>
          Refresh
        </button>
        <button type="button" onClick={close} className={`${buttonClass} w-[88px]`}>
          Close
        </button>
      </div>
    </Dialog>
  );
}
