// IRC_Core public exports. Pure TypeScript: no React, DOM, Node or Zustand imports.
export type {
  ClientState,
  ConnectParams,
  ConnectionPhase,
  ExorcismParts,
  Line,
  LineKind,
  Member,
  PasteState,
  Window,
  WindowKind,
  WhoisPending,
} from "./types.js";
export {
  BUFFER_CAP,
  FRAME_MAX_BYTES,
  HISTORY_MAX,
  LINE_MAX_BYTES,
  PASTE_INTERVAL_MS,
  PASTE_MAX_LINES,
} from "./types.js";
export { irc_lower, isValidNick, keyOf } from "./casemap.js";
export { appendLine } from "./buffer.js";
export { formatClock } from "./time.js";
export type { MentionSegment } from "./mention.js";
export { isMention, mentionSegments } from "./mention.js";
export type { Span } from "./formatter.js";
export { formatIrc, hasVisibleText } from "./formatter.js";
export type { Segment } from "./linkify.js";
export { linkify } from "./linkify.js";
export type { DecodedFrame, DecodedLine, DecodedOverlong } from "./framing.js";
export { decodeFrames } from "./framing.js";
export { stepConnection } from "./connection.js";
export type { ConnectionEvent } from "./connection.js";
export { PASTE_LIMITS, splitPaste } from "./paste.js";
export { memberPrefix, sortMembers } from "./nick-order.js";
export type { History, HistoryDirection, NavigateResult } from "./history.js";
export { EMPTY_HISTORY, navigate, pushHistory } from "./history.js";
export type { Classification, ClassifyInput } from "./classify.js";
export { EVENT_LINE_KINDS, GATED_KINDS, KNOWN_AGENTS, classifyLine, isKnownAgent, markersFor } from "./classify.js";
export type { ReduceResult } from "./reducer.js";
export { initialState, reduce } from "./reducer.js";
export type { CreditsLine, StatusCounts } from "./selectors.js";
export {
  creditsTotal,
  exorcismText,
  modeSuffix,
  parseCreditsLine,
  plain,
  statusCounts,
  titleOf,
} from "./selectors.js";
export { resetForReconnect } from "./reset.js";
export type { ChannelList, ListRow } from "./types.js";
export { LIST_ROWS_MAX } from "./types.js";
export type { RowFilter, SortColumn, SortDirection, SortState } from "./channel-list.js";
export { NO_FILTER, batchNames, filterRows, nextSort, parseListRow, sortRows, summarise } from "./channel-list.js";
export { failList, startList } from "./reducer.list.js";
export type { Completion, CompletionCycle } from "./complete.js";
export { completeNick } from "./complete.js";
export type { EchoLine, InputContext, InputResult, LocalAction } from "./command-parser.js";
export { parseInput } from "./command-parser.js";
