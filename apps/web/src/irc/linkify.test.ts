import { describe, expect, it } from "vitest";
import { linkify } from "./linkify.js";

const joined = (s: string): string =>
  linkify(s)
    .map((x) => x.text)
    .join("");

describe("linkify", () => {
  it("links a plain https URL", () => {
    expect(linkify("see https://a.b/c?d now")).toEqual([
      { kind: "text", text: "see " },
      { kind: "link", text: "https://a.b/c?d", href: "https://a.b/c?d" },
      { kind: "text", text: " now" },
    ]);
  });

  it("links http URLs", () => {
    const [seg] = linkify("http://example.com");
    expect(seg).toEqual({ kind: "link", text: "http://example.com", href: "http://example.com" });
  });

  it("leaves trailing punctuation outside the link", () => {
    expect(linkify("go to https://a.b/c.")).toEqual([
      { kind: "text", text: "go to " },
      { kind: "link", text: "https://a.b/c", href: "https://a.b/c" },
      { kind: "text", text: "." },
    ]);
    expect(linkify("(https://a.b/c)")[1]).toMatchObject({ kind: "link", text: "https://a.b/c" });
    expect(linkify("https://a.b/x_(y)")[0]).toMatchObject({ kind: "link", text: "https://a.b/x_(y)" });
    expect(linkify("https://a.b/c?!,")[0]).toMatchObject({ text: "https://a.b/c" });
  });

  it("does not link URLs with userinfo", () => {
    for (const s of ["https://trusted.com@evil.example/x", "http://user:pw@host.test", "https://a@b"]) {
      expect(linkify(s)).toEqual([{ kind: "text", text: s }]);
    }
    // An @ in the path is fine.
    expect(linkify("https://host.test/@user")).toEqual([
      { kind: "link", text: "https://host.test/@user", href: "https://host.test/@user" },
    ]);
  });

  it("keeps other schemes as text", () => {
    for (const s of ["javascript:alert(1)", "data:text/html,x", "ftp://a.b", "mailto:a@b.c"]) {
      expect(linkify(s)).toEqual([{ kind: "text", text: s }]);
    }
  });

  it("does not link a bare scheme or non-boundary match", () => {
    expect(linkify("http://")).toEqual([{ kind: "text", text: "http://" }]);
    expect(linkify("xhttp://a.b")).toEqual([{ kind: "text", text: "xhttp://a.b" }]);
  });

  it("handles empty input and preserves text", () => {
    expect(linkify("")).toEqual([]);
    const s = "a https://x.y, b javascript:1 https://z.w/!";
    expect(joined(s)).toBe(s);
  });
});
