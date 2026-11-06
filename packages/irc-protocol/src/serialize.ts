import type { IrcMessage } from "./parse.js";

/** Maximum wire length of one message, CRLF included, in UTF-8 bytes. */
const MAX_LINE_BYTES = 512;

/** The maximum number of parameters a single message may carry (RFC 2812). */
const MAX_PARAMS = 15;

const encoder = new TextEncoder();

/** True when `value` contains a CR, LF or NUL, which would corrupt framing. */
function hasForbiddenChar(value: string): boolean {
  return /[\r\n\0]/.test(value);
}

/**
 * Serialize an {@link IrcMessage} into one wire line terminated by exactly one
 * CRLF.
 *
 * Emits `:prefix ` when a prefix is present, the upper-cased command, then the
 * params separated by single spaces. The last param is written with a leading
 * `:` when it contains a space, starts with `:`, or is empty.
 *
 * Throws an `Error` (never truncates) when the message cannot be emitted
 * safely: a malformed prefix or command, more than 15 params, a param holding
 * CR, LF or NUL, a non-last param that is empty, contains a space or starts
 * with `:`, or a result longer than 512 UTF-8 bytes including CRLF.
 *
 * Pure: performs no I/O and never mutates its input.
 */
export function serialize(msg: IrcMessage): string {
  const { prefix, command, params } = msg;

  if (prefix !== undefined && (prefix.length === 0 || /[ \r\n\0]/.test(prefix))) {
    throw new Error(
      `cannot serialize message: prefix ${JSON.stringify(prefix)} must be non-empty and contain no space, CR, LF or NUL`,
    );
  }

  if (!/^(?:[A-Za-z]+|[0-9]{3})$/.test(command)) {
    throw new Error(
      `cannot serialize message: command ${JSON.stringify(command)} must be letters or a 3-digit numeric`,
    );
  }

  if (params.length > MAX_PARAMS) {
    throw new Error(
      `cannot serialize message: ${params.length} params exceeds the maximum of ${MAX_PARAMS}`,
    );
  }

  const lastIndex = params.length - 1;
  const parts: string[] = [];
  if (prefix !== undefined) {
    parts.push(`:${prefix}`);
  }
  parts.push(command.toUpperCase());

  params.forEach((param, index) => {
    if (hasForbiddenChar(param)) {
      throw new Error(
        `cannot serialize message: param ${index} contains CR, LF or NUL`,
      );
    }
    if (index === lastIndex) {
      const needsColon =
        param.length === 0 || param.startsWith(":") || param.includes(" ");
      parts.push(needsColon ? `:${param}` : param);
      return;
    }
    if (param.length === 0 || param.startsWith(":") || param.includes(" ")) {
      throw new Error(
        `cannot serialize message: non-last param ${index} must be non-empty, must not start with ":" and must not contain a space`,
      );
    }
    parts.push(param);
  });

  const line = `${parts.join(" ")}\r\n`;
  const bytes = encoder.encode(line).length;
  if (bytes > MAX_LINE_BYTES) {
    throw new Error(
      `cannot serialize message: ${bytes} UTF-8 bytes including CRLF exceeds the ${MAX_LINE_BYTES}-byte limit`,
    );
  }
  return line;
}
