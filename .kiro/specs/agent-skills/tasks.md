# Implementation Plan: agent-skills

## Overview

Spike first (step 0), then the skill files and Kiro wiring, the registry field and startup check, the WHOIS line, the tests, and the docs. Never run the real `kiro-cli` except `kiro-cli agent validate`. Verify per package (`pnpm --filter @seance/runner typecheck`, `pnpm --filter @seance/runner exec vitest run`); rebuild the runner before ircd integration tests. No existing test is deleted or weakened.

## Tasks

- [x] 0. Spike: kiro-cli 3.1 skill syntax
  - Read the configuration reference and the CLI docs (Context7); probe `kiro-cli agent validate` with valid, missing-path, unknown-scheme, wrong-type and broken configs; inspect binary strings statically
  - Record the result in `docs/KIRO_USAGE.md` and design "Step 0"
  - _Requirements: 5.1_

- [x] 1. Skills and Kiro wiring
  - [x] 1.1 Write the three `SKILL.md` files under `agents/.kiro/skills/`
    - _Requirements: 1.1 to 1.5_
  - [x] 1.2 Add one exact `skill://.kiro/skills/<name>/SKILL.md` resource to each Kiro agent config; run `kiro-cli agent validate` on all three
    - _Requirements: 2.1_
  - [x] 1.3 Add `skills` to `agents/{coder,reviewer,researcher}.json`
    - _Requirements: 2.2_

- [x] 2. Registry and startup check
  - [x] 2.1 Parse and validate `skills` in `parseProfile` (`SKILL_NAME`, `MAX_SKILLS`, duplicates, clipped error value)
    - _Requirements: 2.2_
  - [x] 2.2 Add `AgentSkillMissingError` and the skill check to `verifyAgentFiles` (regular file, realpath inside `.kiro/skills`); export it from `src/index.ts`
    - _Requirements: 2.3, 2.4_

- [x] 3. WHOIS
  - [x] 3.1 Store a copy of the skills in `WhoisSnapshot.register`; pass them from `InviteController`
    - _Requirements: 3.1_
  - [x] 3.2 Render `skills:` after `tools:` with `skillsLine` (whole names, `+N more`)
    - _Requirements: 3.1, 3.2_
  - [x] 3.3 Confirm the web client renders `320` text as received (no change)
    - _Requirements: 3.3_

- [x] 4. Tests
  - [x] 4.1 `apps/runner/test/agent-skills.test.ts`: validation table, registry skip, startup check, WHOIS present and absent, over-budget line
    - **Property 1: The skills line never exceeds the budget and never cuts a name** (`P1 ...`)
    - **Validates: Requirements 2.2, 2.3, 3.1, 3.2**
  - [x] 4.2 `apps/runner/test/agent-skills-consistency.test.ts` over the committed `agents/`
    - **Validates: Requirements 1.2, 2.1, 4.1**
  - [x] 4.3 Fake-agent integration: `credits.integration.test.ts` expects `skills: seance-fix-and-commit` right after the tools line
    - **Validates: Requirements 3.1**

- [x] 5. Docs and checks
  - [x] 5.1 README agents section, `docs/SANDBOX.md`, `DESIGN.md` row
    - _Requirements: 5.2_
  - [x] 5.2 Run `pnpm build`, `pnpm typecheck`, `pnpm lint`, `pnpm test --force`, `pnpm --filter @seance/web test:e2e`
    - _Requirements: 5.3_
  - [x] 5.3 **Manual (user):** one real journey to settle design Open Points 1 to 3 (path base, auto-discovery, body loading)
    - Result (2026-11-08): real kiro-cli journey `#skill-1` 11/11 PASS, 0.36 credits; the coder answered in a 3-line report, committed `fix: handle null email in login`, and WHOIS showed `skills: seance-fix-and-commit`. The cwd-relative paths worked as configured
    - _Requirements: 5.1_

## Notes

- Task 5.3 needs credits and is run by the user; nothing else waits for it.
- The consistency test is the only check that the profile and the Kiro config agree; `kiro-cli agent validate` does not check that a skill path exists.

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["0"] },
    { "id": 1, "tasks": ["1.1", "2.1", "3.1"] },
    { "id": 2, "tasks": ["1.2", "1.3", "2.2", "3.2", "3.3"] },
    { "id": 3, "tasks": ["4.1", "4.2", "4.3"] },
    { "id": 4, "tasks": ["5.1"] },
    { "id": 5, "tasks": ["5.2"] },
    { "id": 6, "tasks": ["5.3"] }
  ]
}
```
