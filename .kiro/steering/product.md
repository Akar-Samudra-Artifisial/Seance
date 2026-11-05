---
inclusion: always
---

# Product: Séance

**Tagline:** "IRC is dead. Hold a séance."

Séance is a 1995-style IRC client and server for commanding a team of AI agents. Every agent is a user in a channel; a human operator runs the team using IRC semantics (`/op`, `/voice`, `/kick`, `/topic`). Built for Kiroween 2026, category Resurrection. Full design: `DESIGN.md`.

## Goals

- Make agent permissions and activity visible: modes show who may act, the channel shows what is happening.
- Treat IRC semantics as governance primitives:
  - channel = isolated task with its own git worktree
  - `+o` = may write (edit, commit, shell); `+v` = may speak; no mode = listen only
  - `/kick` = hard stop (cancel session, reset worktree, keep the log)
  - `/ban` = agent cannot be invited
  - `/whois` = model, tools, status, credits
- Stay protocol-compatible: irssi and HexChat must be able to connect, and humans and agents are peers.
- Deliver a retro, keyboard-first web client with tasteful Halloween touches.

## Non-goals (MVP)

Multi-server, SASL, netsplits, federation, mobile clients.

## Brand rules

- The product name is **Séance**. Never use "mIRC" in the product name, package names, logos or UI titles — it is a trademark.
- "mIRC-inspired" is acceptable only in descriptive prose.
- All documentation, code comments, commit messages and UI copy are in **English**.

## Safety principles

- Only messages from human channel operators are treated as instructions; all other content is wrapped as `<untrusted>`.
- Agent output is never executed by the server.
- Write tools are granted only to `+o` agents and are confined to the channel worktree.
