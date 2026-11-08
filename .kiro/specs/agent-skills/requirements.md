# Requirements Document: agent-skills

## Introduction

Séance agents get Kiro skills: short, task-specific instructions that Kiro loads on demand. Skills live only in the repository's `agents/` directory, next to the Kiro agent configs the runner starts. A target repository must never supply skills; the worktree already drops its `.kiro` directory and `AGENTS.md`, and that stays.

## Glossary

- **Skill**: a file `agents/.kiro/skills/<name>/SKILL.md` with YAML front matter (`name`, `description`) and instructions.
- **Profile**: a Séance registry file `agents/<nick>.json`, parsed by `apps/runner/src/registry/agent-profile.ts`.
- **Kiro_Agent_Config**: `agents/.kiro/agents/<kiroAgent>.json`, read by `kiro-cli acp --agent <kiroAgent>` with process cwd `agents/`.
- **Skill_Resource**: the string `skill://.kiro/skills/<name>/SKILL.md` in a Kiro_Agent_Config's `resources`.

## Requirements

### Requirement 1: Skills

**User Story:** As an operator, I want each agent to follow a short, role-specific procedure, so that its work and its IRC replies are predictable.

#### Acceptance Criteria

1. THE repository SHALL ship three skills: `seance-fix-and-commit` (coder), `seance-review-checklist` (reviewer), `seance-cite-sources` (researcher).
2. EACH skill SHALL start with front matter holding `name` (equal to its directory name) and `description`, and SHALL be at most 60 lines, English, without secrets, host paths or the trademarked client name.
3. `seance-fix-and-commit` SHALL tell the agent to reproduce first, make the smallest diff, run the project's tests (`npm test` when `package.json` has it), stay inside the cwd, never push, commit with a Conventional Commit message, not retry on "not a git repository" (the runner commits in the sandbox), and report in at most 3 short IRC lines without tables or code fences.
4. `seance-review-checklist` SHALL be read-only, review `git diff HEAD~1` when git is available and otherwise the files named in the request, and report at most 5 findings as `severity file:line: issue`, Critical and Major first, one per line, or `no findings`.
5. `seance-cite-sources` SHALL be read-only, cite `file:line`, say "not found" instead of guessing, and answer in at most 4 IRC lines.

### Requirement 2: Wiring and registry

**User Story:** As a maintainer, I want skills declared in one place per agent and checked at startup, so that a typo cannot silently change what an agent knows.

#### Acceptance Criteria

1. EACH Kiro_Agent_Config SHALL reference only its own skills, as one exact Skill_Resource per skill.
2. A Profile MAY have `skills`: an array of at most 8 distinct names, each matching `^[a-z0-9-]{1,40}$`. An invalid value SHALL reject the Profile with an `AgentProfileError` naming the file and the field `skills` (the existing fail-closed style: logged and skipped).
3. WHEN a Profile lists a skill whose `SKILL.md` is not a regular file under `<agentsDir>/.kiro/skills/<name>/`, or whose real path leaves `<agentsDir>/.kiro/skills`, THE runner SHALL refuse to start with an error naming the profile, the skill and the expected path.
4. Skills SHALL come only from the agents directory. THE worktree SHALL keep dropping the target repository's `.kiro` and `AGENTS.md`.

### Requirement 3: WHOIS

**User Story:** As an operator, I want `/whois <agent>` to show its skills.

#### Acceptance Criteria

1. WHEN the Profile lists skills, THE `320` lines SHALL include `skills: a, b` directly after the `tools:` line; with no skills there SHALL be no such line.
2. THE line SHALL stay within the 300-byte `320` budget and SHALL never cut a name: names that do not fit are counted as `+N more`.
3. No ircd protocol change other than this new `320` text line. THE web client renders `320` text as received and SHALL need no change.

### Requirement 4: Consistency

#### Acceptance Criteria

1. A runner test SHALL check that every skill named in `agents/*.json` exists with valid front matter and is referenced by the resources of that Profile's Kiro_Agent_Config, and that no Kiro_Agent_Config references a skill outside `agents/.kiro/skills`.

### Requirement 5: Verification and docs

#### Acceptance Criteria

1. THE exact kiro-cli 3.1 resource syntax SHALL be established from documentation and `kiro-cli agent validate` (no prompts, no credits) and recorded in `docs/KIRO_USAGE.md`, stating what is verified and what is not.
2. README (agents section), `docs/SANDBOX.md` and `DESIGN.md` SHALL describe skills, how to add one, and that target repositories cannot add skills.
3. No existing test SHALL be deleted or weakened.
