import type { RunnerLogger } from "../log.js";
import type { IrcHost, ServiceName } from "../ports.js";

/** The runner's voice as ChanServ and NickServ (runner-services Req 2.5, 2.6). */
export interface RunnerServices {
  /** ChanServ notice to a channel; false when the channel does not exist or delivery failed. */
  chanServ(channel: string, text: string): boolean;
  /** NickServ notice to one nick; false when the nick is not registered or delivery failed. */
  nickServ(nick: string, text: string): boolean;
}

/** Wraps `IrcHost.serviceNotice`: logs failures with service, target and cause, never throws. */
export function createServices(deps: {
  readonly host: Pick<IrcHost, "serviceNotice">;
  readonly logger: RunnerLogger;
}): RunnerServices {
  const send = (service: ServiceName, target: string, text: string): boolean => {
    try {
      const ok = deps.host.serviceNotice(service, target, text);
      if (!ok) deps.logger.debug("service notice not delivered: no such target", { service, target });
      return ok;
    } catch (err) {
      deps.logger.error("service notice failed", {
        service,
        target,
        reason: err instanceof Error ? err.message : String(err),
      });
      return false;
    }
  };
  return {
    chanServ: (channel, text) => send("ChanServ", channel, text),
    nickServ: (nick, text) => send("NickServ", nick, text),
  };
}
