import test from "node:test";
import assert from "node:assert/strict";

import { createHarness, discoverSessions, startMissionFlow } from "../support/mission-deck-harness.js";

test("before_prompt_build creates a planned durable flow for mission-flow tasks", async () => {
  const harness = await createHarness();
  const result = await harness.emit(
    "before_prompt_build",
    { prompt: "协调完成一个真实 E2E：让合适的子 agent 修复构建失败并交付结果。" },
    { agentId: "dispatcher", runId: "run-flow-1", sessionKey: "agent:dispatcher:main" }
  );
  assert.match(result.appendSystemContext, /Entry mode for this run: mission-flow/);
  const createCall = harness.taskFlowCalls.find((entry) => entry.type === "createManaged");
  assert.ok(createCall);
  const flow = harness.flows.get(createCall.flow.flowId);
  assert.equal(flow.currentStep, "planned");
  assert.equal(flow.stateJson.state, "planned");
  assert.equal(flow.stateJson.entryMode, "mission-flow");
});

test("before_tool_call routing gates behave as expected", async () => {
  const harness = await createHarness();

  await startMissionFlow(harness, "run-route-1", "协调完成一个真实 E2E：让合适的子 agent 修复构建失败并交付结果。");
  const blockedExec = await harness.emit(
    "before_tool_call",
    { toolName: "exec", params: { cmd: "pwd" } },
    { agentId: "dispatcher", runId: "run-route-1", sessionKey: "agent:dispatcher:main" }
  );
  assert.equal(blockedExec.block, true);
  assert.match(blockedExec.blockReason, /requires routing first/i);

  await startMissionFlow(harness, "run-safe-read-1", "协调完成一个真实 E2E：让合适的子 agent 修复构建失败并交付结果。");
  const safeRead = await harness.emit(
    "before_tool_call",
    {
      toolName: "read",
      params: {
        path: "~/.nvm/versions/node/v22.22.1/lib/node_modules/openclaw/skills/coding-agent/SKILL.md",
        offset: 1,
        limit: 220
      }
    },
    { agentId: "dispatcher", runId: "run-safe-read-1", sessionKey: "agent:dispatcher:main" }
  );
  assert.equal(safeRead, undefined);

  await startMissionFlow(harness, "run-plan-tool-1", "协调完成一个真实 E2E：让合适的子 agent 修复构建失败并交付结果。");
  const updatePlan = await harness.emit(
    "before_tool_call",
    {
      toolName: "update_plan",
      params: {
        plan: [
          { step: "委派 builder", status: "in_progress" }
        ]
      }
    },
    { agentId: "dispatcher", runId: "run-plan-tool-1", sessionKey: "agent:dispatcher:main" }
  );
  assert.equal(updatePlan, undefined);
});

test("before_tool_call blocks sessions_send that only supplies agentId", async () => {
  const harness = await createHarness();
  await startMissionFlow(harness, "run-send-1", "协调完成一个真实 E2E：让合适的子 agent 修复构建失败并交付结果。");
  await discoverSessions(harness, "run-send-1");
  const result = await harness.emit(
    "before_tool_call",
    { toolName: "sessions_send", params: { agentId: "builder", message: "继续处理" } },
    { agentId: "dispatcher", runId: "run-send-1", sessionKey: "agent:dispatcher:main" }
  );
  assert.equal(result.block, true);
  assert.match(result.blockReason, /cannot target by agentId alone/i);
});

test("after_tool_call registers child task into durable flow state", async () => {
  const harness = await createHarness();
  await startMissionFlow(harness, "run-dispatch-1", "协调完成一个真实 E2E：让合适的子 agent 修复构建失败并交付结果。");
  await discoverSessions(harness, "run-dispatch-1");
  await harness.emit(
    "before_tool_call",
    {
      toolName: "sessions_spawn",
      toolCallId: "tool-1",
      params: {
        agentId: "builder",
        label: "fix-build",
        task: "修复构建失败"
      }
    },
    { agentId: "dispatcher", runId: "run-dispatch-1", sessionKey: "agent:dispatcher:main" }
  );
  await harness.emit(
    "after_tool_call",
    {
      toolName: "sessions_spawn",
      toolCallId: "tool-1",
      params: {
        agentId: "builder",
        label: "fix-build",
        task: "修复构建失败"
      },
      result: {
        details: {
          status: "accepted",
          childSessionKey: "agent:builder:subagent:1",
          runId: "child-run-1"
        }
      }
    },
    { agentId: "dispatcher", runId: "run-dispatch-1", sessionKey: "agent:dispatcher:main" }
  );
  const runTaskCall = harness.taskFlowCalls.find((entry) => entry.type === "runTask");
  assert.ok(runTaskCall);
  const flow = harness.flows.get("flow-1");
  assert.equal(flow.stateJson.state, "delegated");
  assert.equal(flow.stateJson.childTasks[0].taskId, "task-1");
  assert.equal(flow.stateJson.childTasks[0].agentId, "builder");
});

test("before_message_write rewrites premature replies when delegation evidence is missing", async () => {
  const harness = await createHarness();
  await startMissionFlow(harness, "run-rewrite-1");
  await discoverSessions(harness, "run-rewrite-1");

  const finalize = await harness.emit(
    "before_message_write",
    {
      message: {
        role: "assistant",
        content: [{ type: "text", text: "已完成，汇总如下" }]
      }
    },
    { agentId: "dispatcher", runId: "run-rewrite-1", sessionKey: "agent:dispatcher:main" }
  );
  assert.ok(finalize?.message);
  assert.match(finalize.message.content[0].text, /继续内部执行中/);

  const progressClaim = await harness.emit(
    "before_message_write",
    {
      message: {
        role: "assistant",
        content: [{ type: "text", text: "已在执行，不停在计划。等码钳回执真实写入和验读结果后，我直接汇总给你。" }]
      }
    },
    { agentId: "dispatcher", runId: "run-rewrite-1", sessionKey: "agent:dispatcher:main" }
  );
  assert.ok(progressClaim?.message);
  assert.match(progressClaim.message.content[0].text, /继续内部执行中/);
});
