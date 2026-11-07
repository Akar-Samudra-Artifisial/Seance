import { createRequire } from "node:module";
import { resolve } from "node:path";
import { expect, test } from "@playwright/test";
import { webOrigin, wsPort, wsUrl } from "./harness/env.js";

// `ws` is a dependency of apps/ircd, not of apps/web; resolve it from there instead of adding a dependency.
interface WsClient {
  once(event: "unexpected-response", cb: (req: unknown, res: { statusCode?: number }) => void): void;
  once(event: "open", cb: () => void): void;
  once(event: "error", cb: (err: Error) => void): void;
  close(): void;
  terminate(): void;
}
type WsCtor = new (url: string, options: { headers: Record<string, string> }) => WsClient;
const ircdRequire = createRequire(resolve(process.cwd(), "../ircd/package.json"));
const WebSocketClient = ircdRequire("ws") as WsCtor;

function directive(csp: string, name: string): string {
  const found = csp
    .split(";")
    .map((d) => d.trim())
    .find((d) => d === name || d.startsWith(`${name} `));
  if (found === undefined) throw new Error(`CSP has no ${name} directive: ${csp}`);
  return found;
}

test("every response carries a CSP with a fresh nonce and a strict policy", async ({ request }) => {
  const policies: string[] = [];
  const nonces: string[] = [];
  for (let i = 0; i < 2; i++) {
    const res = await request.get(`${webOrigin()}/`);
    const csp = res.headers()["content-security-policy"];
    expect(csp, "Content-Security-Policy header").toBeTruthy();
    policies.push(csp ?? "");

    const script = directive(csp ?? "", "script-src");
    const match = /'nonce-([^']+)'/.exec(script);
    expect(match, "script-src nonce").not.toBeNull();
    nonces.push(match?.[1] ?? "");
    expect(script).not.toContain("'unsafe-inline'");
    expect(script).not.toContain("'unsafe-eval'");
    expect(directive(csp ?? "", "connect-src")).toBe(`connect-src 'self' ${wsUrl()}`);
    const headers = res.headers();
    expect(headers["x-content-type-options"]).toBe("nosniff");
    expect(headers["referrer-policy"]).toBe("no-referrer");
    expect(headers["permissions-policy"]).toContain("camera=()");
  }
  expect(nonces[0]).not.toBe(nonces[1]);
  expect(policies[0]).not.toBe(policies[1]);
});

test("a page flow raises no CSP violation", async ({ page }) => {
  const consoleMessages: string[] = [];
  page.on("console", (msg) => consoleMessages.push(`${msg.type()}: ${msg.text()}`));
  await page.addInitScript(() => {
    const w = window as unknown as { __cspViolations: string[] };
    w.__cspViolations = [];
    document.addEventListener("securitypolicyviolation", (e) => {
      w.__cspViolations.push(`${e.violatedDirective} blocked ${e.blockedURI}`);
    });
  });

  await page.goto(`${webOrigin()}/`);
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  await dialog.getByLabel("Nick").fill("csp1");
  await dialog.getByRole("button", { name: "Connect" }).click();
  await expect(dialog).toBeHidden();

  const input = page.getByLabel("Message or command");
  await input.fill("/join #csp");
  await input.press("Enter");
  await expect(page.getByRole("list", { name: /^Members of #csp/ }).getByText("@csp1")).toBeVisible();

  const violations = await page.evaluate(() => (window as unknown as { __cspViolations: string[] }).__cspViolations);
  expect(violations).toEqual([]);
  expect(consoleMessages.filter((m) => /content security policy|refused to (load|connect|execute|apply)/i.test(m))).toEqual(
    [],
  );
});

test("the Ircd refuses a WebSocket upgrade from a disallowed origin", async () => {
  const status = await new Promise<number | "opened">((res, rej) => {
    const ws = new WebSocketClient(`ws://127.0.0.1:${wsPort()}`, { headers: { Origin: "http://evil.example" } });
    const timer = setTimeout(() => {
      ws.terminate();
      rej(new Error("no upgrade response within 10s"));
    }, 10_000);
    ws.once("unexpected-response", (_req, response) => {
      clearTimeout(timer);
      ws.terminate();
      res(response.statusCode ?? 0);
    });
    ws.once("open", () => {
      clearTimeout(timer);
      ws.close();
      res("opened");
    });
    ws.once("error", () => undefined); // reported through unexpected-response or the timeout
  });
  expect(status).toBe(403);
});
