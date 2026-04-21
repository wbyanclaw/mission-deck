import test from "node:test";
import assert from "node:assert/strict";

import { __test__, buildConfig } from "../support/mission-deck-harness.js";

test("workspace roots include explicit plugin overrides and configured peers", () => {
  const roots = __test__.resolveWorkspaceRoots(buildConfig(), "dispatcher", {
    agentWorkspaceRoots: {
      dispatcher: "/override/dispatcher",
      builder: "/override/builder"
    }
  });
  assert.deepEqual(
    roots.sort(),
    [
      "/override/builder",
      "/override/dispatcher",
      "/workspace/builder",
      "/workspace/dispatcher",
      "/workspace/ops",
      "/workspace/reviewer"
    ].sort()
  );
});

test("mission entry mode still classifies plain, lite, and flow", () => {
  assert.equal(
    __test__.classifyMissionEntryMode(buildConfig(), "dispatcher", "Read HEARTBEAT.md if it exists and reply HEARTBEAT_OK"),
    "plain"
  );
  assert.equal(
    __test__.classifyMissionEntryMode(buildConfig(), "dispatcher", "分析一下目前这个项目最可能的技术债是什么"),
    "mission-lite"
  );
  assert.equal(
    __test__.classifyMissionEntryMode(buildConfig(), "dispatcher", "重新让每个人汇报一下当前的职责和工作"),
    "mission-flow"
  );
});

test("canonical event classifier distinguishes new task, tool request, finalize candidate, and synthetic announce", () => {
  const promptEvent = __test__.buildCanonicalEvent({
    hookName: "before_prompt_build",
    event: { prompt: "修复构建失败" },
    ctx: { agentId: "dispatcher", runId: "run-1", sessionKey: "agent:dispatcher:main" }
  });
  assert.equal(promptEvent.eventType, __test__.EVENT_TYPES.NEW_TASK);

  const toolEvent = __test__.buildCanonicalEvent({
    hookName: "before_tool_call",
    event: { toolName: "sessions_list", params: {} },
    ctx: { agentId: "dispatcher", runId: "run-1", sessionKey: "agent:dispatcher:main" }
  });
  assert.equal(toolEvent.eventType, __test__.EVENT_TYPES.TOOL_REQUEST);

  const finalizeEvent = __test__.buildCanonicalEvent({
    hookName: "before_message_write",
    event: {
      message: {
        role: "assistant",
        content: [{ type: "text", text: "已完成，汇总如下" }]
      }
    },
    ctx: { agentId: "dispatcher", runId: "run-1", sessionKey: "agent:dispatcher:main" }
  });
  assert.equal(finalizeEvent.eventType, __test__.EVENT_TYPES.FINALIZE_CANDIDATE);

  const syntheticEvent = __test__.buildCanonicalEvent({
    hookName: "before_prompt_build",
    event: { prompt: "announce" },
    ctx: { agentId: "dispatcher", runId: "announce:v1:agent:builder:subagent:123:child-run-1", sessionKey: "agent:dispatcher:main" }
  });
  assert.equal(syntheticEvent.eventType, __test__.EVENT_TYPES.SYSTEM_ANNOUNCE);
});

test("canonical durable flow state captures root, parent, and evidence contract", () => {
  const flowState = __test__.buildCanonicalFlowState({
    runId: "run-1",
    sessionKey: "agent:dispatcher:main",
    parentLink: {
      parentRunId: "parent-1",
      parentFlowId: "flow-parent",
      childTaskId: "task-parent-1",
      parentSessionKey: "agent:dispatcher:main"
    },
    entryMode: "mission-flow",
    orchestrationMode: "delegate_once",
    orchestrationPlan: {
      mode: "delegate_once",
      targetAgentIds: ["builder"],
      requiredEvidenceCount: 1,
      routeHint: "先检查可复用 teammate session，再至少完成一次真实委派。",
      finishCondition: "至少保留 1 份 child evidence 后才能完成。",
      summary: "链路规划：单次委派。"
    }
  });
  assert.equal(flowState.state, __test__.FLOW_STATES.INTAKE);
  assert.equal(flowState.rootRunId, "parent-1");
  assert.equal(flowState.parentTaskId, "task-parent-1");
  assert.equal(flowState.requiredEvidenceCount, 1);
  assert.deepEqual(flowState.childTasks, []);
});

test("applyDurableFlowToRun copies canonical flow state into runtime snapshot", () => {
  const run = __test__.defaultRunState();
  const flow = {
    flowId: "flow-1",
    revision: 3,
    status: "waiting",
    currentStep: "waiting_child",
    stateJson: {
      state: "waiting_child",
      parentRunId: "parent-1",
      childTasks: [{ taskId: "task-1", childSessionKey: "agent:builder:subagent:1" }]
    }
  };
  __test__.applyDurableFlowToRun(run, flow);
  assert.equal(run.flowId, "flow-1");
  assert.equal(run.flowRevision, 3);
  assert.equal(run.parentRunId, "parent-1");
  assert.equal(run.childTaskIds[0], "task-1");
});
