## Core Rules

### Measure Twice, Cut Once

Before changing code:

- Understand the problem and existing implementation.
- Inspect related code, tests, interfaces, and dependencies.
- Consider side effects and regressions.
- Prefer the smallest correct change.
- Verify the final diff before completing the task.

Do not refactor working code without a clear reason.

## Language

All code-related content must be written in English, including:

- Variables
- Functions
- Classes
- Files
- Tests
- Logs
- Errors
- Comments
- Commit messages and pull requests

## Tone and Wording

Use a neutral, professional register — standard software wording — whatever the
language being written.

Avoid figurative language, aphorisms, rhetorical questions and conversational
asides. A comment, a message and a commit body are documentation, not prose.

**Errors and messages**

- Name the problem, and the expected input when it helps.
- Say which item failed when more than one was submitted.

**Comments and commit messages**

- Explain the decision and its reason, directly.
- Describe behaviour and constraints, not narrative.
- No Co-Authored-By ref.

## Code Quality

Follow SOLID principles.

Prefer code that is:

- Simple
- Explicit
- Readable
- Testable
- Maintainable

Avoid unnecessary abstractions, dependencies, patterns, and premature generalization.

Follow existing project conventions whenever possible.

## Comments

Do not add comments that describe obvious code.

Comments should exist only when necessary to explain:

- Non-obvious decisions
- Business rules
- Security constraints
- Workarounds
- Unexpected behavior

Prefer explaining **why**, not **what**.

Do not leave commented-out code.

Do not cite documents from code. No section numbers, no file paths, no
`(§29)`. A citation is a link that nothing checks: the document gets
restructured, the reference keeps compiling, and it now points somewhere
else — or nowhere. Write the rule itself, in the comment, in the words the
reader needs. A rule worth citing is worth stating.

## Security

Treat all external input as untrusted.

Always consider:

- Input validation
- Injection attacks
- Authentication and authorization
- Sensitive data exposure
- Secure error handling
- Dependency risks

Never hardcode secrets or expose sensitive information in logs, errors, or responses.

Prefer deny-by-default authorization.

## Robustness

Handle edge cases and failures explicitly.

Consider:

- Missing or invalid data
- Empty inputs
- Timeouts
- Partial failures
- Retries
- Concurrency
- Idempotency
- Data integrity

Do not silently swallow errors.

Use database constraints and transactions when they provide stronger guarantees.

## Tests

Test changed behavior at the appropriate level.

For bug fixes, add a regression test when practical.

Do not weaken or remove tests just to make a change pass.

## Final Check

Before finishing, verify:

- The change is necessary and minimal.
- The code is entirely in English.
- SOLID principles are respected.
- No unnecessary comments or abstractions were added.
- Security and edge cases were considered.
- Tests cover the relevant behavior.
- Existing behavior was not unintentionally broken.

**Understand first. Implement carefully. Verify before finishing.**
