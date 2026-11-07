import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { encodeResponse, parseFrame, type FrameId } from "../src/acp/frames.js";

/**
 * P11: frame boundary totality and id preservation.
 * **Validates: Requirements 2.11, 2.12, 8.9**
 */
const TAG = "Feature: agent-runner, Property 11: parseFrame is total and request ids are echoed unchanged";
const RUNS = { numRuns: 200 } as const;

// ---------- generators ----------

const idArb: fc.Arbitrary<FrameId> = fc.oneof(fc.integer(), fc.string(), fc.uuid());
const KNOWN_METHODS = ["session/request_permission", "session/update", "initialize", "session/prompt"] as const;
const methodArb = fc.oneof(
  fc.constantFrom<string>(...KNOWN_METHODS),
  fc.string({ minLength: 1, maxLength: 24 }),
);
const paramsArb = fc.dictionary(fc.string({ maxLength: 8 }), fc.jsonValue() as fc.Arbitrary<unknown>, { maxKeys: 5 });

const validRequestArb = fc.record({ id: idArb, method: methodArb, params: paramsArb });

const lineArb = fc.oneof(
  fc.string(),
  fc.json(),
  fc.jsonValue().map((v) => JSON.stringify(v)),
  validRequestArb.map((r) => JSON.stringify({ jsonrpc: "2.0", ...r })),
  // structurally close to a frame but with arbitrary field values
  fc
    .record(
      { jsonrpc: fc.jsonValue(), id: fc.jsonValue(), method: fc.jsonValue(), params: fc.jsonValue(), result: fc.jsonValue(), error: fc.jsonValue() },
      { requiredKeys: [] },
    )
    .map((o) => JSON.stringify(o)),
);

describe("P11 frame boundary totality and id preservation", () => {
  it(`${TAG}: parseFrame never throws and returns a frame or invalid`, () => {
    fc.assert(
      fc.property(lineArb, (line) => {
        const out = parseFrame(line);
        expect(["request", "notification", "response", "error-response", "invalid"]).toContain(out.kind);
        if (out.kind === "invalid") expect(out.reason.length).toBeGreaterThan(0);
      }),
      RUNS,
    );
  });

  it(`${TAG}: a request id is parsed unchanged and echoed unchanged by the response`, () => {
    fc.assert(
      fc.property(validRequestArb, (req) => {
        const frame = parseFrame(JSON.stringify({ jsonrpc: "2.0", ...req }));
        expect(frame.kind).toBe("request");
        if (frame.kind !== "request") return;
        expect(frame.id).toBe(req.id);
        expect(typeof frame.id).toBe(typeof req.id);
        expect(frame.method).toBe(req.method);

        const reply = encodeResponse(frame.id, { outcome: { outcome: "cancelled" } });
        expect(reply.endsWith("\n")).toBe(true);
        const echoed = JSON.parse(reply) as { id: unknown };
        expect(echoed.id).toBe(req.id);
        expect(typeof echoed.id).toBe(typeof req.id);
      }),
      RUNS,
    );
  });

  it(`${TAG}: unknown _kiro.dev/* notifications are notification frames`, () => {
    fc.assert(
      fc.property(fc.string({ minLength: 1, maxLength: 24 }), paramsArb, (suffix, params) => {
        const method = `_kiro.dev/${suffix}`;
        const frame = parseFrame(JSON.stringify({ jsonrpc: "2.0", method, params }));
        expect(frame.kind).toBe("notification");
        if (frame.kind === "notification") expect(frame.method).toBe(method);
      }),
      RUNS,
    );
  });

  it("rejects non-JSON, non-objects and wrong jsonrpc versions as invalid", () => {
    for (const line of ["", "not json", "[]", "null", "42", '{"jsonrpc":"1.0","method":"x"}', '{"jsonrpc":"2.0"}']) {
      expect(parseFrame(line).kind).toBe("invalid");
    }
  });
});
