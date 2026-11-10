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
3. Run the tests with `npm test` when `package.json` has a `test` script.
   Otherwise use the test command the project documents. Report a failure as it
   is; never hide or skip a failing test.
4. Commit with git as usual, with a Conventional Commit message, for example
   `fix(auth): reject null email on login`.

## Git in the sandbox

If git says "not a git repository", that is expected in the Podman sandbox: the
worktree has no git metadata on purpose, and the runner commits the worktree
after the turn as `<agent>: turn in <channel>`. Then:

- do not try to repair the worktree, and do not run `git init`;
- do not ask the user to install anything;
- say in one line that the runner will commit.

## Limits

- Never read or write files outside the current working directory.
- Never touch `AGENTS.md` or anything under `.kiro`.
- Never push, force anything, or rewrite history.

## Reporting

The channel is IRC. Answer in at most 3 short lines:

- what was wrong,
- what you changed (files),
- test result and commit (or "the runner will commit").

No markdown tables, no code fences, no long logs.
