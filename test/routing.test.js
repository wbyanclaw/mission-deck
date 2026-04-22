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

test("before_prompt_build does not create a root flow for system-triggered async prompts", async () => {
  const harness = await createHarness();
  const result = await harness.emit(
    "before_prompt_build",
    {
      prompt: "System (untrusted): [2026-04-22 17:36:45 GMT+8] Exec completed (tidal-ha, code 0) :: WSL2221 CLOSED WSL2222 CLOSED DISK 56% MEM 40%\n\nAn async command you ran earlier has completed. The result is shown in the system messages above. Handle the result internally. Do not relay it to the user unless explicitly requested."
    },
    { agentId: "dispatcher", runId: "run-system-root-1", sessionKey: "agent:dispatcher:main" }
  );

  assert.equal(result, undefined);
  const createCall = harness.taskFlowCalls.find((entry) => entry.type === "createManaged");
  assert.equal(createCall, undefined);
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

test("before_tool_call allows sessions_send by agentId alone for direct solo chats", async () => {
  const harness = await createHarness();
  await harness.emit(
    "before_prompt_build",
    { prompt: "分析一下目前这个项目最可能的技术债是什么" },
    { agentId: "dispatcher", runId: "run-send-solo-1", sessionKey: "agent:dispatcher:main" }
  );

  const result = await harness.emit(
    "before_tool_call",
    { toolName: "sessions_send", params: { agentId: "builder", message: "最近在看什么？" } },
    { agentId: "dispatcher", runId: "run-send-solo-1", sessionKey: "agent:dispatcher:main" }
  );

  assert.equal(result, undefined);
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

test("after_tool_call rejects reusing the same child lane across different parent flows", async () => {
  const harness = await createHarness();

  await startMissionFlow(harness, "run-parent-a");
  await discoverSessions(harness, "run-parent-a");
  await harness.emit(
    "before_tool_call",
    {
      toolName: "sessions_spawn",
      toolCallId: "tool-a",
      params: { agentId: "builder", label: "fix-a", task: "修复 A" }
    },
    { agentId: "dispatcher", runId: "run-parent-a", sessionKey: "agent:dispatcher:main" }
  );
  await harness.emit(
    "after_tool_call",
    {
      toolName: "sessions_spawn",
      toolCallId: "tool-a",
      params: { agentId: "builder", label: "fix-a", task: "修复 A" },
      result: {
        details: {
          status: "accepted",
          childSessionKey: "agent:builder:subagent:dedupe-1",
          runId: "child-run-dedupe-1"
        }
      }
    },
    { agentId: "dispatcher", runId: "run-parent-a", sessionKey: "agent:dispatcher:main" }
  );

  const secondSessionKey = "agent:dispatcher:other-main";
  await startMissionFlow(harness, "run-parent-b", "协调完成一个真实 E2E：让合适的子 agent 修复另一个构建失败并交付结果。", secondSessionKey);
  await discoverSessions(harness, "run-parent-b", secondSessionKey);
  await harness.emit(
    "before_tool_call",
    {
      toolName: "sessions_spawn",
      toolCallId: "tool-b",
      params: { agentId: "builder", label: "fix-b", task: "修复 B" }
    },
    { agentId: "dispatcher", runId: "run-parent-b", sessionKey: secondSessionKey }
  );
  await harness.emit(
    "after_tool_call",
    {
      toolName: "sessions_spawn",
      toolCallId: "tool-b",
      params: { agentId: "builder", label: "fix-b", task: "修复 B" },
      result: {
        details: {
          status: "accepted",
          childSessionKey: "agent:builder:subagent:dedupe-1",
          runId: "child-run-dedupe-1"
        }
      }
    },
    { agentId: "dispatcher", runId: "run-parent-b", sessionKey: secondSessionKey }
  );

  const runTaskCalls = harness.taskFlowCalls.filter((entry) => entry.type === "runTask");
  assert.equal(runTaskCalls.length, 1);
  const secondCreateCall = harness.taskFlowCalls.filter((entry) => entry.type === "createManaged")[1];
  assert.ok(secondCreateCall);
  const secondFlow = harness.flows.get(secondCreateCall.flow.flowId);
  assert.equal(secondFlow.currentStep, "blocked");
  assert.equal(secondFlow.stateJson.state, "blocked");
  assert.equal(secondFlow.stateJson.lastFailureKind, "child_link_conflict");
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
