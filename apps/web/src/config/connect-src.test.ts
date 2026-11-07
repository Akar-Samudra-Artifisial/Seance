import { describe, expect, it } from "vitest";
import { computeConnectConfig, validateServerUrl } from "./connect-src.js";

describe("computeConnectConfig", () => {
  it("defaults to the local ircd", () => {
    expect(computeConnectConfig({})).toEqual({
      defaultUrl: "ws://127.0.0.1:6668",
      allowedOrigins: ["ws://127.0.0.1:6668"],
    });
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
    expect(c.allowedOrigins).toEqual(["wss://irc.example.com", "ws://127.0.0.1:6668"]);
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
  const allowed = ["wss://irc.example.com", "ws://127.0.0.1:6668"];

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
    for (const raw of ["http://127.0.0.1:6668", "", "not a url"]) {
      const r = validateServerUrl(raw, allowed);
      expect(r.ok).toBe(false);
      if (!r.ok) for (const o of allowed) expect(r.error).toContain(o);
    }
  });
});
