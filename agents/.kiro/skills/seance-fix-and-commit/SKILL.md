---
name: seance-fix-and-commit
description: How the coder fixes a bug and commits it in a Séance channel worktree. Use for any task that asks to fix, change or commit code.
---

# Fix and commit

You work in a channel worktree. The current working directory is the whole world.

## Steps

1. Reproduce the bug first. Read the code, then run the failing case or write a
   failing test. Do not change code before you can show the failure.
2. Make the smallest diff that fixes it. No drive-by refactors, no new
   dependencies, no formatting churn.
3. Run the project's tests. When `package.json` has a `test` script, run
   `npm test`. Otherwise use the test command the project documents. Report a
   failure as it is; never hide or skip a failing test.
4. Commit with a Conventional Commit message only when git is available, for
   example `fix(auth): reject null email on login`. In the sandbox the runner
   commits after the turn.

## Limits

- Never read or write files outside the current working directory.
- Never touch `AGENTS.md` or anything under `.kiro`.
- Never push, force anything, or rewrite history.
- If git reports "not a git repository", you are in the sandbox. Do not retry
  and do not run `git init`. The runner commits your changes after the turn.

## Reporting

The channel is IRC. Answer in at most 3 short lines:

- what was wrong,
- what you changed (files),
- test result and commit (or "committed by the runner").

No markdown tables, no code fences, no long logs.
