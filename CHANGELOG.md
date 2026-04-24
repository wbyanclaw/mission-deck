# Changelog

## Unreleased

## 0.2.0

- Tightened root-flow finalization so visible final replies are written directly into durable `finalOutput`, and root runs that end without any visible reply now converge to explicit `blocked` state instead of lingering in `reviewing`.
- Rebuilt dashboard state reconciliation so Agent roster, task cards, and TaskFlow-backed status snapshots use a tighter shared definition of visible work.
- Reworked TaskFlow and parent/child reconciliation around durable flow state, duplicate-link repair, root-flow filtering, and dashboard rebuild from `flow_runs`.
- Tightened root TaskFlow creation so only user prompts create new root flows; system/internal async continuations no longer appear as standalone user tasks.
- Restored direct solo agent chat while keeping mission-flow delegation guardrails in place.
- Improved dashboard presentation:
  - flow-centric task cards and chain rendering
  - stable user-ask timestamps and newest-first ordering
  - consistent task status/progress labels
  - org graph line states aligned with current busy agents
  - active org edges rendered as animated marquee lines
  - root busy state shown via node status indicator
  - task/session detail pages opened from the board in a separate tab
  - slimmer board cards with compact summaries and floating session-type filters
  - direct session coverage rebuilt from session logs with stable titles and cleaner transcript filtering
- Added/expanded repair, reconciliation, and dashboard verification coverage to keep historical flow cleanup and UI state checks reproducible.

## 0.1.0

- Initial public release candidate structure
- Visible-session-first routing policy
- Internal-first orchestration guardrails
- TaskFlow-aware delegation tracking
- Standalone dashboard for runs, blockers, and dispatch activity
