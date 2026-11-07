import { describe, expect, it } from "vitest";
import { computeConnectConfig, validateServerUrl } from "./connect-src.js";

describe("computeConnectConfig", () => {
  it("defaults to the local ircd", () => {
    expect(computeConnectConfig({})).toEqual({
      defaultUrl: "ws://127.0.0.1:6680",
      allowedOrigins: ["ws://127.0.0.1:6680"],
    });
  });

  it("uses a default port that is not a Fetch bad port", () => {
    // Fetch Standard "bad port" list: browsers fail these with net::ERR_UNSAFE_PORT.
    const BAD_PORTS = new Set([
      1, 7, 9, 11, 13, 15, 17, 19, 20, 21, 22, 23, 25, 37, 42, 43, 53, 69, 77, 79, 87, 95, 101, 102, 103, 104,
      109, 110, 111, 113, 115, 117, 119, 123, 135, 137, 139, 143, 161, 179, 389, 427, 465, 512, 513, 514, 515,
      526, 530, 531, 532, 540, 548, 554, 556, 563, 587, 601, 636, 989, 990, 993, 995, 1719, 1720, 1723, 2049,
      3659, 4045, 4190, 5060, 5061, 6000, 6566, 6665, 6666, 6667, 6668, 6669, 6679, 6697, 10080,
    ]);
    const { defaultUrl } = computeConnectConfig({});
    const port = Number(new URL(defaultUrl).port);
    expect(port).toBeGreaterThan(0);
    expect(BAD_PORTS.has(port), `port ${port} is blocked by browsers`).toBe(false);
  });

  it("uses the configured URL origin", () => {
    const c = computeConnectConfig({ NEXT_PUBLIC_IRCD_WS_URL: "wss://Irc.Example.com/ws" });
    expect(c.defaultUrl).toBe("wss://Irc.Example.com/ws");
    expect(c.allowedOrigins).toEqual(["wss://irc.example.com"]);
  });

  it("adds the local origin in development", () => {
    const c = computeConnectConfig({
      NEXT_PUBLIC_IRCD_WS_URL: "wss://irc.example.com",
      NODE_ENV: "development",
    });
    expect(c.allowedOrigins).toEqual(["wss://irc.example.com", "ws://127.0.0.1:6680"]);
  });

  it("throws on a non-ws scheme", () => {
    expect(() => computeConnectConfig({ NEXT_PUBLIC_IRCD_WS_URL: "http://x.test" })).toThrow(
      /NEXT_PUBLIC_IRCD_WS_URL.*ws: or wss:/,
    );
    expect(() => computeConnectConfig({ NEXT_PUBLIC_IRCD_WS_URL: "nonsense" })).toThrow(
      /NEXT_PUBLIC_IRCD_WS_URL/,
    );
  });
});

describe("validateServerUrl origin", () => {
  it("reports the bare origin for a URL with a path", () => {
    const r = validateServerUrl("wss://irc.example.com/ws", ["wss://irc.example.com"]);
    expect(r).toMatchObject({ ok: true, origin: "wss://irc.example.com" });
  });
});

describe("validateServerUrl", () => {
  const allowed = ["wss://irc.example.com", "ws://127.0.0.1:6680"];

  it("accepts an allowed origin with a path", () => {
    expect(validateServerUrl("wss://IRC.example.com/ws", allowed)).toMatchObject({
      ok: true,
      origin: "wss://irc.example.com",
    });
  });

  it("rejects a disallowed origin naming every allowed origin", () => {
    const r = validateServerUrl("wss://evil.test", allowed);
    expect(r.ok).toBe(false);
    if (!r.ok) for (const o of allowed) expect(r.error).toContain(o);
  });

  it("rejects userinfo, query and fragment", () => {
    for (const raw of [
      "wss://user:pw@irc.example.com",
      "wss://user@irc.example.com",
      "wss://irc.example.com/?token=1",
      "wss://irc.example.com/ws#frag",
      "wss://irc.example.com?",
    ]) {
      const r = validateServerUrl(raw, allowed);
      expect(r.ok, raw).toBe(false);
    }
  });

  it("rejects bad schemes and garbage", () => {
    for (const raw of ["http://127.0.0.1:6680", "", "not a url"]) {
      const r = validateServerUrl(raw, allowed);
      expect(r.ok).toBe(false);
      if (!r.ok) for (const o of allowed) expect(r.error).toContain(o);
    }
  });
});
