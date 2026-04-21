# TaskFlow Routing

Use TaskFlow only when durable orchestration adds real value.

## Upgrade To TaskFlow

Upgrade when at least two apply:

- more than one stage
- more than one agent
- waiting on human/system approval or callback
- durable resume after restart matters
- multiple child tasks need tracking
- blocked/waiting/resumed states matter to the user

## Do Not Upgrade

Keep work direct when:

- one capable agent can finish it in one burst
- no external wait exists
- no durable state matters after the result is returned

## TaskFlow State Minimum

When a task is in TaskFlow, keep these current:

- current phase
- next phase
- blocker or risk
- ETA or next checkpoint

TaskFlow should be the only durable state source. Do not create parallel markdown ledgers just to mirror it.
