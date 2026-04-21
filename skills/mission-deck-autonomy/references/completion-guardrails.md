# Completion Guardrails

Completion must be based on evidence, not optimistic narration.

## Minimum Evidence

At least one should be true:

- implementation or execution evidence exists
- verification/test evidence exists
- a child task completed and reported a concrete result
- the runtime explicitly transitioned the task to a finished state

## Not Sufficient On Their Own

These should not mark work complete by themselves:

- a planning-only reply
- a coordination-only note when execution was still expected
- a generic "done" message without result evidence
- one final-looking visible reply while child work is still active

## If Validation Did Not Happen

Do not hide it. Report one of:

- why validation was not possible
- what remains unverified
- what blocker prevented verification

## Parent / Child Rule

If child work is still active, the parent should normally remain active too, unless the runtime explicitly records a valid completion state.
