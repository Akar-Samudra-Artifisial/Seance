/**
 * ACP frame parsing and encoding (JSON-RPC 2.0 over newline-delimited JSON).
 * parseFrame is the only place that interprets agent output (Req 2.11, 2.12).
 */

export type Json = null | boolean | number | string | readonly Json[] | { readonly [key: string]: Json };
export type JsonObject = { readonly [key: string]: Json };
export type FrameId = number | string;

export type Frame =
  | { readonly kind: "request"; readonly id: FrameId; readonly method: string; readonly params: JsonObject }
  | { readonly kind: "notification"; readonly method: string; readonly params: JsonObject }
  | { readonly kind: "response"; readonly id: FrameId; readonly result: JsonObject }
  | {
      readonly kind: "error-response";
      readonly id: FrameId;
      readonly code: number;
      readonly message: string;
      readonly data?: Json;
    };

export type FrameError = { readonly kind: "invalid"; readonly reason: string };

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isId(value: unknown): value is FrameId {
  return (typeof value === "number" && Number.isFinite(value)) || typeof value === "string";
}

function invalid(reason: string): FrameError {
  return { kind: "invalid", reason };
}

/** Parse one line of agent output. Never throws. */
export function parseFrame(line: string): Frame | FrameError {
  let raw: unknown;
  try {
    raw = JSON.parse(line);
  } catch (err) {
    return invalid(`not valid JSON: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (!isObject(raw)) return invalid("frame is not a JSON object");
  if (raw["jsonrpc"] !== "2.0") return invalid('jsonrpc is not "2.0"');

  const hasId = "id" in raw;
  const id = raw["id"];
  if (hasId && !isId(id)) return invalid("id is neither a number nor a string");

  const method = raw["method"];
  if (method !== undefined) {
    if (typeof method !== "string" || method.length === 0) return invalid("method is not a non-empty string");
    const params = raw["params"] ?? {};
    if (!isObject(params)) return invalid("params is not an object");
    if (hasId && isId(id)) return { kind: "request", id, method, params };
    return { kind: "notification", method, params };
  }

  if (!hasId || !isId(id)) return invalid("frame has neither method nor id");

  const error = raw["error"];
  if (error !== undefined) {
    if (!isObject(error)) return invalid("error is not an object");
    const code = error["code"];
    const message = error["message"];
    if (typeof code !== "number" || typeof message !== "string") {
      return invalid("error needs a numeric code and a string message");
    }
    const data = error["data"];
    return data === undefined
      ? { kind: "error-response", id, code, message }
      : { kind: "error-response", id, code, message, data };
  }

  const result = raw["result"];
  if (result === undefined) return invalid("response has neither result nor error");
  if (!isObject(result)) return invalid("result is not an object");
  return { kind: "response", id, result };
}

/** Encode helpers: each returns one line terminated by a newline. */
export function encodeRequest(id: FrameId, method: string, params: JsonObject = {}): string {
  return `${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`;
}

export function encodeNotification(method: string, params: JsonObject = {}): string {
  return `${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`;
}

/** The id is echoed unchanged, same type and value (Req 8.9). */
export function encodeResponse(id: FrameId, result: JsonObject): string {
  return `${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`;
}

export function encodeErrorResponse(id: FrameId, code: number, message: string, data?: Json): string {
  const error = data === undefined ? { code, message } : { code, message, data };
  return `${JSON.stringify({ jsonrpc: "2.0", id, error })}\n`;
}
