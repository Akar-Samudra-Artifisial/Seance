# @seance/web

The Séance web client: a retro, keyboard-first IRC client built with Next.js, Tailwind and Zustand. It speaks plain IRC over WebSocket to the Ircd. See [DESIGN.md](../../DESIGN.md) for the UI design.

## Run against a local Ircd

1. Start the Ircd and allow the origin the browser will use:

   ```sh
   IRCD_WS_ALLOWED_ORIGINS=http://localhost:3000 pnpm --filter @seance/ircd dev
   ```

2. Start the web client:

   ```sh
   pnpm --filter @seance/web dev
   ```

3. Open `http://localhost:3000`, pick a nick, connect, then `/join #test`.

The Ircd listens for WebSocket clients on port 6680 by default, which matches the default `NEXT_PUBLIC_IRCD_WS_URL` of `ws://127.0.0.1:6680`. Browsers refuse ports 6665-6669 (Fetch "bad port", `net::ERR_UNSAFE_PORT`), so the Ircd rejects those values for `IRCD_WS_PORT`; TCP 6667 for classic IRC clients is unaffected.

### Allowed origins

`IRCD_WS_ALLOWED_ORIGINS` is read by the Ircd, not by the web app. It is a comma-separated list of origins (`scheme://host[:port]`, no path, case-insensitive), or `*`.

- A browser always sends an `Origin` header. If it is not listed, the Ircd refuses the upgrade with HTTP 403.
- If the variable is empty or unset, every browser upgrade is refused. Clients that send no `Origin` header (irssi, HexChat, scripts) are always accepted.
- The browser does not expose the 403, so the connect dialog can only say the origin may have been refused.

`localhost` and `127.0.0.1` are different origins. List the one you type in the address bar, or both:

```sh
IRCD_WS_ALLOWED_ORIGINS=http://localhost:3000,http://127.0.0.1:3000
```

## Environment

See [`.env.example`](./.env.example).

| Variable | Used by | Meaning |
| --- | --- | --- |
| `NEXT_PUBLIC_IRCD_WS_URL` | web (build time) | Default Ircd WebSocket URL (`ws:` or `wss:`). Default `ws://127.0.0.1:6680` |
| `IRCD_WS_ALLOWED_ORIGINS` | Ircd | Page origins the Ircd accepts |

`NEXT_PUBLIC_IRCD_WS_URL` is inlined into the bundle at build time. Changing it requires a rebuild; setting it when running `next start` has no effect. The origin of this URL also becomes the CSP `connect-src`, so it is the only non-local WebSocket origin the page may open. An invalid value fails the build with an error.

## Build

```sh
pnpm --filter @seance/web build
```

The build script runs `next build --webpack`.

## Tests

Unit, property and component tests (vitest, no network):

```sh
pnpm --filter @seance/web test
pnpm --filter @seance/web typecheck
pnpm --filter @seance/web lint
```

End-to-end tests (Playwright) are opt-in and are not part of `pnpm test`. They build the app, start an Ircd and a Runner with a fake Kiro binary, and drive a real browser:

```sh
pnpm --filter @seance/web test:e2e
```
