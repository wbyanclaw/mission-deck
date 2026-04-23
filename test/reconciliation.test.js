import test from "node:test";
import assert from "node:assert/strict";

import {
  completeChild,
  createHarness,
  discoverSessions,
  endDispatcher,
  spawnChild,
  startMissionFlow
} from "../support/mission-deck-harness.js";
import { createAgentEndHandler } from "../lib/agent-end-handler.js";
import { applyChildOutcomeToParent } from "../lib/parent-reconciliation.js";
import { countOpenChildTasks, updateDurableChildTask } from "../lib/flow-transition-helpers.js";
import { createRuntimeRegistry } from "../lib/runtime-registry.js";

async function openParentWithChild(harness, {
  parentRunId,
  childRunId,
  childSessionKey,
  toolCallId = "tool-child-1",
  sessionKey = "agent:dispatcher:main"
}) {
  await startMissionFlow(harness, parentRunId);
  await discoverSessions(harness, parentRunId, sessionKey);
  await spawnChild(harness, {
    runId: parentRunId,
    toolCallId,
    childRunId,
    childSessionKey,
    sessionKey
  });
  await endDispatcher(harness, parentRunId, sessionKey);
}

test("parent reconciliation survives normal, missing-current, and stale-current taskflow transitions", async () => {
  const scenarios = [
    { name: "normal", options: {}, childSessionKey: "agent:builder:subagent:1", childRunId: "child-run-1" },
    { name: "no-current", options: { noTransitionCurrent: true }, childSessionKey: "agent:builder:subagent:2", childRunId: "child-run-no-current-1" },
    { name: "stale-current", options: { staleTransitionCurrent: true }, childSessionKey: "agent:builder:subagent:4", childRunId: "child-run-stale-1" }
  ];

  for (const scenario of scenarios) {
    const harness = await createHarness({}, scenario.options);
    await openParentWithChild(harness, {
      parentRunId: `run-parent-${scenario.name}-1`,
      childRunId: scenario.childRunId,
      childSessionKey: scenario.childSessionKey,
      toolCallId: `tool-${scenario.name}-1`
    });
    await completeChild(harness, {
      childRunId: scenario.childRunId,
      childSessionKey: scenario.childSessionKey
    });

    const flow = harness.flows.get("flow-1");
    assert.equal(flow.status, "waiting");
    assert.equal(flow.currentStep, "reviewing");
    assert.equal(flow.stateJson.state, "reviewing");
    assert.equal(flow.stateJson.childTasks[0].phase, "completed");
  }
});

test("synthetic announce completes the retained parent flow before allowing final delivery", async () => {
  const harness = await createHarness();
  await openParentWithChild(harness, {
    parentRunId: "run-parent-synth-1",
    childRunId: "child-run-synth-1",
    childSessionKey: "agent:builder:subagent:5",
    toolCallId: "tool-child-synth-1"
  });
  await completeChild(harness, {
    childRunId: "child-run-synth-1",
    childSessionKey: "agent:builder:subagent:5",
    text: "已真实读取 `mission-deck/package.json`，其中存在 `build` script。"
  });

  const result = await harness.emit(
    "before_message_write",
    {
      message: {
        role: "assistant",
        content: [{ type: "text", text: "验收完成。\n\n码钳真实只读检查回执：`mission-deck/package.json` 中存在 `build` script。" }]
      }
    },
    {
      agentId: "dispatcher",
      runId: "announce:v1:agent:builder:subagent:5:child-run-synth-1",
      sessionKey: "agent:dispatcher:main"
    }
  );

  assert.ok(result?.message);
  assert.match(result.message.content[0].text, /已完成，汇总如下|验收完成/);
  const flow = harness.flows.get("flow-1");
  assert.equal(flow.status, "succeeded");
  assert.equal(flow.currentStep, "completed");
  assert.equal(flow.stateJson.state, "completed");
  assert.match(flow.stateJson.finalOutput.text, /验收完成/);
});

test("child execution reply is hidden from external delivery and kept for parent reconciliation", async () => {
  const harness = await createHarness();
  await openParentWithChild(harness, {
    parentRunId: "run-parent-hidden-child-1",
    childRunId: "child-run-hidden-child-1",
    childSessionKey: "agent:builder:subagent:7",
    toolCallId: "tool-child-hidden-1"
  });

  await harness.emit(
    "before_prompt_build",
    { prompt: "修复构建失败" },
    { agentId: "builder", runId: "child-run-hidden-child-1", sessionKey: "agent:builder:subagent:7" }
  );
  const result = await harness.emit(
    "before_message_write",
    {
      message: {
        role: "assistant",
        content: [{ type: "text", text: "已真实读取 `mission-deck/package.json`，其中存在 `build` script。" }]
      }
    },
    { agentId: "builder", runId: "child-run-hidden-child-1", sessionKey: "agent:builder:subagent:7" }
  );

  assert.ok(result?.message);
  assert.equal(result.message.content[0].text, "NO_REPLY");
});

test("synthetic announce is silenced when it cannot complete a parent flow", async () => {
  const harness = await createHarness();
  const result = await harness.emit(
    "before_message_write",
    {
      message: {
        role: "assistant",
        content: [{ type: "text", text: "验收完成。\n\n码钳真实只读检查回执：文件存在。" }]
      }
    },
    {
      agentId: "dispatcher",
      runId: "announce:v1:agent:builder:subagent:missing:child-run-missing",
      sessionKey: "agent:dispatcher:main"
    }
  );

  assert.ok(result?.message);
  assert.equal(result.message.content[0].text, "NO_REPLY");
});

test("delivered child evidence can still close parent flow after a later dispatch failure", async () => {
  const harness = await createHarness();
  await openParentWithChild(harness, {
    parentRunId: "run-parent-recover-1",
    childRunId: "child-run-recover-1",
    childSessionKey: "agent:builder:subagent:6",
    toolCallId: "tool-child-recover-ok"
  });
  await harness.emit(
    "before_tool_call",
    {
      toolName: "sessions_spawn",
      toolCallId: "tool-child-recover-fail",
      params: {
        agentId: "reviewer",
        label: "extra-lane",
        task: "补充检查"
      }
    },
    { agentId: "dispatcher", runId: "run-parent-recover-1", sessionKey: "agent:dispatcher:main" }
  );
  await harness.emit(
    "after_tool_call",
    {
      toolName: "sessions_spawn",
      toolCallId: "tool-child-recover-fail",
      params: {
        agentId: "reviewer",
        label: "extra-lane",
        task: "补充检查"
      },
      result: {
        details: {
          status: "error",
          error: "gateway timeout after 10000ms"
        }
      }
    },
    { agentId: "dispatcher", runId: "run-parent-recover-1", sessionKey: "agent:dispatcher:main" }
  );

  await completeChild(harness, {
    childRunId: "child-run-recover-1",
    childSessionKey: "agent:builder:subagent:6",
    text: "已真实读取 `mission-deck/package.json`，其中存在 `build` script，内容是 `npm run check`。"
  });

  const result = await harness.emit(
    "before_message_write",
    {
      message: {
        role: "assistant",
        content: [{ type: "text", text: "验收完成。\n\n码钳真实只读检查回执：`mission-deck/package.json` 中存在 `build` script，内容是 `npm run check`。" }]
      }
    },
    {
      agentId: "dispatcher",
      runId: "announce:v1:agent:builder:subagent:6:child-run-recover-1",
      sessionKey: "agent:dispatcher:main"
    }
  );

  assert.ok(result?.message);
  assert.match(result.message.content[0].text, /已完成，汇总如下|验收完成/);
  const flow = harness.flows.get("flow-1");
  assert.equal(flow.status, "succeeded");
  assert.equal(flow.currentStep, "completed");
  assert.equal(flow.stateJson.state, "completed");
});

test("same-session root continuation reuses waiting mission-flow instead of creating a new flow", async () => {
  const harness = await createHarness();
  await openParentWithChild(harness, {
    parentRunId: "run-root-continue-1",
    childRunId: "child-run-root-continue-1",
    childSessionKey: "agent:builder:subagent:3",
    toolCallId: "tool-root-continue-1"
  });

  const createManagedBefore = harness.taskFlowCalls.filter((entry) => entry.type === "createManaged").length;
  assert.equal(createManagedBefore, 1);

  const result = await harness.emit(
    "before_prompt_build",
    { prompt: "继续当前链路，等子任务真实回执后再汇总。" },
    { agentId: "dispatcher", runId: "run-root-continue-2", sessionKey: "agent:dispatcher:main" }
  );

  const createManagedAfter = harness.taskFlowCalls.filter((entry) => entry.type === "createManaged").length;
  assert.equal(createManagedAfter, 1);
  assert.match(result.appendSystemContext, /Entry mode for this run: mission-flow/);
  assert.match(result.appendSystemContext, /Current TaskFlow flowId=flow-1/);

  const flow = harness.flows.get("flow-1");
  assert.equal(flow.currentStep, "planned");
  assert.equal(flow.stateJson.state, "planned");
});

test("agent_end reconciles child outcome when parent link is only available from registry lookup", async () => {
  const runtimeRuns = new Map([
    ["child-run-1", {
      engineeringTask: true,
      entryMode: "mission-lite",
      parentRunId: "",
      parentTaskId: "",
      parentFlowId: "",
      parentAgentId: "",
      lastExternalMessage: "子任务已完成",
      lastBlockReason: ""
    }]
  ]);
  const applied = [];
  const attached = [];
  const parentState = { flowId: "flow-parent", agentId: "dispatcher" };
  const handler = createAgentEndHandler({
    dashboard: {
      attachChildOutcome: async (outcome) => { attached.push(outcome); },
      trackActiveRun() {},
      archiveRun: async () => {},
      flush: async () => {}
    },
    runtimeRuns,
    isSyntheticAnnounceRun: () => false,
    getBestEffortParentLinkFromRegistry: () => ({
      parentRunId: "",
      parentFlowId: "flow-parent",
      parentAgentId: "dispatcher",
      childTaskId: "task-1",
      childSessionKey: "agent:builder:subagent:1"
    }),
    findParentRunByChildLink: () => null,
    reviveParentRun: () => parentState,
    applyChildOutcomeToParent: (_state, _parentAgentId, outcome) => { applied.push(outcome); },
    countOpenChildTasks: () => 0,
    buildCollaborationRequirementReason: () => "",
    lacksRequiredCollaborationEvidence: () => false,
    shouldFinishParent: () => false,
    shouldRetainRuntimeState: () => true,
    syncFlowSnapshot: () => {},
    transitionFlow: () => {},
    ensureFlowBound: () => null,
    deleteBestEffortChildLink: () => {}
  });

  await handler({}, { agentId: "builder", runId: "child-run-1", sessionKey: "agent:builder:subagent:1" });

  assert.equal(applied.length, 1);
  assert.equal(applied[0].parentRunId, "flow-parent");
  assert.equal(applied[0].childTaskId, "task-1");
  assert.equal(attached.length, 1);
  assert.equal(attached[0].parentRunId, "flow-parent");
});

test("runtime registry falls back to persisted child link lookup when memory link is missing", () => {
  const registry = createRuntimeRegistry({
    runtimeRuns: new Map(),
    latestRunByAgent: new Map(),
    bestEffortChildLinksByRun: new Map(),
    bestEffortChildLinksBySession: new Map(),
    dashboard: { trackActiveRun() {} },
    lookupPersistedChildLink: (runId, sessionKey) => (
      runId === "child-run-2" && sessionKey === "agent:builder:subagent:2"
        ? {
            parentRunId: "run-parent-2",
            parentFlowId: "flow-parent-2",
            childTaskId: "task-2",
            childSessionKey: sessionKey
          }
        : null
    )
  });

  const link = registry.getBestEffortParentLink("child-run-2", "agent:builder:subagent:2");
  assert.equal(link?.parentRunId, "run-parent-2");
  assert.equal(link?.parentFlowId, "flow-parent-2");
  assert.equal(link?.childTaskId, "task-2");
});

test("parent reconciliation recomputes open-child count from latest flow snapshot before deciding closure", () => {
  const parentState = {
    flowId: "flow-1",
    flowRevision: 4,
    sessionKey: "agent:dispatcher:main",
    entryMode: "mission-flow",
    orchestrationMode: "delegate_once",
    durable: {
      state: "waiting_child",
      childTasks: [
        { taskId: "task-1", childSessionKey: "agent:builder:subagent:1", phase: "running", progressSummary: "Delegated via sessions_spawn" },
        { taskId: "task-2", childSessionKey: "agent:reviewer:subagent:2", phase: "running", progressSummary: "Delegated via sessions_spawn" }
      ],
      receivedEvidenceCount: 0
    },
    childTasks: [
      { taskId: "task-1", childSessionKey: "agent:builder:subagent:1", phase: "running", progressSummary: "Delegated via sessions_spawn" },
      { taskId: "task-2", childSessionKey: "agent:reviewer:subagent:2", phase: "running", progressSummary: "Delegated via sessions_spawn" }
    ],
    childTaskIds: ["task-1", "task-2"],
    timelineEvents: [],
    activityTrail: [],
    lastExternalMessage: "",
    lastBlockReason: ""
  };
  const flow = {
    flowId: "flow-1",
    revision: 5,
    status: "waiting",
    currentStep: "waiting_child",
    stateJson: {
      state: "waiting_child",
      childTasks: [
        { taskId: "task-1", childSessionKey: "agent:builder:subagent:1", phase: "completed", progressSummary: "builder finished" },
        { taskId: "task-2", childSessionKey: "agent:reviewer:subagent:2", phase: "running", progressSummary: "Delegated via sessions_spawn" }
      ],
      receivedEvidenceCount: 1
    },
    tasks: []
  };
  const transitions = [];
  const result = applyChildOutcomeToParent({
    api: {
      runtime: {
        taskFlow: {
          bindSession() {
            return {
              get(flowId) {
                return flowId === "flow-1" ? flow : null;
              }
            };
          }
        }
      }
    },
    dashboard: { trackActiveRun() {} },
    countOpenChildTasks,
    shouldFinishParent() {
      return false;
    },
    transitionFlow(_taskFlow, state, action, payload) {
      transitions.push({ action, payload, state: JSON.parse(JSON.stringify(state.durable)) });
      return { applied: true };
    },
    updateDurableChildTask
  }, parentState, "dispatcher", {
    childTaskId: "task-2",
    childSessionKey: "agent:reviewer:subagent:2",
    childAgentId: "reviewer",
    phase: "completed",
    summary: "reviewer finished",
    updatedAt: "2026-04-22T07:10:00.000Z"
  }, { sessionKey: "agent:dispatcher:main" });

  assert.equal(result.nextState, "reviewing");
  assert.equal(parentState.childTasks[0].phase, "completed");
  assert.equal(parentState.childTasks[0].progressSummary, "builder finished");
  assert.equal(parentState.childTasks[1].phase, "completed");
  assert.equal(parentState.childTasks[1].progressSummary, "reviewer finished");
  assert.equal(transitions[0].payload.currentStep, "reviewing");
});
