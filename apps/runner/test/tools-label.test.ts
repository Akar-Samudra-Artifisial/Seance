import { describe, expect, it } from "vitest";
import { toolsLabel } from "../src/whois/tools-label.js";

describe("toolsLabel (web-client-extras Req 6)", () => {
  it("shows shell(host) when the sandbox is off", () => {
    expect(toolsLabel("fs, git, shell(sandbox)", "none")).toBe("fs, git, shell(host)");
  });

  it("shows shell(sandbox) in podman mode", () => {
    expect(toolsLabel("fs, git, shell(host)", "podman")).toBe("fs, git, shell(sandbox)");
    expect(toolsLabel("fs, git, shell", "podman")).toBe("fs, git, shell(sandbox)");
  });

  it("rewrites a bare shell token and keeps other tools", () => {
    expect(toolsLabel("shell, fs", "none")).toBe("shell(host), fs");
  });

  it("leaves a malformed shell( token as it is (review finding 5)", () => {
    expect(toolsLabel("fs, shell(x", "none")).toBe("fs, shell(x");
    expect(toolsLabel("fs, shell(a(b))", "podman")).toBe("fs, shell(a(b))");
    expect(toolsLabel("shell(x, fs", "podman")).toBe("shell(x, fs");
  });

  it("leaves text without a shell tool alone", () => {
    expect(toolsLabel("fs, git", "podman")).toBe("fs, git");
    expect(toolsLabel("fs, shellcheck", "none")).toBe("fs, shellcheck");
  });
});
