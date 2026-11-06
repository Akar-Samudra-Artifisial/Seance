import { loadConfig } from "./config.js";
import type { RouterLogger } from "./command-router.js";
import { createServer } from "./server.js";

/** Keys whose values must never reach the logs. */
const SECRET_KEY = /pass|secret|token|key/i;

function redact(fields: Readonly<Record<string, unknown>>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(fields)) {
    if (SECRET_KEY.test(key)) out[key] = "[redacted]";
    else if (value instanceof Error) out[key] = value.message;
    else out[key] = value;
  }
  return out;
}

const logger: RouterLogger = {
  error(fields, message) {
    console.error(message, redact(fields));
  },
};

async function main(): Promise<void> {
  const config = loadConfig(process.env);
  const server = createServer(config, logger);

  // Mode and kick events are the hooks the agent runner will consume (Req 9.10, 10.4).
  server.events.subscribe("irc.mode", (e) => {
    console.info(`mode ${e.channel} ${e.adding ? "+" : "-"}${e.mode} by ${e.by}`);
  });
  server.events.subscribe("irc.kick", (e) => {
    console.info(`kick ${e.channel} ${e.target} by ${e.by}`);
  });

  const ports = await server.start();
  console.info(
    `ircd "${config.serverName}" listening: tcp=${ports.tcpPort} ws=${ports.wsPort} password=${
      config.serverPassword === undefined ? "off" : "on"
    }`,
  );

  const shutdown = (signal: string): void => {
    console.info(`received ${signal}, shutting down`);
    server.stop().then(
      () => process.exit(0),
      (error: unknown) => {
        console.error("shutdown failed:", error instanceof Error ? error.message : error);
        process.exit(1);
      },
    );
  };
  process.once("SIGINT", () => shutdown("SIGINT"));
  process.once("SIGTERM", () => shutdown("SIGTERM"));
}

main().catch((error: unknown) => {
  console.error("ircd failed to start:", error instanceof Error ? error.message : error);
  process.exit(1);
});
