import { loadConfig } from "./config.js";
import type { RouterLogger } from "./command-router.js";
import { createServer } from "./server.js";
import { createIrcHost } from "./runner-wiring.js";
import { ConfigError, createRunner, loadRunnerConfig, redactFields } from "@seance/runner";
import type { LogFields, Runner, RunnerLogger } from "@seance/runner";

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
  debug(fields, message) {
    // Opt-in: only IRCD_DEBUG=1 enables debug output.
    if (process.env["IRCD_DEBUG"] === "1") console.debug(message, redact(fields));
  },
};

/** Runner logger: console output with secret-looking keys redacted. */
const runnerLogger: RunnerLogger = {
  debug(msg, fields: LogFields = {}) {
    if (process.env["IRCD_DEBUG"] === "1") console.debug(msg, redactFields(fields));
  },
  info(msg, fields: LogFields = {}) {
    console.info(msg, redactFields(fields));
  },
  warn(msg, fields: LogFields = {}) {
    console.warn(msg, redactFields(fields));
  },
  error(msg, fields: LogFields = {}) {
    console.error(msg, redactFields(fields));
  },
};

async function main(): Promise<void> {
  const config = loadConfig(process.env);
  const runnerEnabled = process.env["SEANCE_RUNNER"] === "1";
  // The resolver is lazy: the runner needs the server, the server needs the resolver (design D10).
  let runner: Runner | undefined;
  const server = createServer(
    config,
    logger,
    runnerEnabled
      ? { inviteResolver: (t, c, i) => runner?.inviteResolver(t, c, i) ?? false }
      : {},
  );

  if (runnerEnabled) {
    const created = createRunner({
      host: createIrcHost(server),
      config: loadRunnerConfig(process.env),
      ...(config.host !== undefined ? { bindHost: config.host } : {}),
      logger: runnerLogger,
    });
    runner = created;
    try {
      // Load the registry before the first invite can arrive (Req 1.1).
      await created.start();
    } catch (error: unknown) {
      await created.shutdown().catch(() => undefined);
      const kind = error instanceof ConfigError ? "invalid runner configuration" : "runner failed to start";
      console.error(`${kind}: ${error instanceof Error ? error.message : String(error)}`);
      process.exit(1);
    }
  }

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
    const stopRunner: Promise<void> =
      runner === undefined
        ? Promise.resolve()
        : runner.shutdown().then(
            () => undefined,
            (error: unknown) => {
              console.error("runner shutdown failed:", error instanceof Error ? error.message : error);
            },
          );
    stopRunner.then(() => server.stop()).then(
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
