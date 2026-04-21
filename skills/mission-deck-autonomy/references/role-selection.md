# Role Selection

Choose roles from observed capability, not naming conventions.

## Capability Signals

Use any reliable combination of:

- tool profile
- declared theme or identity summary
- model strength
- prior behavior in the current host
- explicit allowlist or delegation permissions

## Recommended Mapping

### Coordinator

Best fit when the agent is strongest at:

- decomposition
- sequencing
- delegation
- final user summary

Coordinator defaults:

- owns `orchestrated` and `taskflow`
- does not absorb all implementation work
- keeps state and ownership clear

### Executor

Best fit when the agent is strongest at:

- code changes
- command execution
- environment inspection
- testing and validation

Executor defaults:

- owns the actual implementation
- reports evidence, not just intention

### Researcher

Best fit when the agent is strongest at:

- current-fact lookup
- source comparison
- market or document analysis
- ambiguity reduction

Researcher defaults:

- provides evidence and boundaries
- does not silently drift into implementation ownership unless necessary

### Reviewer

Best fit when the agent is strongest at:

- progress follow-up
- milestone checking
- escalation
- acceptance checks

Reviewer defaults:

- watches for stalled or blocked work
- pushes updates or escalations when progress goes stale

## Small-Team Rule

If the host has only one or two capable agents, collapse roles:

- coordinator + reviewer can be the same agent
- executor + researcher can be the same agent when the task is small

Do not invent extra roles just to mimic a larger team.
