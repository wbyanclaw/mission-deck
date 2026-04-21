import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import plugin, { __test__ } from "../index.js";
import { canTreatWaitingRunAsCompleted, createDashboardStore } from "../lib/dashboard-store.js";

function buildConfig() {
  return {
    agents: {
      defaults: {
        workspace: "/workspace/default",
        subagents: { allowAgents: ["builder", "reviewer", "ops"] }
      },
      list: [
        {
          id: "dispatcher",
          workspace: "/workspace/dispatcher",
          identity: { name: "Dispatcher", theme: "Coordination" },
          subagents: { allowAgents: ["builder", "reviewer", "ops"] },
          tools: { profile: "full" },
          default: true
        },
        {
          id: "builder",
          workspace: "/workspace/builder",
          identity: { name: "Builder", theme: "Engineering delivery" },
          tools: { profile: "full" }
        },
        {
          id: "reviewer",
          workspace: "/workspace/reviewer",
          identity: { name: "Reviewer", theme: "QA and review" },
          tools: { profile: "full" }
        },
        {
          id: "ops",
          workspace: "/workspace/ops",
          identity: { name: "Ops", theme: "Operations support" },
          tools: { profile: "full" }
        }
      ]
    },
    tools: {
      agentToAgent: {
        enabled: true,
        allow: ["dispatcher", "builder", "reviewer", "ops"]
      },
      sandbox: {
        tools: {
          allow: ["group:fs"]
        }
      }
    },
    plugins: {
      entries: {
        "mission-deck": {
          config: {
            enabledAgents: ["dispatcher", "builder", "reviewer", "ops"],
            agentWorkspaceRoots: {
              dispatcher: "/override/dispatcher",
              builder: "/override/builder"
            }
          }
        }
      }
    },
    mcp: {
      servers: {}
    }
  };
}

async function createHarness(pluginConfig = {}, harnessOptions = {}) {
  const handlers = new Map();
  const logs = [];
  const taskFlowCalls = [];
  const tempRoot = await mkdtemp(join(tmpdir(), "mission-deck-test-"));
  const dashboardStatusPath = join(tempRoot, "status.json");
  const dashboardDataDir = join(tempRoot, "data");
  let flowSequence = 0;
  let taskSequence = 0;
  const flows = new Map();

  function makeFlow(goal, patch = {}) {
    flowSequence += 1;
    const flow = {
      flowId: `flow-${flowSequence}`,
      revision: 1,
      status: "running",
      goal,
      currentStep: "",
      stateJson: null,
      waitJson: null,
      ...patch
    };
    flows.set(flow.flowId, flow);
    return flow;
  }

  function updateFlow(flowId, patch, expectedRevision = null) {
    const current = flows.get(flowId);
    if (!current) return { applied: false, current: null };
    if (Number.isFinite(expectedRevision) && current.revision !== expectedRevision) {
      return { applied: false, reason: "revision_conflict", current };
    }
    const next = {
      ...current,
      ...patch,
      revision: current.revision + 1
    };
    flows.set(flowId, next);
    if (harnessOptions.noTransitionCurrent === true) {
      return { applied: true };
    }
    if (harnessOptions.staleTransitionCurrent === true) {
      return { applied: true, current };
    }
    return { applied: true, current: next };
  }

  const api = {
    config: harnessOptions.config ?? buildConfig(),
    pluginConfig: {
      ...pluginConfig,
      dashboardStatusPath,
      dashboardDataDir
    },
    logger: {
      info(message) {
        logs.push(message);
      },
      warn(message) {
        logs.push(message);
      }
    },
    runtime: harnessOptions.runtime ?? {
      taskFlow: {
        bindSession({ sessionKey }) {
          return {
            sessionKey,
            createManaged(params) {
              const flow = makeFlow(params.goal, {
                status: params.status || "running",
                currentStep: params.currentStep || ""
              });
              taskFlowCalls.push({ type: "createManaged", sessionKey, params, flow });
              return flow;
            },
            get(flowId) {
              return flows.get(flowId);
            },
            getTaskSummary(flowId) {
              const tasks = taskFlowCalls.filter((entry) => entry.type === "runTask" && entry.params.flowId === flowId);
              const active = tasks.filter((entry) => !["completed", "blocked", "failed"].includes(entry.params.status || "running")).length;
              return {
                total: tasks.length,
                active,
                terminal: tasks.length - active,
                failures: 0,
                byStatus: { running: active },
                byRuntime: {}
              };
            },
            setWaiting(params) {
              return updateFlow(params.flowId, {
                status: params.blockedSummary ? "blocked" : "waiting",
                currentStep: params.currentStep || "",
                blockedSummary: params.blockedSummary || "",
                waitJson: params.waitJson || null,
                stateJson: params.stateJson ?? flows.get(params.flowId)?.stateJson ?? null
              }, params.expectedRevision);
            },
            resume(params) {
              return updateFlow(params.flowId, {
                status: params.status || "running",
                currentStep: params.currentStep || "",
                waitJson: params.waitJson || null,
                stateJson: params.stateJson ?? flows.get(params.flowId)?.stateJson ?? null
              }, params.expectedRevision);
            },
            finish(params) {
              return updateFlow(params.flowId, {
                status: "succeeded",
                currentStep: params.currentStep || "",
                stateJson: params.stateJson ?? flows.get(params.flowId)?.stateJson ?? null
              }, params.expectedRevision);
            },
            fail(params) {
              return updateFlow(params.flowId, {
                status: "failed",
                currentStep: params.currentStep || "",
                blockedSummary: params.blockedSummary || "",
                stateJson: params.stateJson ?? flows.get(params.flowId)?.stateJson ?? null
              }, params.expectedRevision);
            },
            runTask(params) {
              taskSequence += 1;
              const task = { taskId: `task-${taskSequence}` };
              taskFlowCalls.push({ type: "runTask", sessionKey, params, task });
              return { created: true, task, flow: flows.get(params.flowId) };
            }
          };
        }
      }
    },
    on(name, handler) {
      handlers.set(name, handler);
    }
  };

  plugin.register(api);
  return {
    logs,
    taskFlowCalls,
    dashboardStatusPath,
    flows,
    async emit(name, event, ctx) {
      return handlers.get(name)?.(event, ctx);
    }
  };
}

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

test("before_tool_call blocks non-routing work before internal routing on mission-flow tasks", async () => {
  const harness = await createHarness();
  await harness.emit(
    "before_prompt_build",
    { prompt: "协调完成一个真实 E2E：让合适的子 agent 修复构建失败并交付结果。" },
    { agentId: "dispatcher", runId: "run-route-1", sessionKey: "agent:dispatcher:main" }
  );
  const result = await harness.emit(
    "before_tool_call",
    { toolName: "exec", params: { cmd: "pwd" } },
    { agentId: "dispatcher", runId: "run-route-1", sessionKey: "agent:dispatcher:main" }
  );
  assert.equal(result.block, true);
  assert.match(result.blockReason, /requires routing first/i);
});

test("before_tool_call allows planning-safe read before routing", async () => {
  const harness = await createHarness();
  await harness.emit(
    "before_prompt_build",
    { prompt: "协调完成一个真实 E2E：让合适的子 agent 修复构建失败并交付结果。" },
    { agentId: "dispatcher", runId: "run-safe-read-1", sessionKey: "agent:dispatcher:main" }
  );
  const result = await harness.emit(
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
  assert.equal(result, undefined);
});

test("before_tool_call allows update_plan before routing", async () => {
  const harness = await createHarness();
  await harness.emit(
    "before_prompt_build",
    { prompt: "协调完成一个真实 E2E：让合适的子 agent 修复构建失败并交付结果。" },
    { agentId: "dispatcher", runId: "run-plan-tool-1", sessionKey: "agent:dispatcher:main" }
  );
  const result = await harness.emit(
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
  assert.equal(result, undefined);
});

test("before_tool_call blocks sessions_send that only supplies agentId", async () => {
  const harness = await createHarness();
  await harness.emit(
    "before_prompt_build",
    { prompt: "协调完成一个真实 E2E：让合适的子 agent 修复构建失败并交付结果。" },
    { agentId: "dispatcher", runId: "run-send-1", sessionKey: "agent:dispatcher:main" }
  );
  await harness.emit(
    "before_tool_call",
    { toolName: "sessions_list", params: {} },
    { agentId: "dispatcher", runId: "run-send-1", sessionKey: "agent:dispatcher:main" }
  );
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
  await harness.emit(
    "before_prompt_build",
    { prompt: "协调完成一个真实 E2E：让合适的子 agent 修复构建失败并交付结果。" },
    { agentId: "dispatcher", runId: "run-dispatch-1", sessionKey: "agent:dispatcher:main" }
  );
  await harness.emit(
    "before_tool_call",
    { toolName: "sessions_list", params: {} },
    { agentId: "dispatcher", runId: "run-dispatch-1", sessionKey: "agent:dispatcher:main" }
  );
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

test("before_message_write rewrites premature finalize candidate when delegation evidence is missing", async () => {
  const harness = await createHarness();
  await harness.emit(
    "before_prompt_build",
    { prompt: "修复当前构建失败并交付结果" },
    { agentId: "dispatcher", runId: "run-finalize-1", sessionKey: "agent:dispatcher:main" }
  );
  await harness.emit(
    "before_tool_call",
    { toolName: "sessions_list", params: {} },
    { agentId: "dispatcher", runId: "run-finalize-1", sessionKey: "agent:dispatcher:main" }
  );
  const result = await harness.emit(
    "before_message_write",
    {
      message: {
        role: "assistant",
        content: [{ type: "text", text: "已完成，汇总如下" }]
      }
    },
    { agentId: "dispatcher", runId: "run-finalize-1", sessionKey: "agent:dispatcher:main" }
  );
  assert.ok(result?.message);
  assert.match(result.message.content[0].text, /继续内部执行中/);
});

test("before_message_write rewrites unverified execution-progress claim when delegation evidence is missing", async () => {
  const harness = await createHarness();
  await harness.emit(
    "before_prompt_build",
    { prompt: "修复当前构建失败并交付结果" },
    { agentId: "dispatcher", runId: "run-progress-claim-1", sessionKey: "agent:dispatcher:main" }
  );
  await harness.emit(
    "before_tool_call",
    { toolName: "sessions_list", params: {} },
    { agentId: "dispatcher", runId: "run-progress-claim-1", sessionKey: "agent:dispatcher:main" }
  );
  const result = await harness.emit(
    "before_message_write",
    {
      message: {
        role: "assistant",
        content: [{ type: "text", text: "已在执行，不停在计划。等码钳回执真实写入和验读结果后，我直接汇总给你。" }]
      }
    },
    { agentId: "dispatcher", runId: "run-progress-claim-1", sessionKey: "agent:dispatcher:main" }
  );
  assert.ok(result?.message);
  assert.match(result.message.content[0].text, /继续内部执行中/);
});

test("parent mission-flow run is retained through waiting_child so child completion can reconcile", async () => {
  const harness = await createHarness();
  await harness.emit(
    "before_prompt_build",
    { prompt: "修复当前构建失败并交付结果" },
    { agentId: "dispatcher", runId: "run-parent-1", sessionKey: "agent:dispatcher:main" }
  );
  await harness.emit(
    "before_tool_call",
    { toolName: "sessions_list", params: {} },
    { agentId: "dispatcher", runId: "run-parent-1", sessionKey: "agent:dispatcher:main" }
  );
  await harness.emit(
    "before_tool_call",
    {
      toolName: "sessions_spawn",
      toolCallId: "tool-child-1",
      params: {
        agentId: "builder",
        label: "fix-build",
        task: "修复构建失败"
      }
    },
    { agentId: "dispatcher", runId: "run-parent-1", sessionKey: "agent:dispatcher:main" }
  );
  await harness.emit(
    "after_tool_call",
    {
      toolName: "sessions_spawn",
      toolCallId: "tool-child-1",
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
    { agentId: "dispatcher", runId: "run-parent-1", sessionKey: "agent:dispatcher:main" }
  );
  await harness.emit(
    "agent_end",
    {},
    { agentId: "dispatcher", runId: "run-parent-1", sessionKey: "agent:dispatcher:main" }
  );

  await harness.emit(
    "before_prompt_build",
    { prompt: "修复构建失败" },
    { agentId: "builder", runId: "child-run-1", sessionKey: "agent:builder:subagent:1" }
  );
  await harness.emit(
    "before_message_write",
    {
      message: {
        role: "assistant",
        content: [{ type: "text", text: "已修复构建失败并完成验证。" }]
      }
    },
    { agentId: "builder", runId: "child-run-1", sessionKey: "agent:builder:subagent:1" }
  );
  await harness.emit(
    "agent_end",
    {},
    { agentId: "builder", runId: "child-run-1", sessionKey: "agent:builder:subagent:1" }
  );

  const flow = harness.flows.get("flow-1");
  assert.equal(flow.status, "waiting");
  assert.equal(flow.currentStep, "reviewing");
  assert.equal(flow.stateJson.state, "reviewing");
  assert.equal(flow.stateJson.childTasks[0].phase, "completed");
});

test("parent retention and child reconciliation still work when taskflow transitions omit current snapshots", async () => {
  const harness = await createHarness({}, { noTransitionCurrent: true });
  await harness.emit(
    "before_prompt_build",
    { prompt: "修复当前构建失败并交付结果" },
    { agentId: "dispatcher", runId: "run-parent-no-current-1", sessionKey: "agent:dispatcher:main" }
  );
  await harness.emit(
    "before_tool_call",
    { toolName: "sessions_list", params: {} },
    { agentId: "dispatcher", runId: "run-parent-no-current-1", sessionKey: "agent:dispatcher:main" }
  );
  await harness.emit(
    "before_tool_call",
    {
      toolName: "sessions_spawn",
      toolCallId: "tool-child-no-current-1",
      params: {
        agentId: "builder",
        label: "fix-build",
        task: "修复构建失败"
      }
    },
    { agentId: "dispatcher", runId: "run-parent-no-current-1", sessionKey: "agent:dispatcher:main" }
  );
  await harness.emit(
    "after_tool_call",
    {
      toolName: "sessions_spawn",
      toolCallId: "tool-child-no-current-1",
      params: {
        agentId: "builder",
        label: "fix-build",
        task: "修复构建失败"
      },
      result: {
        details: {
          status: "accepted",
          childSessionKey: "agent:builder:subagent:2",
          runId: "child-run-no-current-1"
        }
      }
    },
    { agentId: "dispatcher", runId: "run-parent-no-current-1", sessionKey: "agent:dispatcher:main" }
  );
  await harness.emit(
    "agent_end",
    {},
    { agentId: "dispatcher", runId: "run-parent-no-current-1", sessionKey: "agent:dispatcher:main" }
  );

  await harness.emit(
    "before_prompt_build",
    { prompt: "修复构建失败" },
    { agentId: "builder", runId: "child-run-no-current-1", sessionKey: "agent:builder:subagent:2" }
  );
  await harness.emit(
    "before_message_write",
    {
      message: {
        role: "assistant",
        content: [{ type: "text", text: "已修复构建失败并完成验证。" }]
      }
    },
    { agentId: "builder", runId: "child-run-no-current-1", sessionKey: "agent:builder:subagent:2" }
  );
  await harness.emit(
    "agent_end",
    {},
    { agentId: "builder", runId: "child-run-no-current-1", sessionKey: "agent:builder:subagent:2" }
  );

  const flow = harness.flows.get("flow-1");
  assert.equal(flow.status, "waiting");
  assert.equal(flow.currentStep, "reviewing");
  assert.equal(flow.stateJson.state, "reviewing");
  assert.equal(flow.stateJson.childTasks[0].phase, "completed");
});

test("parent retention and child reconciliation still work when taskflow transitions return stale snapshots", async () => {
  const harness = await createHarness({}, { staleTransitionCurrent: true });
  await harness.emit(
    "before_prompt_build",
    { prompt: "修复当前构建失败并交付结果" },
    { agentId: "dispatcher", runId: "run-parent-stale-1", sessionKey: "agent:dispatcher:main" }
  );
  await harness.emit(
    "before_tool_call",
    { toolName: "sessions_list", params: {} },
    { agentId: "dispatcher", runId: "run-parent-stale-1", sessionKey: "agent:dispatcher:main" }
  );
  await harness.emit(
    "before_tool_call",
    {
      toolName: "sessions_spawn",
      toolCallId: "tool-child-stale-1",
      params: {
        agentId: "builder",
        label: "fix-build",
        task: "修复构建失败"
      }
    },
    { agentId: "dispatcher", runId: "run-parent-stale-1", sessionKey: "agent:dispatcher:main" }
  );
  await harness.emit(
    "after_tool_call",
    {
      toolName: "sessions_spawn",
      toolCallId: "tool-child-stale-1",
      params: {
        agentId: "builder",
        label: "fix-build",
        task: "修复构建失败"
      },
      result: {
        details: {
          status: "accepted",
          childSessionKey: "agent:builder:subagent:4",
          runId: "child-run-stale-1"
        }
      }
    },
    { agentId: "dispatcher", runId: "run-parent-stale-1", sessionKey: "agent:dispatcher:main" }
  );
  await harness.emit(
    "agent_end",
    {},
    { agentId: "dispatcher", runId: "run-parent-stale-1", sessionKey: "agent:dispatcher:main" }
  );

  await harness.emit(
    "before_prompt_build",
    { prompt: "修复构建失败" },
    { agentId: "builder", runId: "child-run-stale-1", sessionKey: "agent:builder:subagent:4" }
  );
  await harness.emit(
    "before_message_write",
    {
      message: {
        role: "assistant",
        content: [{ type: "text", text: "已修复构建失败并完成验证。" }]
      }
    },
    { agentId: "builder", runId: "child-run-stale-1", sessionKey: "agent:builder:subagent:4" }
  );
  await harness.emit(
    "agent_end",
    {},
    { agentId: "builder", runId: "child-run-stale-1", sessionKey: "agent:builder:subagent:4" }
  );

  const flow = harness.flows.get("flow-1");
  assert.equal(flow.status, "waiting");
  assert.equal(flow.currentStep, "reviewing");
  assert.equal(flow.stateJson.state, "reviewing");
  assert.equal(flow.stateJson.childTasks[0].phase, "completed");
});

test("synthetic announce completes the retained parent flow before allowing final delivery", async () => {
  const harness = await createHarness();
  await harness.emit(
    "before_prompt_build",
    { prompt: "修复当前构建失败并交付结果" },
    { agentId: "dispatcher", runId: "run-parent-synth-1", sessionKey: "agent:dispatcher:main" }
  );
  await harness.emit(
    "before_tool_call",
    { toolName: "sessions_list", params: {} },
    { agentId: "dispatcher", runId: "run-parent-synth-1", sessionKey: "agent:dispatcher:main" }
  );
  await harness.emit(
    "before_tool_call",
    {
      toolName: "sessions_spawn",
      toolCallId: "tool-child-synth-1",
      params: {
        agentId: "builder",
        label: "fix-build",
        task: "修复构建失败"
      }
    },
    { agentId: "dispatcher", runId: "run-parent-synth-1", sessionKey: "agent:dispatcher:main" }
  );
  await harness.emit(
    "after_tool_call",
    {
      toolName: "sessions_spawn",
      toolCallId: "tool-child-synth-1",
      params: {
        agentId: "builder",
        label: "fix-build",
        task: "修复构建失败"
      },
      result: {
        details: {
          status: "accepted",
          childSessionKey: "agent:builder:subagent:5",
          runId: "child-run-synth-1"
        }
      }
    },
    { agentId: "dispatcher", runId: "run-parent-synth-1", sessionKey: "agent:dispatcher:main" }
  );
  await harness.emit(
    "agent_end",
    {},
    { agentId: "dispatcher", runId: "run-parent-synth-1", sessionKey: "agent:dispatcher:main" }
  );

  await harness.emit(
    "before_prompt_build",
    { prompt: "修复构建失败" },
    { agentId: "builder", runId: "child-run-synth-1", sessionKey: "agent:builder:subagent:5" }
  );
  await harness.emit(
    "before_message_write",
    {
      message: {
        role: "assistant",
        content: [{ type: "text", text: "已真实读取 `mission-deck/package.json`，其中存在 `build` script。" }]
      }
    },
    { agentId: "builder", runId: "child-run-synth-1", sessionKey: "agent:builder:subagent:5" }
  );
  await harness.emit(
    "agent_end",
    {},
    { agentId: "builder", runId: "child-run-synth-1", sessionKey: "agent:builder:subagent:5" }
  );

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
  await harness.emit(
    "before_prompt_build",
    { prompt: "修复当前构建失败并交付结果" },
    { agentId: "dispatcher", runId: "run-parent-recover-1", sessionKey: "agent:dispatcher:main" }
  );
  await harness.emit(
    "before_tool_call",
    { toolName: "sessions_list", params: {} },
    { agentId: "dispatcher", runId: "run-parent-recover-1", sessionKey: "agent:dispatcher:main" }
  );
  await harness.emit(
    "before_tool_call",
    {
      toolName: "sessions_spawn",
      toolCallId: "tool-child-recover-ok",
      params: {
        agentId: "builder",
        label: "fix-build",
        task: "修复构建失败"
      }
    },
    { agentId: "dispatcher", runId: "run-parent-recover-1", sessionKey: "agent:dispatcher:main" }
  );
  await harness.emit(
    "after_tool_call",
    {
      toolName: "sessions_spawn",
      toolCallId: "tool-child-recover-ok",
      params: {
        agentId: "builder",
        label: "fix-build",
        task: "修复构建失败"
      },
      result: {
        details: {
          status: "accepted",
          childSessionKey: "agent:builder:subagent:6",
          runId: "child-run-recover-1"
        }
      }
    },
    { agentId: "dispatcher", runId: "run-parent-recover-1", sessionKey: "agent:dispatcher:main" }
  );
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
  await harness.emit(
    "agent_end",
    {},
    { agentId: "dispatcher", runId: "run-parent-recover-1", sessionKey: "agent:dispatcher:main" }
  );

  await harness.emit(
    "before_prompt_build",
    { prompt: "修复构建失败" },
    { agentId: "builder", runId: "child-run-recover-1", sessionKey: "agent:builder:subagent:6" }
  );
  await harness.emit(
    "before_message_write",
    {
      message: {
        role: "assistant",
        content: [{ type: "text", text: "已真实读取 `mission-deck/package.json`，其中存在 `build` script，内容是 `npm run check`。" }]
      }
    },
    { agentId: "builder", runId: "child-run-recover-1", sessionKey: "agent:builder:subagent:6" }
  );
  await harness.emit(
    "agent_end",
    {},
    { agentId: "builder", runId: "child-run-recover-1", sessionKey: "agent:builder:subagent:6" }
  );

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
  await harness.emit(
    "before_prompt_build",
    { prompt: "修复当前构建失败并交付结果" },
    { agentId: "dispatcher", runId: "run-root-continue-1", sessionKey: "agent:dispatcher:main" }
  );
  await harness.emit(
    "before_tool_call",
    { toolName: "sessions_list", params: {} },
    { agentId: "dispatcher", runId: "run-root-continue-1", sessionKey: "agent:dispatcher:main" }
  );
  await harness.emit(
    "before_tool_call",
    {
      toolName: "sessions_spawn",
      toolCallId: "tool-root-continue-1",
      params: {
        agentId: "builder",
        label: "fix-build",
        task: "修复构建失败"
      }
    },
    { agentId: "dispatcher", runId: "run-root-continue-1", sessionKey: "agent:dispatcher:main" }
  );
  await harness.emit(
    "after_tool_call",
    {
      toolName: "sessions_spawn",
      toolCallId: "tool-root-continue-1",
      params: {
        agentId: "builder",
        label: "fix-build",
        task: "修复构建失败"
      },
      result: {
        details: {
          status: "accepted",
          childSessionKey: "agent:builder:subagent:3",
          runId: "child-run-root-continue-1"
        }
      }
    },
    { agentId: "dispatcher", runId: "run-root-continue-1", sessionKey: "agent:dispatcher:main" }
  );
  await harness.emit(
    "agent_end",
    {},
    { agentId: "dispatcher", runId: "run-root-continue-1", sessionKey: "agent:dispatcher:main" }
  );

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

test("dashboard flush remains stable under concurrent writes", async () => {
  const tempRoot = await mkdtemp(join(tmpdir(), "mission-deck-dashboard-"));
  const statusPath = join(tempRoot, "status.json");
  const dashboard = createDashboardStore(
    { warn() {} },
    {
      statusPath,
      dataDir: join(tempRoot, "data")
    }
  );
  const runState = {
    entryMode: "mission-flow",
    orchestrationMode: "delegate_once",
    promptText: "test run",
    normalizedPromptText: "test run",
    chainAssessment: {
      code: "correct",
      summary: "ok",
      missing: "",
      nextAction: "",
      correct: true
    }
  };
  dashboard.trackActiveRun("run-a", "dispatcher", runState);
  await Promise.all([dashboard.flush(), dashboard.flush(), dashboard.flush()]);
  const snapshot = JSON.parse(await readFile(statusPath, "utf8"));
  const statusStat = await stat(statusPath);
  assert.ok(statusStat.isFile());
  assert.equal(Array.isArray(snapshot.activeRuns), true);
});

test("waiting runs with active child work are not treated as completed by dashboard inference", () => {
  assert.equal(canTreatWaitingRunAsCompleted({
    flowStatus: "waiting",
    lastExternalMessage: "已完成，汇总如下",
    childTasks: [{ phase: "running" }]
  }), false);

  assert.equal(canTreatWaitingRunAsCompleted({
    flowStatus: "waiting",
    lastExternalMessage: "已完成，汇总如下",
    childTasks: [{ phase: "completed" }],
    flowTaskSummary: { active: 0 }
  }), true);
});
