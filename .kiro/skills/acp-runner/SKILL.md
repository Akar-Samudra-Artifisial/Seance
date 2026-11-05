---
name: acp-runner
description: How to drive `kiro-cli acp` from Node.js using the spike client in spikes/acp/src/acp-client.ts — spawn, initialize, session/new, streamed session/prompt, session/cancel with cooldown, session/request_permission handling, and credit metering. Use when building or debugging apps/runner or anything that talks ACP.
---

# Driving Kiro over ACP

Findings and measured latencies: `spikes/acp/FINDINGS.md`. Reference implementation: `spikes/acp/src/acp-client.ts` (client) and `spikes/acp/src/spike.ts` (scenarios). Run the spike with `pnpm --filter @seance/spike-acp spike` (uses real credits).

## Client API (`AcpClient`)

```ts
import { AcpClient, isObject } from "./acp-client.ts";

const client = new AcpClient({
  command: "kiro-cli",
  args: ["acp", "--agent", "coder"],   // optionally "--model", "<id>"; never "--trust-all-tools"
  cwd: repoRoot,                        // where .kiro/agents/coder.json is discovered
  logPath: "out/coder.log",             // redacted raw JSON-RPC log
});

client.handle("session/request_permission", async (req) => decidePermission(req));
const off = client.onNotification((method, params) => { /* session/update, _kiro.dev/metadata, ... */ });

await client.request("initialize", { protocolVersion: 1, clientCapabilities: { fs: { readTextFile: true, writeTextFile: true }, terminal: false } });
const { sessionId } = await client.request("session/new", { cwd: worktreePath, mcpServers: [] });
const result = await client.request("session/prompt", { sessionId, prompt: [{ type: "text", text: "[#ch] <op> do X" }] });
// result = { stopReason: "end_turn" | "cancelled" | ... }

client.notify("session/cancel", { sessionId }); // only while a prompt is in flight
await client.close();                            // SIGTERM + wait for exit
```

- `request()` uses numeric ids; inbound requests may carry **string UUID** ids — `IncomingRequest.id` is `number | string`, echo it as is.
- `redact()` masks keys containing token/secret/password/api_key/credential in logs.
- Pending requests are rejected when the process exits, so a SIGTERM never leaves promises hanging.

## Flow per agent

1. Spawn one process per agent (≈2–3 s to `initialize`).
2. `session/new` per channel with `cwd` = `workspaces/<channel>` (< 1 s). Store `sessionId` on the session row.
3. On a PRIVMSG the agent should hear: enqueue `session/prompt`; one in-flight prompt per session.
4. Stream `session/update` notifications:
   - `agent_message_chunk` → buffer, emit a `PRIVMSG` per sentence (≤ 512 bytes).
   - `agent_thought_chunk` → ignore (or log).
   - `tool_call` / `tool_call_update` → set `AWAY`, send `NOTICE` (e.g. `editing src/auth.ts`); clear on completion.
5. `_kiro.dev/metadata` → add `meteringUsage[].value` to credits; `turnDurationMs` marks the turn fully settled.
6. Ignore other `_kiro.dev/*` notifications.

## Cancel (/kick)

```
if (session.state === "prompting") client.notify("session/cancel", { sessionId });
session.state = "cancelling";
// prompt resolves with stopReason "cancelled" within ms
// wait for _kiro.dev/metadata(turnDurationMs) OR 1000 ms, then state = "idle" and drain the queue
```

Sending the next prompt immediately after a cancel makes it return `cancelled` without running.

## Permission handler

`params.toolCall.rawInput` holds `command`, `path`, `content`; `params.options[]` holds `{ optionId, kind }` with `allow_once`, `allow_always`, `reject_once`.

```ts
const decidePermission = async (req: IncomingRequest) => {
  const member = membershipFor(req.params);           // channel + agent → { op, voice }
  const path = rawInputPath(req.params);
  const allowed = member.op && (path === undefined || insideWorktree(path));
  const options = Array.isArray(req.params["options"]) ? req.params["options"].filter(isObject) : [];
  const chosen = options.find((o) => o["kind"] === (allowed ? "allow_once" : "reject_once"));
  return chosen === undefined
    ? { outcome: { outcome: "cancelled" } }
    : { outcome: { outcome: "selected", optionId: String(chosen["optionId"]) } };
};
```

Pick the option by `kind` and answer with its `optionId` (see `spikes/acp/src/spike.ts`).

This handler is the only enforcement point: Kiro never calls `fs/read_text_file` / `fs/write_text_file`.
