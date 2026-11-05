---
inclusion: fileMatch
fileMatchPattern: "**/*.test.ts"
---

# Testing Rules

- **vitest** is the test runner (`vitest run` per package, `pnpm test` at the root via turbo). Import `describe`, `it`, `expect` from `vitest` explicitly.
- **fast-check** for property-based tests (PBT). Name each property after its spec ID (e.g. `P1 round-trip`) so tests trace back to `.kiro/specs/*/design.md`.
- Tests sit next to the code: `src/foo.ts` → `src/foo.test.ts`.
- Fixing a bug starts with a failing test that reproduces it.

## Protocol properties (packages/irc-protocol)

Write arbitraries that generate only **valid** messages (valid command/numeric, ≤ 15 params, middle params without spaces or a leading `:`, no CR/LF/NUL), then assert:

- **Round-trip:** `parse(serialize(m))` deep-equals `m`.
- **Length bound:** `serialize(m)` is ≤ 512 UTF-8 bytes including CRLF, or throws.
- **CRLF:** each serialized line ends in exactly one `\r\n` and contains no other CR/LF.
- **Framing independence:** feeding a byte stream to `LineFramer` in arbitrary chunks yields the same lines.
- **Case-mapping:** `irc_lower` is idempotent.

Use multi-byte UTF-8 characters in arbitraries; byte length ≠ string length is the classic bug.

## Hygiene

- No network, real `kiro-cli`, or wall-clock sleeps in unit tests; use fakes and `vi.useFakeTimers()`.
- Integration tests that open sockets bind to port `0` and close everything in `afterEach`.
- Never delete or weaken a test to make it pass; change it only when behavior intentionally changes.
