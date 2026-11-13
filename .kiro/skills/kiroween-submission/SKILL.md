---
name: kiroween-submission
description: Kiroween 2026 hackathon submission checklist for Séance — public repo with license, committed .kiro folder, demo video under 3 minutes on YouTube, live app URL with judge credentials, Kiro usage write-up, deadlines (credits request 1 Dec 12:00 PT, submission 4 Dec 2026 14:00 PT), category Resurrection and the Best Kiro Crew App bonus. Use when preparing the release, video, write-up or Devpost form.
---

# Kiroween 2026 submission checklist

Category: **Resurrection** (bringing IRC back as an agent control plane). Bonus target: **Best Kiro Crew App**.

## Deadlines (Pacific Time)

- [x] **Request Kiro credits before 1 Dec 2026, 12:00 PT.** Requested and approved (2026-11-13).
- [x] **Submit on Devpost before 4 Dec 2026, 14:00 PT.** Aim for 3 Dec as buffer (M4 ends 3 Dec). Submitted 2026-11-13; still editable until the deadline.

## Repository

- [x] Repo is **public** on GitHub.
- [x] OSI license at the root (`LICENSE`, MIT) and visible in the GitHub "About" box.
- [x] **`.kiro/` is committed** (steering, specs, hooks, agents, skills, settings/mcp.json) and **not** in `.gitignore`.
- [x] README: pitch, screenshot/GIF, how to run locally, how to connect with irssi, link to video and live app.
- [x] No secrets in history (`KIRO_API_KEY`, `.env`, DB passwords). Check with `git log -p | grep -i -E "api[_-]?key|secret|password"` before submitting. Checked 2026-11-13: 0 key patterns, no .env files in history.
- [x] Product name and UI never use "mIRC".

## Demo video

- [x] **Under 3 minutes**, uploaded to **YouTube** (public or unlisted), link in Devpost.
- [x] Follows the 180 s plan in `DESIGN.md` §9: hook, connect + `/list`, Journey A, kick from irssi (split screen), `/whois` + cost + hook blocking `rm -rf`, how it was built with Kiro, outro.
- [x] Shows Kiro itself: a spec, a hook firing, steering, an agent, property-based tests.

## Live app for judges

- [x] Public **URL** with TLS (VPS + Podman + Caddy).
- [x] **Judge credentials** (`PASS` accounts) in the Devpost "testing instructions" field, not in the repo.
- [ ] ~~irssi connection instructions (`/connect -tls <host> 6697 <password>`).~~ Not offered: TLS 6697 is not available on the public host and TCP 6667 listens on 127.0.0.1 only, so judges use the web client.
- [x] Limits in place: max 2 active agent channels, `+m` by default, per-channel credit cap.

## Write-up: how Kiro was used

Source material: `docs/KIRO_USAGE.md` (filled by the `kiro-usage-log` hook).

- [x] **Specs:** which features were built spec-first, with links to `.kiro/specs/*`.
- [x] **Steering:** always-on vs fileMatch rules and how they changed agent output.
- [x] **Hooks:** guard-shell (with a blocked command example), test-on-save, verify-after-task, usage log.
- [x] **Agents:** `seance-dev`, `seance-reviewer`, `seance-spec`, plus the runtime IRC agents.
- [x] **MCP:** Playwright for UI checks, Context7 for docs.
- [x] **ACP:** Séance runs Kiro agents over `kiro-cli acp` as IRC users — the core of the product.
- [x] **PBT:** fast-check properties derived from spec correctness properties.
- [x] Vibe coding vs spec-driven: what worked, what didn't.

## Crew App bonus

- [x] The Crew app lives in the separate repo [Akar-Samudra-Artifisial/Seance-Crew](https://github.com/Akar-Samudra-Artifisial/Seance-Crew) (public, MIT): `app.json` at its root, `agents/seance-steward.json`, `skills/seance-steward/`, `ui/`, `backend/`.
- [ ] Verify the Crew manifest format against current Kiro Crew docs before relying on it (not yet verified).
