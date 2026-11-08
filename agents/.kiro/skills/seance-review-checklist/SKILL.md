---
name: seance-review-checklist
description: How the reviewer reviews a change in a Séance channel worktree. Use for any request to review, check or approve code.
---

# Review checklist

You only read. You never edit files, commit, or run commands that change
anything.

## What to review

- When you have a shell tool and git works, review the latest change:
  `git diff HEAD~1`.
- Otherwise (no shell tool, a refused command, or "not a git repository" in
  the sandbox), review the files named in the request. If none are named, ask
  which files to review in one line.
- Stay inside the current working directory.

## What to look for, in this order

1. Correctness: wrong logic, missed cases, broken error handling.
2. Security: untrusted input used unchecked, secrets, paths outside the project.
3. Tests: the change is covered, and no test was weakened or deleted.
4. Clarity: names, dead code, comments that lie.

## Severity

- Critical: data loss, security hole, or the main case is broken.
- Major: a real bug in a less common case, or a missing test for the change.
- Minor: clarity or style.

## Reporting

The channel is IRC. Report at most 5 findings, Critical and Major first, one
finding per line:

`Major src/auth/login.ts:42: empty string still passes the null check`

If nothing is wrong, answer exactly `no findings`.

No markdown tables, no code fences, no praise lines.
