# MISSION DECK

`mission-deck` is a non-invasive OpenClaw plugin for multi-agent orchestration guardrails and a lightweight standalone dashboard.

Current architecture:

- hooks act as event adapters, not the durable workflow engine
- `TaskFlow` is the only durable flow state source for `mission-flow`
- child-task evidence is reconciled back into the root flow before final delivery
- final user-visible delivery is gated through one durable finalize path

Language:

- English: `README.md`
- 简体中文: [README.zh-CN.md](./README.zh-CN.md)

It is designed to make agent coordination:

- visible in an existing reusable teammate session whenever possible
- traceable when isolated execution is necessary
- stricter about doing reusable internal coordination before user escalation

## Current Routing Policy

The plugin follows this rule:

- first look for a reusable visible teammate session
- prefer `sessions_send` when the teammate already has a visible reusable session
- only use `sessions_spawn` when isolation is explicitly needed, or when no suitable visible reusable session exists

In practice:

- `sessions_send`: continue an already-known teammate session such as `agent:builder:chat:direct:...`
- `sessions_spawn`: open a fresh isolated lane for explicit ACP/background work, parallel workers, or long-running isolated execution

If you are unsure, inspect visible sessions first with `sessions_list` or `agents_list` before opening a new isolated lane.

## What It Does

- Classifies work as `plain`, `mission-lite`, or `mission-flow`
- Detects engineering-style tasks from prompt behavior
- Pushes agents toward internal coordination before external narration
- Blocks invalid `sessions_send` calls that target only `agentId`
- Blocks premature `sessions_spawn` unless isolation is explicit or no visible reusable session is available
- Creates and maintains TaskFlow-linked delegation traces on supported hosts
- Tracks child-task linkage for traceable delegation
- Reconciles child-task delivery back into the root flow before completion
- Treats synthetic announce text as supporting input, not as an independent completion source
- Writes a live dashboard snapshot to `dashboard/status.json`
- Appends daily dashboard events to `dashboard/data/YYYY-MM-DD.jsonl`

## Execution Modes

`mission-deck` uses three entry modes:

- `plain`: direct handling, no orchestration flow
- `mission-lite`: lightweight planning and guardrails without durable `TaskFlow`
- `mission-flow`: durable multi-agent orchestration with child-task evidence and completion gates

Typical rule of thumb:

- simple direct work -> `plain`
- solo but non-trivial work -> `mission-lite`
- delegated or stateful work -> `mission-flow`

## Durable Flow Rules

For `mission-flow`, the plugin enforces these rules:

- the root flow owns durable status
- child work is tracked as child tasks linked to the root flow
- child completion must be reflected back into root flow evidence
- final delivery is only valid after the root flow has enough evidence and no open child work

This is the main reason `mission-deck` separates:

- hook adapters
- flow transitions
- parent reconciliation
- reply/finalize gates

## Compatibility

This plugin requires an OpenClaw host that supports both:

- TaskFlow
- agent-to-agent messaging (`tools.agentToAgent.enabled = true`)

It also assumes these plugin hooks are available:

- `gateway_start`
- `before_prompt_build`
- `before_tool_call`
- `after_tool_call`
- `before_agent_reply`
- `before_message_write`
- `agent_end`

Required runtime capabilities:

- `api.runtime.taskFlow` or `api.runtime.tasks.flow`
- `tools.agentToAgent`
- agent `workspace` configuration in `agents.list`

If TaskFlow or agent-to-agent support is missing, `mission-deck` should be treated as not supported on that host. The plugin now emits an explicit prerequisite warning instead of silently treating those capabilities as optional.

## Installation

Agent-first install:

```bash
npx mission-deck-install@latest --apply --json
```

or, after the package is already available locally:

```bash
mission-deck-install --apply --json
```

Full install with verification and service restart:

```bash
npx mission-deck-install@latest --apply --verify --restart --json
```

or:

```bash
mission-deck-install --apply --verify --restart --json
```

This installer:

- copies the plugin to `~/.openclaw/extensions/mission-deck` by default
- updates `~/.openclaw/openclaw.json`
- can verify the installed files and config entry
- can optionally restart the target OpenClaw service with `systemctl`
- returns structured JSON so another agent can continue from the result

Manual install remains available as a fallback:

Copy the plugin directory into your OpenClaw extensions directory, for example:

```text
~/.openclaw/extensions/mission-deck/
```

Then register it in your OpenClaw config.

Before enabling `mission-deck`, verify your host installation already has:

- TaskFlow support
- agent-to-agent support

Recommended pre-install checklist:

1. Confirm your OpenClaw build exposes TaskFlow runtime APIs.
2. Confirm `tools.agentToAgent.enabled = true`.
3. Confirm the agents you want to protect are listed in `agents.list`.
4. Confirm those agents have stable `workspace` paths configured.
5. Confirm your plugin host supports the hooks listed in `Compatibility`.

Example snippet:

```json
{
  "plugins": {
    "load": {
      "paths": ["~/.openclaw/extensions/mission-deck"]
    },
    "entries": {
      "mission-deck": {
        "enabled": true,
        "config": {}
      }
    }
  }
}
```

## Configuration

Example plugin config:

```json
{
  "enabledAgents": ["dispatcher", "builder", "reviewer"],
  "dashboardRetentionDays": 14
}
```

Stable public options:

- `enabledAgents`: restrict orchestration to a subset of configured agents
- `internalFirst`: prefer teammate coordination before asking the user for missing entrypoints
- `blockPrematureUserEscalation`: block early requests for repo path, workspace path, git URL, or similar entrypoints
- `blockPrematureSpawn`: require a visible-session check before ordinary `sessions_spawn`
- `blockInvalidSessionsSend`: block `sessions_send` calls that only specify `agentId`
- `redactDashboardContent`: sanitize dashboard-persisted summaries and prompt-derived text
- `redactSessionKeys`: replace raw session keys with redacted stable identifiers in dashboard output
- `redactPromptMetadata`: strip prompt-scaffolding metadata before dashboard persistence
- `dashboardRetentionDays`: keep dashboard daily `jsonl` logs for N days

Advanced overrides:

- `taskKeywords`: extra task-detection keywords
- `agentWorkspaceRoots`: optional explicit workspace-root overrides by agent id
- `entrypointPatterns`: custom user-escalation trigger phrases
- `discoveryToolNames`: custom tool names that count as workspace discovery
- `dashboardStatusPath`: optional override for the generated `status.json` path
- `dashboardDataDir`: optional override for the generated dashboard event-log directory

Default behavior:

- The installer writes a minimal plugin entry and leaves option values implicit unless you set them.
- `internalFirst`, the three blocking guardrails, and dashboard redaction are enabled by default unless explicitly set to `false`.
- `dashboardRetentionDays` defaults to `14`.

## Session Routing Rules

Use `sessions_send` when:

- you already know the teammate session to continue
- the work should stay visible in the teammate's existing reusable thread
- you are following up on an existing conversation

Use `sessions_spawn` when:

- the task explicitly needs isolation
- the task needs ACP/background execution
- the task should run in parallel without polluting the existing visible thread
- no visible reusable teammate session exists

`sessions_send` is not valid when only `agentId` is provided. A known `sessionKey` or `label` is required.

## Completion Model

`mission-deck` does not treat any one reply as proof of completion by itself.

Completion is valid only when:

- the root flow has durable child evidence when delegation was required
- no open child work remains
- the root flow can pass its finalize gate

Synthetic announce messages are treated as child-report inputs. They do not independently close the workflow.

## Dashboard

The plugin ships a standalone static dashboard:

- `dashboard/index.html`
- `dashboard/status.json`
- `dashboard/data/YYYY-MM-DD.jsonl`

These files are runtime outputs. Do not treat `status.json` or `dashboard/data/` as source files for release packaging.

Recommended reverse-proxy pattern:

```nginx
location = /mission-deck {
    return 301 /mission-deck/;
}

location = /mission-deck/ {
    return 302 /mission-deck/index.html;
}

location ^~ /mission-deck/ {
    auth_basic "Restricted";
    auth_basic_user_file /etc/nginx/.openclaw_pass;

    alias /path/to/mission-deck/dashboard/;
    index index.html;
    try_files $uri $uri/ /mission-deck/index.html;
}
```

If you do not want to publish the dashboard, the orchestration guardrails can still be used without exposing the static files.

## Smoke Test

After installation, run this minimal verification flow on a clean host:

1. Start OpenClaw and confirm startup logs do not report missing `TaskFlow` or `agentToAgent` prerequisites.
2. Send one task that should reuse an existing teammate session.
3. Confirm the plugin prefers `sessions_send` and does not prematurely open an isolated lane.
4. Send one task that explicitly requires isolated ACP/background execution.
5. Confirm `sessions_spawn` is allowed for that explicit-isolation case.
6. Open the dashboard and confirm a new `status.json` is generated.
7. Inspect `status.json` and verify raw peer IDs, raw `sessionKey`, `chat_id`, and `message_id` are not present by default.

Expected failure mode:

- if TaskFlow or agent-to-agent support is missing, startup logs should warn clearly and tool calls should be blocked with a prerequisite error instead of silently degrading

## Dashboard Data Model

`status.json` contains:

- `summary`
- `agentRoster`
- `agentLoad`
- `flowHealth`
- `childTaskBoard`
- `deliveryHub`
- `consoleFeed`
- `activeRuns`
- `recentRuns`
- `recentDispatches`
- `recentBlockers`

`dashboard/data/YYYY-MM-DD.jsonl` contains append-only daily events such as:

- `dispatch`
- `blocker`
- `run-ended`
- `child-outcome`

## Local Development

Run local checks:

```bash
npm run check
npm test
```

## Release Notes

Before publishing publicly:

- verify documentation matches actual routing behavior
- verify runtime-generated dashboard files are excluded from the release
- verify dashboard persistence redaction defaults do not leak sensitive channel/session metadata
- document the minimum OpenClaw version that satisfies the required hooks/runtime APIs
- verify release notes state that TaskFlow and A2A are hard prerequisites
- add real repository metadata in `package.json` before publishing to npm or GitHub
