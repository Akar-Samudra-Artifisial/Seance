import { createServer } from "node:net";

/**
 * Finds a free TCP port on 127.0.0.1 by listening on port 0, reading the
 * assigned port and closing the listener again.
 */
export function freePort(): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const probe = createServer();
    probe.once("error", (error) => {
      reject(new Error(`could not probe for a free port on 127.0.0.1: ${error.message}`));
    });
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      if (address === null || typeof address === "string") {
        probe.close();
        reject(new Error("could not probe for a free port: the listener has no TCP address"));
        return;
      }
      const { port } = address;
      probe.close((error) => {
        if (error) reject(new Error(`could not close the port probe on ${port}: ${error.message}`));
        else resolve(port);
      });
    });
  });
}
