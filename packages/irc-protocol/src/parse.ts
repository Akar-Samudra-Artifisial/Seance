/**
 * A single IRC message (RFC 2812 §2.3.1), without the trailing CRLF.
 *
 * `params` holds every parameter in order; the trailing parameter (the one
 * introduced by `:`) is stored as the last element without its colon.
 */
export interface IrcMessage {
  /** Message prefix (server name or `nick!user@host`), without the leading `:`. */
  readonly prefix?: string;
  /** Command word (e.g. `PRIVMSG`) or three-digit numeric reply (e.g. `433`). */
  readonly command: string;
  /** Up to 15 parameters, in order. */
  readonly params: readonly string[];
}

/**
 * Sentinel returned by {@link parse} for a line that does not conform to the
 * RFC 2812 grammar. `parse` returns this instead of throwing so a transport can
 * drop the offending line without a try/catch around every message (Req 1.5).
 */
export interface ParseError {
  readonly kind: "parse-error";
  /** Human-readable reason the line could not be parsed. */
  readonly reason: string;
}

/** The maximum number of parameters a single message may carry (RFC 2812). */
const MAX_PARAMS = 15;

/** Narrow a {@link parse} result to the {@link ParseError} sentinel. */
export function isParseError(
  result: IrcMessage | ParseError,
): result is ParseError {
  return (result as Partial<ParseError>).kind === "parse-error";
}

function fail(reason: string): ParseError {
  return { kind: "parse-error", reason };
}

/**
 * A command is either a run of ASCII letters or exactly three digits
 * (a numeric reply). Matching elsewhere is case-insensitive; here we only
 * validate the shape and leave uppercasing to {@link parse}.
 */
function isValidCommand(command: string): boolean {
  return /^[A-Za-z]+$/.test(command) || /^[0-9]{3}$/.test(command);
}

/**
 * Parse one raw IRC line into an {@link IrcMessage}.
 *
 * Applies the RFC 2812 message grammar: an optional `:`-prefixed source,
 * a command (letters or a 3-digit numeric), and up to 15 space-separated
 * parameters where a parameter beginning with `:` is the trailing parameter
 * and consumes the rest of the line (its `:` stripped).
 *
 * Tolerates a bare LF, strips a trailing CRLF or LF, and uppercases the
 * command. Returns a {@link ParseError} sentinel — never throws — for a line
 * that is empty, has no command, has a malformed command, or carries more than
 * 15 parameters (Req 1.1, 1.4, 1.6).
 *
 * This function is pure and performs no I/O; it never mutates its input.
 */
export function parse(line: string): IrcMessage | ParseError {
  // Strip a single trailing CRLF or bare LF. A bare CR is not a terminator.
  let rest = line;
  if (rest.endsWith("\r\n")) {
    rest = rest.slice(0, -2);
  } else if (rest.endsWith("\n")) {
    rest = rest.slice(0, -1);
  }

  if (rest.length === 0) {
    return fail("empty line");
  }

  let prefix: string | undefined;

  // Optional prefix: ':' immediately followed by the source token, then at
  // least one space separating it from the command.
  if (rest.startsWith(":")) {
    const spaceIndex = rest.indexOf(" ");
    if (spaceIndex === -1) {
      return fail("prefix without command");
    }
    const token = rest.slice(1, spaceIndex);
    if (token.length === 0) {
      return fail("empty prefix");
    }
    prefix = token;
    // Skip the prefix and any run of spaces before the command.
    rest = rest.slice(spaceIndex + 1).replace(/^ +/, "");
  }

  if (rest.length === 0) {
    return fail("missing command");
  }

  // Command: up to the next space, or the whole remainder.
  const commandEnd = rest.indexOf(" ");
  const rawCommand = commandEnd === -1 ? rest : rest.slice(0, commandEnd);
  if (!isValidCommand(rawCommand)) {
    return fail(`invalid command "${rawCommand}"`);
  }
  const command = rawCommand.toUpperCase();

  const params: string[] = [];
  let paramsRest = commandEnd === -1 ? "" : rest.slice(commandEnd + 1);

  // Parameters: space-separated. A parameter starting with ':' is the trailing
  // parameter and takes the remainder of the line verbatim.
  while (paramsRest.length > 0) {
    // Collapse leading spaces between parameters.
    paramsRest = paramsRest.replace(/^ +/, "");
    if (paramsRest.length === 0) {
      break;
    }

    if (paramsRest.startsWith(":")) {
      params.push(paramsRest.slice(1));
      paramsRest = "";
      break;
    }

    const nextSpace = paramsRest.indexOf(" ");
    if (nextSpace === -1) {
      params.push(paramsRest);
      paramsRest = "";
    } else {
      params.push(paramsRest.slice(0, nextSpace));
      paramsRest = paramsRest.slice(nextSpace + 1);
    }
  }

  if (params.length > MAX_PARAMS) {
    return fail(`too many parameters (${params.length} > ${MAX_PARAMS})`);
  }

  // Only include `prefix` when present: exactOptionalPropertyTypes forbids an
  // explicit `undefined` for an optional property.
  return prefix === undefined
    ? { command, params }
    : { prefix, command, params };
}
