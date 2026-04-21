import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import plugin, { __test__ } from "../index.js";
import { canTreatWaitingRunAsCompleted } from "../lib/dashboard-store.js";

function buildConfig() {
  return {
    agents: {
      defaults: {
        workspace: "/workspace/default"
      },
      list: [
        {
          id: "dispatcher",
          workspace: "/workspace/dispatcher",
          identity: { name: "Dispatcher", theme: "Coordination" },
          subagents: { allowAgents: ["builder", "reviewer", "ops"] },
          tools: { profile: "messaging" }
        },
        {
          id: "builder",
          workspace: "/workspace/builder",
          identity: { name: "Builder", theme: "Engineering delivery" },
          tools: { profile: "coding" }
        },
        {
          id: "reviewer",
          workspace: "/workspace/reviewer",
          identity: { name: "Reviewer", theme: "QA and review" },
          tools: { profile: "coding" }
        },
        {
          id: "ops",
          workspace: "/workspace/ops",
          identity: { name: "Ops", theme: "Operations support" },
          tools: { profile: "coding" }
        }
      ]
    },
    tools: {
      agentToAgent: {
        enabled: true,
        allow: ["dispatcher", "builder", "reviewer", "ops"]
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
    }
  };
}

function buildMarketConfig() {
  return {
    agents: {
      defaults: {
        workspace: "/workspace/default"
      },
      list: [
        {
          id: "dispatcher",
          identity: { name: "Dispatcher", theme: "General coordination" },
          tools: { profile: "messaging" },
          subagents: { allowAgents: ["builder", "researcher", "reviewer"] }
        },
        {
          id: "builder",
          identity: { name: "Builder", theme: "Engineering delivery and debugging" },
          tools: { profile: "coding" }
        },
        {
          id: "researcher",
          identity: { name: "Research Analyst", theme: "Market research and macro analysis" },
          tools: { profile: "messaging" }
        },
        {
          id: "reviewer",
          identity: { name: "Reviewer", theme: "Project review and delivery checks" },
          tools: { profile: "messaging" }
        }
      ]
    },
    tools: {
      agentToAgent: {
        enabled: true,
        allow: ["dispatcher", "builder", "researcher", "reviewer"]
      }
    }
  };
}

function buildGenericMarketConfig() {
  return {
    agents: {
      defaults: {
        workspace: "/workspace/default"
      },
      list: [
        {
          id: "dispatcher",
          identity: { name: "Dispatcher", theme: "General coordination" },
          tools: { profile: "messaging" },
          subagents: { allowAgents: ["builder", "researcher", "project-lead"] }
        },
        {
          id: "builder",
          identity: { name: "Builder", theme: "Engineering delivery" },
          tools: { profile: "coding" }
        },
        {
          id: "researcher",
          identity: { name: "Research Analyst", theme: "Market research and macro analysis" },
          tools: { profile: "messaging" }
        },
        {
          id: "project-lead",
          identity: { name: "Project Lead", theme: "Project delivery coordination" },
          tools: { profile: "messaging" }
        }
      ]
    },
    tools: {
      agentToAgent: {
        enabled: true,
        allow: ["dispatcher", "builder", "researcher", "project-lead"]
      }
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
  function makeFlow(goal) {
    flowSequence += 1;
    const flow = {
      flowId: `flow-${flowSequence}`,
      revision: 1,
      status: "running",
      goal,
      currentStep: ""
    };
    flows.set(flow.flowId, flow);
    return flow;
  }
  function updateFlow(flowId, patch) {
    const current = flows.get(flowId);
    if (!current) return { applied: false, current: null };
    const next = {
      ...current,
      ...patch,
      revision: current.revision + 1
    };
    flows.set(flowId, next);
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
              const flow = makeFlow(params.goal);
              taskFlowCalls.push({ type: "createManaged", sessionKey, params, flow });
              return flow;
            },
            get(flowId) {
              return flows.get(flowId);
            },
            getTaskSummary(flowId) {
              const tasks = taskFlowCalls.filter((entry) => entry.type === "runTask" && entry.params.flowId === flowId);
              return {
                total: tasks.length,
                active: tasks.length,
                terminal: 0,
                failures: 0,
                byStatus: { running: tasks.length },
                byRuntime: {}
              };
            },
            setWaiting(params) {
              return updateFlow(params.flowId, {
                status: params.blockedSummary ? "blocked" : "waiting",
                currentStep: params.currentStep || "",
                blockedSummary: params.blockedSummary || "",
                waitJson: params.waitJson
              });
            },
            resume(params) {
              return updateFlow(params.flowId, {
                status: params.status || "queued",
                currentStep: params.currentStep || ""
              });
            },
            finish(params) {
              return updateFlow(params.flowId, {
                status: "succeeded",
                currentStep: params.currentStep || ""
              });
            },
            fail(params) {
              return updateFlow(params.flowId, {
                status: "failed",
                currentStep: params.currentStep || "",
                blockedSummary: params.blockedSummary || ""
              });
            },
            runTask(params) {
              taskSequence += 1;
              const flow = flows.get(params.flowId) ?? makeFlow(params.task);
              const task = { taskId: `task-${taskSequence}` };
              taskFlowCalls.push({ type: "runTask", sessionKey, params, flow, task });
              return { created: true, flow, task };
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

test("broad task requests are treated as orchestratable even without engineering keywords", () => {
  assert.equal(__test__.isEngineeringPrompt("查一下最近美国伊朗的最新局势", {}), true);
  assert.equal(__test__.isEngineeringPrompt("帮我汇总一下今天的重点变化并给判断", {}), true);
});

test("trivial acknowledgements are not treated as orchestratable tasks", () => {
  assert.equal(__test__.isEngineeringPrompt("好的", {}), false);
  assert.equal(__test__.isEngineeringPrompt("谢谢", {}), false);
});

test("market research tasks prefer researcher over builder", () => {
  const suggestion = __test__.buildSpawnSuggestion(buildMarketConfig(), "dispatcher", "Analyze next week's equity market outlook");
  assert.ok(suggestion);
  assert.equal(suggestion.agentId, "researcher");
});

test("market research tasks can route using generic role themes instead of team-specific ids", () => {
  const suggestion = __test__.buildSpawnSuggestion(buildGenericMarketConfig(), "dispatcher", "Analyze next week's equity market outlook");
  assert.ok(suggestion);
  assert.equal(suggestion.agentId, "researcher");
});

test("low-signal generic prompts do not force a default executor", () => {
  const suggestion = __test__.buildSpawnSuggestion(buildMarketConfig(), "dispatcher", "take a look");
  assert.equal(suggestion, null);
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
    flowTaskSummary: { active: 1 }
  }), false);

  assert.equal(canTreatWaitingRunAsCompleted({
    flowStatus: "waiting",
    lastExternalMessage: "已完成，汇总如下",
    childTasks: [{ phase: "completed" }],
    flowTaskSummary: { active: 0 }
  }), true);
});

test("extractDispatchTarget classifies reused channel sessions and spawned subagent sessions", () => {
  const sendTarget = __test__.extractDispatchTarget(
    "sessions_send",
    { sessionKey: "agent:builder:feishu:direct:ou_xxx", message: "继续修复" },
    {}
  );
  assert.equal(sendTarget.agentId, "builder");
  assert.equal(sendTarget.routeType, "send");
  assert.equal(sendTarget.targetKind, "persistent-channel-session");

  const spawnTarget = __test__.extractDispatchTarget(
    "sessions_spawn",
    { agentId: "builder", task: "修复 bug" },
    { childSessionKey: "agent:builder:subagent:run-1" }
  );
  assert.equal(spawnTarget.routeType, "spawn");
  assert.equal(spawnTarget.targetKind, "subagent-session");
});

test("readToolResultDetails merges nested runtime detail shapes", () => {
  const details = __test__.readToolResultDetails({
    result: {
      details: {
        status: "accepted",
        childSessionKey: "agent:builder:subagent:99",
        runId: "run-99"
      }
    }
  });
  assert.equal(details.status, "accepted");
  assert.equal(details.childSessionKey, "agent:builder:subagent:99");
  assert.equal(details.runId, "run-99");
});

test("before_prompt_build injects configuration-driven coordination guidance", async () => {
  const harness = await createHarness({ enabledAgents: ["dispatcher", "builder", "reviewer", "ops"] });
  const result = await harness.emit(
    "before_prompt_build",
    { prompt: "请继续完成 repo 里的 bug 修复和测试" },
    { agentId: "dispatcher", runId: "run-guidance" }
  );
  assert.ok(result.appendSystemContext.includes("Configured peer agents: builder, reviewer, ops."));
  assert.ok(result.appendSystemContext.includes("Recommended internal executor for this task: builder"));
  assert.match(result.appendSystemContext, /Visibility rule:/);
  assert.match(result.appendSystemContext, /Route selection rule:/);
  assert.ok(result.appendSystemContext.includes("/workspace/builder"));
});

test("plugin surfaces a prerequisite warning when host lacks TaskFlow and A2A", async () => {
  const harness = await createHarness(
    { enabledAgents: ["dispatcher"] },
    {
      config: {
        ...buildConfig(),
        tools: {
          agentToAgent: {
            enabled: false,
            allow: []
          }
        }
      },
      runtime: {}
    }
  );
  const promptResult = await harness.emit(
    "before_prompt_build",
    { prompt: "请继续完成 repo 里的 bug 修复和测试" },
    { agentId: "dispatcher", runId: "run-prereq-check", sessionKey: "agent:dispatcher:main" }
  );
  assert.match(promptResult.appendSystemContext, /prerequisite failure/i);
  assert.match(promptResult.appendSystemContext, /TaskFlow and agent-to-agent/i);

  const toolResult = await harness.emit(
    "before_tool_call",
    { toolName: "sessions_list", params: {} },
    { agentId: "dispatcher", runId: "run-prereq-check", sessionKey: "agent:dispatcher:main" }
  );
  assert.equal(toolResult.block, true);
  assert.match(toolResult.blockReason, /TaskFlow and agent-to-agent/i);
});

test("dashboard persistence redacts prompt metadata and raw session keys by default", async () => {
  const harness = await createHarness({ enabledAgents: ["dispatcher", "builder"] });
  await harness.emit(
    "before_prompt_build",
    {
      prompt: "Conversation info (untrusted metadata):\n```json\n{\"chat_id\":\"o9cq80wHzmQcHbAYaJVfZF9ZV4Lc@im.wechat\",\"message_id\":\"openclaw-weixin:1776517529119-782d8e93\"}\n```\n\n请继续跟进这个任务"
    },
    { agentId: "dispatcher", runId: "run-redaction", sessionKey: "agent:dispatcher:main" }
  );
  await harness.emit(
    "before_tool_call",
    {
      toolName: "sessions_send",
      toolCallId: "send-redaction",
      params: { sessionKey: "agent:builder:feishu:direct:ou_secretpeer", message: "继续处理" }
    },
    { agentId: "dispatcher", runId: "run-redaction", sessionKey: "agent:dispatcher:main" }
  );
  await harness.emit(
    "after_tool_call",
    {
      toolName: "sessions_send",
      toolCallId: "send-redaction",
      result: { details: { status: "ok", sessionKey: "agent:builder:feishu:direct:ou_secretpeer", runId: "child-redaction" } }
    },
    { agentId: "dispatcher", runId: "run-redaction", sessionKey: "agent:dispatcher:main" }
  );
  await harness.emit(
    "agent_end",
    {},
    { agentId: "dispatcher", runId: "run-redaction", sessionKey: "agent:dispatcher:main" }
  );

  const snapshot = await readFile(harness.dashboardStatusPath, "utf8");
  assert.doesNotMatch(snapshot, /o9cq80wHzmQcHbAYaJVfZF9ZV4Lc@im\.wechat/);
  assert.doesNotMatch(snapshot, /openclaw-weixin:1776517529119-782d8e93/);
  assert.doesNotMatch(snapshot, /agent:builder:feishu:direct:ou_secretpeer/);
  assert.doesNotMatch(snapshot, /\bou_secretpeer\b/);
  assert.match(snapshot, /redacted:builder:feishu:/);
});

test("before_tool_call blocks premature sessions_spawn before checking visible sessions", async () => {
  const harness = await createHarness({ enabledAgents: ["dispatcher", "builder"] });
  await harness.emit(
    "before_prompt_build",
    { prompt: "请继续跟进 builder 当前任务" },
    { agentId: "dispatcher", runId: "run-spawn-block", sessionKey: "agent:dispatcher:main" }
  );
  const result = await harness.emit(
    "before_tool_call",
    { toolName: "sessions_spawn", params: { agentId: "builder", label: "follow-up", task: "继续跟进 builder 当前任务" } },
    { agentId: "dispatcher", runId: "run-spawn-block", sessionKey: "agent:dispatcher:main", toolName: "sessions_spawn" }
  );
  assert.equal(result.block, true);
  assert.match(result.blockReason, /First inspect visible teammate sessions/i);
  assert.match(result.blockReason, /Prefer sessions_send/i);
});

test("before_tool_call allows explicit acp sessions_spawn without prior visible-session lookup", async () => {
  const harness = await createHarness({ enabledAgents: ["dispatcher", "builder"] });
  await harness.emit(
    "before_prompt_build",
    { prompt: "需要 builder 开一个独立 ACP worker 跑测试" },
    { agentId: "dispatcher", runId: "run-spawn-acp-allow", sessionKey: "agent:dispatcher:main" }
  );
  const result = await harness.emit(
    "before_tool_call",
    {
      toolName: "sessions_spawn",
      params: { agentId: "builder", label: "test-worker", task: "在独立 ACP worker 里跑测试", runtime: "acp", mode: "run" }
    },
    { agentId: "dispatcher", runId: "run-spawn-acp-allow", sessionKey: "agent:dispatcher:main", toolName: "sessions_spawn" }
  );
  assert.equal(result, undefined);
});

test("before_tool_call blocks invalid sessions_send without session key or label", async () => {
  const harness = await createHarness({ enabledAgents: ["dispatcher"] });
  await harness.emit(
    "before_prompt_build",
    { prompt: "处理 repo 里的实现和测试" },
    { agentId: "dispatcher", runId: "run-send-block" }
  );
  const result = await harness.emit(
    "before_tool_call",
    { toolName: "sessions_send", params: { agentId: "builder", task: "继续开发" } },
    { agentId: "dispatcher", runId: "run-send-block" }
  );
  assert.equal(result.block, true);
  assert.match(result.blockReason, /sessions_send cannot target by agentId alone/i);
  assert.match(result.blockReason, /sessions_spawn/i);
});

test("execution-only agent cannot create second-hop delegation", async () => {
  const harness = await createHarness({ enabledAgents: ["builder", "reviewer"] });
  await harness.emit(
    "before_prompt_build",
    { prompt: "继续处理当前任务" },
    { agentId: "builder", runId: "run-secondary-hop", sessionKey: "agent:builder:main" }
  );
  const result = await harness.emit(
    "before_tool_call",
    { toolName: "sessions_spawn", params: { agentId: "reviewer", runtime: "acp", task: "帮我继续看一下" } },
    { agentId: "builder", runId: "run-secondary-hop", sessionKey: "agent:builder:main" }
  );
  assert.equal(result.block, true);
  assert.match(result.blockReason, /execution-only/i);
});

test("before_tool_call blocks premature user repo-path escalation before internal actions", async () => {
  const harness = await createHarness({ enabledAgents: ["builder"] });
  await harness.emit(
    "before_prompt_build",
    { prompt: "修复项目里的 bug 并交付" },
    { agentId: "builder", runId: "run-message-block" }
  );
  const result = await harness.emit(
    "before_tool_call",
    { toolName: "message", params: { text: "请直接发 repo path 给我" } },
    { agentId: "builder", runId: "run-message-block" }
  );
  assert.equal(result.block, true);
  assert.match(result.blockReason, /Use internal-first coordination/i);
});

test("user entrypoint escalation stays blocked until workspace discovery happens", async () => {
  const harness = await createHarness({ enabledAgents: ["dispatcher"] });
  await harness.emit(
    "before_prompt_build",
    { prompt: "安排大家体验即将上线的项目并汇总问题" },
    { agentId: "dispatcher", runId: "run-entrypoint-escalation", sessionKey: "agent:dispatcher:main" }
  );
  await harness.emit(
    "before_tool_call",
    { toolName: "sessions_list", params: { limit: 5 } },
    { agentId: "dispatcher", runId: "run-entrypoint-escalation", sessionKey: "agent:dispatcher:main" }
  );
  const result = await harness.emit(
    "before_tool_call",
    { toolName: "message", params: { text: "请直接发项目目录和测试地址给我" } },
    { agentId: "dispatcher", runId: "run-entrypoint-escalation", sessionKey: "agent:dispatcher:main" }
  );
  assert.equal(result.block, true);
  assert.match(result.blockReason, /Use internal-first coordination/i);
});

test("before_tool_call blocks assignment report before execution lane and taskflow linkage", async () => {
  const harness = await createHarness({ enabledAgents: ["dispatcher", "builder"] });
  await harness.emit(
    "before_prompt_build",
    { prompt: "Continue the bug fix and verification work in the repo" },
    { agentId: "dispatcher", runId: "run-delegation-block", sessionKey: "agent:dispatcher:main" }
  );
  const result = await harness.emit(
    "before_tool_call",
    { toolName: "message", params: { text: "已分派给 builder 开始修复。" } },
    { agentId: "dispatcher", runId: "run-delegation-block", sessionKey: "agent:dispatcher:main", toolName: "message" }
  );
  assert.equal(result.block, true);
  assert.match(result.blockReason, /flow id/i);
  assert.match(result.blockReason, /child-task/i);
});

test("after_tool_call for sessions_spawn creates taskflow flow and child task", async () => {
  const harness = await createHarness({ enabledAgents: ["dispatcher", "builder"] });
  await harness.emit(
    "before_prompt_build",
    { prompt: "请继续完成 repo 里的 bug 修复和测试" },
    { agentId: "dispatcher", runId: "run-taskflow-spawn", sessionKey: "agent:dispatcher:main" }
  );
  await harness.emit(
    "before_tool_call",
    { toolName: "sessions_spawn", toolCallId: "spawn-1", params: { agentId: "builder", label: "bug-fix", task: "修复 bug" } },
    { agentId: "dispatcher", runId: "run-taskflow-spawn", sessionKey: "agent:dispatcher:main", toolName: "sessions_spawn", toolCallId: "spawn-1" }
  );
  await harness.emit(
    "after_tool_call",
    {
      toolName: "sessions_spawn",
      toolCallId: "spawn-1",
      params: { agentId: "builder", label: "bug-fix", task: "修复 bug" },
      result: { status: "accepted", childSessionKey: "agent:builder:subagent:1", runId: "run-child-1" }
    },
    { agentId: "dispatcher", runId: "run-taskflow-spawn", sessionKey: "agent:dispatcher:main", toolName: "sessions_spawn", toolCallId: "spawn-1" }
  );

  assert.equal(harness.taskFlowCalls[0].type, "createManaged");
  assert.equal(harness.taskFlowCalls[1].type, "runTask");
  assert.equal(harness.taskFlowCalls[1].params.childSessionKey, "agent:builder:subagent:1");
  assert.equal(harness.taskFlowCalls[1].params.agentId, "builder");
});

test("after_tool_call accepts nested dispatch details when sessions_spawn succeeds", async () => {
  const harness = await createHarness({ enabledAgents: ["dispatcher", "builder"] });
  await harness.emit(
    "before_prompt_build",
    { prompt: "请继续完成 repo 里的 bug 修复和测试" },
    { agentId: "dispatcher", runId: "run-taskflow-nested", sessionKey: "agent:dispatcher:main" }
  );
  await harness.emit(
    "before_tool_call",
    { toolName: "sessions_spawn", toolCallId: "spawn-nested", params: { agentId: "builder", label: "bug-fix", task: "修复 bug" } },
    { agentId: "dispatcher", runId: "run-taskflow-nested", sessionKey: "agent:dispatcher:main", toolName: "sessions_spawn", toolCallId: "spawn-nested" }
  );
  await harness.emit(
    "after_tool_call",
    {
      toolName: "sessions_spawn",
      toolCallId: "spawn-nested",
      params: { agentId: "builder", label: "bug-fix", task: "修复 bug" },
      result: {
        details: { status: "accepted", childSessionKey: "agent:builder:subagent:99", runId: "run-child-99" }
      }
    },
    { agentId: "dispatcher", runId: "run-taskflow-nested", sessionKey: "agent:dispatcher:main", toolName: "sessions_spawn", toolCallId: "spawn-nested" }
  );

  assert.equal(harness.taskFlowCalls[1].params.childSessionKey, "agent:builder:subagent:99");
  assert.equal(harness.taskFlowCalls[1].params.runId, "run-child-99");
});

test("failed sessions_spawn is recorded as blocker instead of unknown success", async () => {
  const harness = await createHarness({ enabledAgents: ["dispatcher", "builder"] });
  await harness.emit(
    "before_prompt_build",
    { prompt: "请继续完成 repo 里的 bug 修复和测试" },
    { agentId: "dispatcher", runId: "run-taskflow-failed", sessionKey: "agent:dispatcher:main" }
  );
  await harness.emit(
    "before_tool_call",
    { toolName: "sessions_spawn", toolCallId: "spawn-failed", params: { agentId: "builder", label: "bug-fix", task: "修复 bug" } },
    { agentId: "dispatcher", runId: "run-taskflow-failed", sessionKey: "agent:dispatcher:main", toolName: "sessions_spawn", toolCallId: "spawn-failed" }
  );
  await harness.emit(
    "after_tool_call",
    {
      toolName: "sessions_spawn",
      toolCallId: "spawn-failed",
      params: { agentId: "builder", label: "bug-fix", task: "修复 bug" },
      result: { status: "forbidden", error: "agentId is not allowed for sessions_spawn (allowed: none)" }
    },
    { agentId: "dispatcher", runId: "run-taskflow-failed", sessionKey: "agent:dispatcher:main", toolName: "sessions_spawn", toolCallId: "spawn-failed" }
  );
  await harness.emit("agent_end", {}, { agentId: "dispatcher", runId: "run-taskflow-failed" });

  const snapshot = JSON.parse(await readFile(harness.dashboardStatusPath, "utf8"));
  const blocker = snapshot.recentBlockers.find((entry) => entry.runId === "run-taskflow-failed");
  const parent = snapshot.recentRuns.find((entry) => entry.runId === "run-taskflow-failed");
  assert.ok(blocker);
  assert.match(blocker.reason, /not allowed/i);
  assert.ok(parent);
  assert.equal(parent.lastToolStatus, "forbidden");
});

test("sessions_send timeout does not create a ghost child task", async () => {
  const harness = await createHarness({ enabledAgents: ["dispatcher", "builder"] });
  await harness.emit(
    "before_prompt_build",
    { prompt: "请继续跟进 builder 当前主会话里的修复进展" },
    { agentId: "dispatcher", runId: "run-send-timeout", sessionKey: "agent:dispatcher:main" }
  );
  await harness.emit(
    "before_tool_call",
    {
      toolName: "sessions_send",
      toolCallId: "send-timeout",
      params: {
        agentId: "builder",
        sessionKey: "agent:builder:feishu:direct:ou_visible",
        message: "继续修复并回报"
      }
    },
    { agentId: "dispatcher", runId: "run-send-timeout", sessionKey: "agent:dispatcher:main", toolName: "sessions_send", toolCallId: "send-timeout" }
  );
  await harness.emit(
    "after_tool_call",
    {
      toolName: "sessions_send",
      toolCallId: "send-timeout",
      params: {
        agentId: "builder",
        sessionKey: "agent:builder:feishu:direct:ou_visible",
        message: "继续修复并回报"
      },
      result: { status: "timeout", sessionKey: "agent:builder:feishu:direct:ou_visible" }
    },
    { agentId: "dispatcher", runId: "run-send-timeout", sessionKey: "agent:dispatcher:main", toolName: "sessions_send", toolCallId: "send-timeout" }
  );
  await harness.emit("agent_end", {}, { agentId: "dispatcher", runId: "run-send-timeout", sessionKey: "agent:dispatcher:main" });

  assert.equal(harness.taskFlowCalls[0].type, "createManaged");
  assert.equal(harness.taskFlowCalls.length, 1);

  const snapshot = JSON.parse(await readFile(harness.dashboardStatusPath, "utf8"));
  const parent = snapshot.recentRuns.find((entry) => entry.runId === "run-send-timeout");
  assert.ok(parent);
  assert.deepEqual(parent.childTaskIds, []);
});

test("invalid sessions_send alone does not satisfy the internal execution requirement", async () => {
  const harness = await createHarness({ enabledAgents: ["dispatcher", "builder"] });
  await harness.emit(
    "before_prompt_build",
    { prompt: "处理 repo 里的实现和测试" },
    { agentId: "dispatcher", runId: "run-invalid-send-only", sessionKey: "agent:dispatcher:main" }
  );
  await harness.emit(
    "before_tool_call",
    { toolName: "sessions_send", params: { agentId: "builder", task: "继续开发" } },
    { agentId: "dispatcher", runId: "run-invalid-send-only", sessionKey: "agent:dispatcher:main" }
  );
  const result = await harness.emit(
    "before_agent_reply",
    { cleanedBody: "NO_REPLY" },
    { agentId: "dispatcher", runId: "run-invalid-send-only", sessionKey: "agent:dispatcher:main" }
  );
  assert.equal(result.handled, true);
  assert.match(result.reply.text, /will not end silently/i);
});

test("child agent outcome is folded back into parent child task summary", async () => {
  const harness = await createHarness({ enabledAgents: ["dispatcher", "builder"] });
  await harness.emit(
    "before_prompt_build",
    { prompt: "请继续完成 repo 里的 bug 修复和测试" },
    { agentId: "dispatcher", runId: "run-parent", sessionKey: "agent:dispatcher:main" }
  );
  await harness.emit(
    "before_tool_call",
    { toolName: "sessions_spawn", toolCallId: "spawn-parent", params: { agentId: "builder", label: "bug-fix", task: "Fix the bug" } },
    { agentId: "dispatcher", runId: "run-parent", sessionKey: "agent:dispatcher:main", toolName: "sessions_spawn", toolCallId: "spawn-parent" }
  );
  await harness.emit(
    "after_tool_call",
    {
      toolName: "sessions_spawn",
      toolCallId: "spawn-parent",
      params: { agentId: "builder", label: "bug-fix", task: "Fix the bug" },
      result: { status: "accepted", childSessionKey: "agent:builder:subagent:42", runId: "run-child-linked" }
    },
    { agentId: "dispatcher", runId: "run-parent", sessionKey: "agent:dispatcher:main", toolName: "sessions_spawn", toolCallId: "spawn-parent" }
  );

  await harness.emit(
    "before_prompt_build",
    { prompt: "Continue item 2 and report progress" },
    { agentId: "builder", runId: "run-child-linked", sessionKey: "agent:builder:subagent:42" }
  );
  await harness.emit(
    "before_tool_call",
    { toolName: "exec", params: { cmd: "rg --files /workspace/builder" } },
    { agentId: "builder", runId: "run-child-linked", sessionKey: "agent:builder:subagent:42" }
  );
  await harness.emit(
    "before_tool_call",
    { toolName: "message", params: { text: "Item 2 is complete and item 3 is now in progress." } },
    { agentId: "builder", runId: "run-child-linked", sessionKey: "agent:builder:subagent:42" }
  );

  await harness.emit("agent_end", {}, { agentId: "builder", runId: "run-child-linked" });
  await harness.emit("agent_end", {}, { agentId: "dispatcher", runId: "run-parent" });

  const snapshot = JSON.parse(await readFile(harness.dashboardStatusPath, "utf8"));
  const parent = snapshot.recentRuns.find((entry) => entry.runId === "run-parent");
  assert.ok(parent);
  assert.ok(Array.isArray(parent.childTasks));
  assert.match(parent.childTasks[0].progressSummary, /Item 2 is complete/i);
  assert.equal(parent.childTasks[0].phase, "completed");
  assert.equal(parent.lastExternalMessage, "");
});

test("assignment report is allowed after sessions_spawn taskflow linkage exists", async () => {
  const harness = await createHarness({ enabledAgents: ["dispatcher", "builder"] });
  await harness.emit(
    "before_prompt_build",
    { prompt: "请继续完成 repo 里的 bug 修复和测试" },
    { agentId: "dispatcher", runId: "run-delegation-allow", sessionKey: "agent:dispatcher:main" }
  );
  await harness.emit(
    "before_tool_call",
    { toolName: "sessions_spawn", toolCallId: "spawn-2", params: { agentId: "builder", label: "bug-fix", task: "修复 bug" } },
    { agentId: "dispatcher", runId: "run-delegation-allow", sessionKey: "agent:dispatcher:main", toolName: "sessions_spawn", toolCallId: "spawn-2" }
  );
  await harness.emit(
    "after_tool_call",
    {
      toolName: "sessions_spawn",
      toolCallId: "spawn-2",
      params: { agentId: "builder", label: "bug-fix", task: "修复 bug" },
      result: { status: "accepted", childSessionKey: "agent:builder:subagent:2", runId: "run-child-2" }
    },
    { agentId: "dispatcher", runId: "run-delegation-allow", sessionKey: "agent:dispatcher:main", toolName: "sessions_spawn", toolCallId: "spawn-2" }
  );

  const result = await harness.emit(
    "before_tool_call",
    { toolName: "message", params: { text: "已分派给 builder 开始修复。" } },
    { agentId: "dispatcher", runId: "run-delegation-allow", sessionKey: "agent:dispatcher:main", toolName: "message" }
  );
  assert.equal(result, undefined);
});

test("workspace discovery unblocks later user escalation", async () => {
  const harness = await createHarness({ enabledAgents: ["builder"] });
  await harness.emit(
    "before_prompt_build",
    { prompt: "修复项目里的 bug 并交付" },
    { agentId: "builder", runId: "run-message-allow" }
  );
  await harness.emit(
    "before_tool_call",
    { toolName: "exec", params: { cmd: "rg --files /workspace/builder" } },
    { agentId: "builder", runId: "run-message-allow" }
  );
  const result = await harness.emit(
    "before_tool_call",
    { toolName: "message", params: { text: "请直接发 repo path 给我" } },
    { agentId: "builder", runId: "run-message-allow" }
  );
  assert.equal(result, undefined);
});

test("taskflow run without visible update ends as waiting instead of completed", async () => {
  const harness = await createHarness({ enabledAgents: ["dispatcher"] });
  await harness.emit(
    "before_prompt_build",
    { prompt: "看一下当前有哪些任务" },
    { agentId: "dispatcher", runId: "run-waiting", sessionKey: "agent:dispatcher:main" }
  );
  await harness.emit(
    "before_tool_call",
    { toolName: "sessions_list", params: { limit: 5 } },
    { agentId: "dispatcher", runId: "run-waiting", sessionKey: "agent:dispatcher:main" }
  );
  await harness.emit("agent_end", {}, { agentId: "dispatcher", runId: "run-waiting", sessionKey: "agent:dispatcher:main" });

  const snapshot = JSON.parse(await readFile(harness.dashboardStatusPath, "utf8"));
  const run = snapshot.recentRuns.find((entry) => entry.runId === "run-waiting");
  assert.ok(run);
  assert.equal(run.flowStatus, "waiting");
  assert.equal(run.status, "waiting");
});

test("before_agent_reply blocks premature silent completion after acknowledgement-only progress", async () => {
  const harness = await createHarness({ enabledAgents: ["builder"] });
  await harness.emit(
    "before_prompt_build",
    { prompt: "修复项目里的 bug 并交付" },
    { agentId: "builder", runId: "run-silent-block" }
  );
  await harness.emit(
    "before_tool_call",
    { toolName: "message", params: { text: "已接单，先开始定位。" } },
    { agentId: "builder", runId: "run-silent-block" }
  );
  const result = await harness.emit(
    "before_agent_reply",
    { cleanedBody: "NO_REPLY" },
    { agentId: "builder", runId: "run-silent-block" }
  );
  assert.equal(result.handled, true);
  assert.match(result.reply.text, /will not end silently/i);
});

test("before_message_write rewrites silent NO_REPLY assistant text when no internal action happened", async () => {
  const harness = await createHarness({ enabledAgents: ["builder"] });
  await harness.emit(
    "before_prompt_build",
    { prompt: "修复项目里的 bug 并交付" },
    { agentId: "builder", runId: "run-silent-rewrite" }
  );
  await harness.emit(
    "before_tool_call",
    { toolName: "message", params: { text: "已接单，正在处理。" } },
    { agentId: "builder", runId: "run-silent-rewrite" }
  );
  const result = await harness.emit(
    "before_message_write",
    { message: { role: "assistant", content: [{ type: "text", text: "NO_REPLY" }] } },
    { agentId: "builder" }
  );
  assert.match(result.message.content[0].text, /still in internal progress/i);
});

test("before_message_write captures visible assistant reply for timeline and completion", async () => {
  const harness = await createHarness({ enabledAgents: ["dispatcher"] });
  await harness.emit(
    "before_prompt_build",
    { prompt: "Review the current assignments across the team" },
    { agentId: "dispatcher", runId: "run-visible-reply", sessionKey: "agent:dispatcher:main" }
  );
  await harness.emit(
    "before_tool_call",
    { toolName: "sessions_list", params: { limit: 5 } },
    { agentId: "dispatcher", runId: "run-visible-reply", sessionKey: "agent:dispatcher:main" }
  );
  harness.emit(
    "before_message_write",
    { message: { role: "assistant", content: [{ type: "text", text: "The review is complete. Here is the current assignment summary." }] } },
    { agentId: "dispatcher", runId: "run-visible-reply", sessionKey: "agent:dispatcher:main" }
  );
  await harness.emit(
    "agent_end",
    {},
    { agentId: "dispatcher", runId: "run-visible-reply", sessionKey: "agent:dispatcher:main" }
  );

  const snapshot = JSON.parse(await readFile(harness.dashboardStatusPath, "utf8"));
  const run = snapshot.recentRuns.find((entry) => entry.runId === "run-visible-reply");
  assert.ok(run);
  assert.equal(run.status, "completed");
  assert.equal(run.lastExternalMessage, "The review is complete. Here is the current assignment summary.");
  assert.deepEqual(
    run.timelineEvents.map((entry) => entry.role),
    ["用户发起", "内部查询", "最终回复"]
  );
});

test("internal relay runs do not surface as formal dashboard tasks", async () => {
  const harness = await createHarness({ enabledAgents: ["dispatcher"] });
  await harness.emit(
    "before_prompt_build",
    { prompt: "[Sat 2026-04-18 18:23 GMT+8] Agent-to-agent announce step." },
    { agentId: "dispatcher", runId: "run-relay", sessionKey: "agent:dispatcher:main" }
  );
  harness.emit(
    "before_message_write",
    { message: { role: "assistant", content: [{ type: "text", text: "ANNOUNCE_SKIP" }] } },
    { agentId: "dispatcher", runId: "run-relay", sessionKey: "agent:dispatcher:main" }
  );
  await harness.emit(
    "agent_end",
    {},
    { agentId: "dispatcher", runId: "run-relay", sessionKey: "agent:dispatcher:main" }
  );

  const snapshot = JSON.parse(await readFile(harness.dashboardStatusPath, "utf8"));
  assert.equal(snapshot.recentRuns.some((entry) => entry.runId === "run-relay"), false);
});

test("parent flow stays waiting while child tasks remain active", async () => {
  const harness = await createHarness({ enabledAgents: ["dispatcher", "builder"] });
  await harness.emit(
    "before_prompt_build",
    { prompt: "Review the current assignments across the team" },
    { agentId: "dispatcher", runId: "run-parent", sessionKey: "agent:dispatcher:main" }
  );
  await harness.emit(
    "before_tool_call",
    {
      toolName: "sessions_send",
      toolCallId: "call-parent",
      params: { sessionKey: "agent:builder:feishu:direct:user_x", message: "继续处理" }
    },
    { agentId: "dispatcher", runId: "run-parent", sessionKey: "agent:dispatcher:main" }
  );
  await harness.emit(
    "after_tool_call",
    {
      toolName: "sessions_send",
      toolCallId: "call-parent",
      params: { sessionKey: "agent:builder:feishu:direct:user_x", message: "继续处理" },
      result: { details: { status: "ok", sessionKey: "agent:builder:feishu:direct:user_x", runId: "child-run-1" } }
    },
    { agentId: "dispatcher", runId: "run-parent", sessionKey: "agent:dispatcher:main" }
  );
  harness.emit(
    "before_message_write",
    { message: { role: "assistant", content: [{ type: "text", text: "先给你一版当前进展。" }] } },
    { agentId: "dispatcher", runId: "run-parent", sessionKey: "agent:dispatcher:main" }
  );
  await harness.emit(
    "agent_end",
    {},
    { agentId: "dispatcher", runId: "run-parent", sessionKey: "agent:dispatcher:main" }
  );

  const snapshot = JSON.parse(await readFile(harness.dashboardStatusPath, "utf8"));
  const run = snapshot.recentRuns.find((entry) => entry.runId === "run-parent");
  assert.ok(run);
  assert.equal(run.flowStatus, "waiting");
  assert.equal(run.status, "waiting");
});

test("parent flow stays waiting when final delivery is sent but child task state is still open", async () => {
  const harness = await createHarness({ enabledAgents: ["dispatcher", "builder"] });
  await harness.emit(
    "before_prompt_build",
    { prompt: "Ask builder for tomorrow's plan and summarize it" },
    { agentId: "dispatcher", runId: "run-parent-finish", sessionKey: "agent:dispatcher:main" }
  );
  await harness.emit(
    "before_tool_call",
    {
      toolName: "sessions_send",
      toolCallId: "call-parent-finish",
      params: { sessionKey: "agent:builder:feishu:direct:user_x", message: "Please share tomorrow's plan" }
    },
    { agentId: "dispatcher", runId: "run-parent-finish", sessionKey: "agent:dispatcher:main" }
  );
  await harness.emit(
    "after_tool_call",
    {
      toolName: "sessions_send",
      toolCallId: "call-parent-finish",
      params: { sessionKey: "agent:builder:feishu:direct:user_x", message: "Please share tomorrow's plan" },
      result: { details: { status: "ok", sessionKey: "agent:builder:feishu:direct:user_x", runId: "child-run-finish" } }
    },
    { agentId: "dispatcher", runId: "run-parent-finish", sessionKey: "agent:dispatcher:main" }
  );
  harness.emit(
    "before_message_write",
    { message: { role: "assistant", content: [{ type: "text", text: "Done. Here is the team's plan for tomorrow." }] } },
    { agentId: "dispatcher", runId: "run-parent-finish", sessionKey: "agent:dispatcher:main" }
  );
  await harness.emit(
    "agent_end",
    {},
    { agentId: "dispatcher", runId: "run-parent-finish", sessionKey: "agent:dispatcher:main" }
  );

  const snapshot = JSON.parse(await readFile(harness.dashboardStatusPath, "utf8"));
  const run = snapshot.recentRuns.find((entry) => entry.runId === "run-parent-finish");
  assert.ok(run);
  assert.equal(run.flowStatus, "waiting");
  assert.equal(run.status, "waiting");
});

test("blocked child outcome keeps parent flow blocked instead of resuming running", async () => {
  const harness = await createHarness({ enabledAgents: ["dispatcher", "builder"] });
  await harness.emit(
    "before_prompt_build",
    { prompt: "让 builder 修一下构建失败并继续推进" },
    { agentId: "dispatcher", runId: "run-parent-blocked", sessionKey: "agent:dispatcher:main" }
  );
  await harness.emit(
    "before_tool_call",
    { toolName: "sessions_spawn", toolCallId: "spawn-blocked", params: { agentId: "builder", label: "fix-build", task: "修复构建失败" } },
    { agentId: "dispatcher", runId: "run-parent-blocked", sessionKey: "agent:dispatcher:main", toolName: "sessions_spawn", toolCallId: "spawn-blocked" }
  );
  await harness.emit(
    "after_tool_call",
    {
      toolName: "sessions_spawn",
      toolCallId: "spawn-blocked",
      params: { agentId: "builder", label: "fix-build", task: "修复构建失败" },
      result: { status: "accepted", childSessionKey: "agent:builder:subagent:43", runId: "run-child-blocked" }
    },
    { agentId: "dispatcher", runId: "run-parent-blocked", sessionKey: "agent:dispatcher:main", toolName: "sessions_spawn", toolCallId: "spawn-blocked" }
  );

  await harness.emit(
    "before_prompt_build",
    { prompt: "继续修复构建失败" },
    { agentId: "builder", runId: "run-child-blocked", sessionKey: "agent:builder:subagent:43" }
  );
  await harness.emit(
    "before_tool_call",
    { toolName: "message", params: { text: "需要 repo 路径和启动方式，否则没法继续定位。" } },
    { agentId: "builder", runId: "run-child-blocked", sessionKey: "agent:builder:subagent:43" }
  );
  await harness.emit("agent_end", {}, { agentId: "builder", runId: "run-child-blocked", sessionKey: "agent:builder:subagent:43" });

  const snapshot = JSON.parse(await readFile(harness.dashboardStatusPath, "utf8"));
  const parentActive = snapshot.activeRuns.find((entry) => entry.runId === "run-parent-blocked");
  assert.ok(parentActive);
  assert.equal(parentActive.flowStatus, "blocked");
  assert.equal(parentActive.status, "blocked");
  assert.equal(parentActive.childTasks[0].phase, "blocked");
  assert.match(parentActive.lastBlockReason, /external message before internal action/);
  assert.equal(parentActive.lastExternalMessage, "");
});

test("parent flow stays waiting when final reply is asking user for missing inputs", async () => {
  const harness = await createHarness({ enabledAgents: ["dispatcher", "builder"] });
  await harness.emit(
    "before_prompt_build",
    { prompt: "安排体验并汇总缺陷" },
    { agentId: "dispatcher", runId: "run-parent-awaiting-input", sessionKey: "agent:dispatcher:main" }
  );
  await harness.emit(
    "before_tool_call",
    {
      toolName: "sessions_send",
      toolCallId: "call-parent-awaiting-input",
      params: { sessionKey: "agent:builder:feishu:direct:user_x", message: "请体验当前版本" }
    },
    { agentId: "dispatcher", runId: "run-parent-awaiting-input", sessionKey: "agent:dispatcher:main" }
  );
  await harness.emit(
    "after_tool_call",
    {
      toolName: "sessions_send",
      toolCallId: "call-parent-awaiting-input",
      params: { sessionKey: "agent:builder:feishu:direct:user_x", message: "请体验当前版本" },
      result: { details: { status: "ok", sessionKey: "agent:builder:feishu:direct:user_x", runId: "child-run-awaiting-input" } }
    },
    { agentId: "dispatcher", runId: "run-parent-awaiting-input", sessionKey: "agent:dispatcher:main" }
  );
  harness.emit(
    "before_message_write",
    {
      message: {
        role: "assistant",
        content: [{ type: "text", text: "请提供测试地址和启动方式，我就能继续推进全员体验。" }]
      }
    },
    { agentId: "dispatcher", runId: "run-parent-awaiting-input", sessionKey: "agent:dispatcher:main" }
  );
  await harness.emit(
    "agent_end",
    {},
    { agentId: "dispatcher", runId: "run-parent-awaiting-input", sessionKey: "agent:dispatcher:main" }
  );

  const snapshot = JSON.parse(await readFile(harness.dashboardStatusPath, "utf8"));
  const run = snapshot.recentRuns.find((entry) => entry.runId === "run-parent-awaiting-input");
  assert.ok(run);
  assert.equal(run.flowStatus, "waiting");
  assert.equal(run.status, "waiting");
});

test("sessions_send inline reply is recorded in parent timeline and child task summary", async () => {
  const harness = await createHarness({ enabledAgents: ["dispatcher", "builder"] });
  await harness.emit(
    "before_prompt_build",
    { prompt: "Ask builder for tomorrow's plan" },
    { agentId: "dispatcher", runId: "run-inline-reply", sessionKey: "agent:dispatcher:main" }
  );
  await harness.emit(
    "before_tool_call",
    {
      toolName: "sessions_send",
      toolCallId: "call-inline",
      params: { sessionKey: "agent:builder:feishu:direct:user_x", message: "Please share tomorrow's plan" }
    },
    { agentId: "dispatcher", runId: "run-inline-reply", sessionKey: "agent:dispatcher:main" }
  );
  await harness.emit(
    "after_tool_call",
    {
      toolName: "sessions_send",
      toolCallId: "call-inline",
      result: {
        details: {
          runId: "child-run-inline",
          status: "ok",
          reply: "Tomorrow's goal: finish the fix and run self-checks.",
          sessionKey: "agent:builder:feishu:direct:user_x"
        }
      }
    },
    { agentId: "dispatcher", runId: "run-inline-reply", sessionKey: "agent:dispatcher:main" }
  );
  await harness.emit(
    "agent_end",
    {},
    { agentId: "dispatcher", runId: "run-inline-reply", sessionKey: "agent:dispatcher:main" }
  );

  const snapshot = JSON.parse(await readFile(harness.dashboardStatusPath, "utf8"));
  const run = snapshot.recentRuns.find((entry) => entry.runId === "run-inline-reply");
  assert.ok(run);
  assert.ok(run.timelineEvents.some((entry) => entry.role === "协同反馈" && entry.text === "Tomorrow's goal: finish the fix and run self-checks."));
});
