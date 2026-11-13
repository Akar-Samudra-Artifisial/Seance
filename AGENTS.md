# AGENTS.md

Guidance for any AI coding tool working in this repository (Kiro reads `.kiro/` directly).

- **Design:** `DESIGN.md` is the source of truth for the product.
- **Rules:** follow every file in `.kiro/steering/` — `product.md`, `tech.md`, `structure.md` and `security.md` always apply; `irc-protocol.md`, `runner-acp.md`, `web-ui.md` and `testing.md` apply to the paths in their front matter.
- **Specs:** implement work from `.kiro/specs/<feature>/tasks.md` in order; requirements and design live next to it.
- **Package manager:** `pnpm` only (monorepo with Turborepo).
- **Verify before claiming done:**

  ```sh
  pnpm typecheck
  pnpm test
  ```

- **Changes:** code and docs are changed in Kiro (spec trail for Kiroween); other AI tools write briefs for Kiro, review, verify and commit only.
- **Never:** commit secrets or `.env*`, force-push, `git reset --hard`, or touch paths outside the repo.
