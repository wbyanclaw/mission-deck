---
name: mission-deck-autonomy
description: Use when the host supports multi-agent messaging plus TaskFlow-style durable workflow tracking, and the goal is to coordinate multi-agent work without editing user-owned prompt files. This skill defines generic routing, role selection, TaskFlow escalation, completion guardrails, and user-update rules for autonomous multi-agent execution. It is role-name agnostic and should be used for designing or operating coordinator/executor/researcher/reviewer style teams on any compatible host.
---

# Mission Deck Autonomy

Use this skill when the host already has multi-agent messaging and TaskFlow-style durable workflow support, and the main need is a portable collaboration method rather than team-specific prompt files.

## What This Skill Covers

- Classify work as `plain`, `mission-lite`, or `mission-flow`
- Choose roles by capability, not by fixed agent ids
- Decide when a task must enter `TaskFlow`
- Keep completion standards consistent across agents
- Keep user-facing updates short and stateful
- Treat the root flow as the only durable completion source

## What This Skill Must Not Assume

- No fixed agent ids such as `main`, `coder`, `manager`, `sale`, `invest`
- No fixed workspace paths
- No fixed channel names
- No requirement to edit `AGENTS.md`, `TEAM_*.md`, or user-owned workspace files

## Core Workflow

1. Inspect the available agents and infer capability buckets.
2. Classify the task as `plain`, `mission-lite`, or `mission-flow`.
3. Assign one coordinator when the work is not purely direct.
4. Assign execution/research/review responsibilities by capability.
5. If the task is long-running or stateful, use `TaskFlow` as the only durable status source.
6. Do not claim completion without result evidence.

Architecture rule:

- hook-level narration is not the durable workflow truth
- the root `TaskFlow` is the durable truth for `mission-flow`
- child replies and synthetic announce messages are inputs to the root flow, not independent completion paths

## Task Classes

### `plain`

Use when most of these are true:

- single domain
- single stage
- likely to complete in one working burst
- no external waiting
- no durable tracking needed

Handling:

- complete directly in the current run
- do not create `TaskFlow`
- do not force orchestration metadata beyond minimal local reasoning

### `mission-lite`

Use when any of these are true:

- the task benefits from a short execution plan first
- the current agent should inspect context or explain likely next steps
- orchestration metadata is useful, but durable status is not yet needed
- no real delegation has happened yet

Handling:

- create a lightweight plan first
- keep the current agent in control
- upgrade to `mission-flow` immediately once a real delegation or durable wait is needed

### `mission-flow`

Use when any two of these are true:

- more than one stage
- external waiting, approvals, timers, or callbacks
- likely to outlive one turn or one runtime burst
- must survive restart/resume
- multiple child tasks need durable tracking
- explicit `waiting`, `blocked`, `resumed`, or `finished` states matter

Handling:

- create or continue one durable `TaskFlow`
- keep current phase, next phase, risk, and ETA current
- treat `TaskFlow` as the only durable state source
- require result evidence before completion
- reconcile child outcomes back into the root flow before final delivery

## Mode Discipline

- `plain`: answer directly; do not add orchestration overhead
- `mission-lite`: plan first, then act; keep it lightweight until a real delegation occurs
- `mission-flow`: create or continue durable flow state, link child evidence, and enforce completion gates

## Role Selection

Read [references/role-selection.md](references/role-selection.md) before assigning work.

Use capability buckets, not names:

- `coordinator`: strongest at decomposition, delegation, and summarization
- `executor`: strongest at implementation, testing, or tool execution
- `researcher`: strongest at fact gathering, comparison, or source validation
- `reviewer`: strongest at follow-up, verification, delivery checks, or escalation

One agent can fill multiple buckets on small teams. Avoid splitting unless it improves speed or quality.

## Completion Guardrails

Read [references/completion-guardrails.md](references/completion-guardrails.md) whenever the task involves delivery or status transitions.

Minimum rules:

- no completion claim without result evidence
- if files or systems changed, include validation or an explicit blocker
- a waiting task is not complete just because one visible reply looks final
- open child work means the parent is still active unless the runtime explicitly records completion
- a child report is not itself final delivery; it must be absorbed by the root flow first

## User Update Rules

Only surface major transitions:

- accepted
- delegated
- blocked or waiting on external input
- milestone completed
- final delivery

Default update format:

- current status
- key evidence
- next action or blocker

## When To Load References

- For capability mapping: read [references/role-selection.md](references/role-selection.md)
- For long-running state decisions: read [references/taskflow-routing.md](references/taskflow-routing.md)
- For completion checks: read [references/completion-guardrails.md](references/completion-guardrails.md)

## Output Discipline

- Prefer the smallest correct team shape
- Prefer one durable status source
- Prefer role clarity over parallelism theater
- Prefer evidence over confidence language
