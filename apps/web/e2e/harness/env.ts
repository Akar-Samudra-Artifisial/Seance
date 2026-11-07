/** Environment variable names the stack harness uses to hand its ports to the specs. */
export const E2E_WEB_PORT = "E2E_WEB_PORT";
export const E2E_WS_PORT = "E2E_WS_PORT";

function requirePort(name: string): number {
  const raw = process.env[name];
  const port = raw === undefined ? NaN : Number(raw);
  if (!Number.isInteger(port) || port <= 0) {
    throw new Error(`${name} is not set; the e2e stack must be started by e2e/playwright.config.ts globalSetup`);
  }
  return port;
}

export const webPort = (): number => requirePort(E2E_WEB_PORT);
export const wsPort = (): number => requirePort(E2E_WS_PORT);
/** Origin of the production web server, as the browser sees it (and the Ircd allow-lists it). */
export const webOrigin = (): string => `http://127.0.0.1:${webPort()}`;
export const wsUrl = (): string => `ws://127.0.0.1:${wsPort()}`;
