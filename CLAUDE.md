# Agent instructions

@AGENTS.md

## Comments

Comment what the code cannot say for itself, and nothing else. A reader who knows TypeScript does not need to be told what a function does — they can read it.

Write a comment when:

- A value or rule is non-obvious and someone would otherwise "fix" it: a magic number, a deliberate fallback, an ordering that matters.
- The reason for a decision lives outside the file — a contract with the other teammate, a privacy rule, a sponsor requirement.
- Something is a workaround for a bug or limitation elsewhere.

Do not write:

- A docblock on every exported function, type or module.
- A comment that restates the next line, or the name of the thing it sits above.
- Section banners (`// ---- helpers ----`), or per-field notes on a type whose field names already read clearly.

Prefer a better name or a narrower type over a comment that explains an unclear one.
