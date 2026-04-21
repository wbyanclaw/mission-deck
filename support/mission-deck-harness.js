import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import plugin, { __test__ } from "../index.js";

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

async function startMissionFlow(harness, runId, prompt = "修复当前构建失败并交付结果", sessionKey = "agent:dispatcher:main") {
  await harness.emit(
    "before_prompt_build",
    { prompt },
    { agentId: "dispatcher", runId, sessionKey }
  );
}

async function discoverSessions(harness, runId, sessionKey = "agent:dispatcher:main") {
  await harness.emit(
    "before_tool_call",
    { toolName: "sessions_list", params: {} },
    { agentId: "dispatcher", runId, sessionKey }
  );
}

async function spawnChild(harness, { runId, toolCallId, childSessionKey, childRunId, agentId = "builder", label = "fix-build", task = "修复构建失败", sessionKey = "agent:dispatcher:main" }) {
  await harness.emit(
    "before_tool_call",
    {
      toolName: "sessions_spawn",
      toolCallId,
      params: { agentId, label, task }
    },
    { agentId: "dispatcher", runId, sessionKey }
  );
  await harness.emit(
    "after_tool_call",
    {
      toolName: "sessions_spawn",
      toolCallId,
      params: { agentId, label, task },
      result: {
        details: {
          status: "accepted",
          childSessionKey,
          runId: childRunId
        }
      }
    },
    { agentId: "dispatcher", runId, sessionKey }
  );
}

async function endDispatcher(harness, runId, sessionKey = "agent:dispatcher:main") {
  await harness.emit(
    "agent_end",
    {},
    { agentId: "dispatcher", runId, sessionKey }
  );
}

async function completeChild(harness, { childRunId, childSessionKey, text = "已修复构建失败并完成验证。", agentId = "builder" }) {
  await harness.emit(
    "before_prompt_build",
    { prompt: "修复构建失败" },
    { agentId, runId: childRunId, sessionKey: childSessionKey }
  );
  await harness.emit(
    "before_message_write",
    {
      message: {
        role: "assistant",
        content: [{ type: "text", text }]
      }
    },
    { agentId, runId: childRunId, sessionKey: childSessionKey }
  );
  await harness.emit(
    "agent_end",
    {},
    { agentId, runId: childRunId, sessionKey: childSessionKey }
  );
}

export {
  __test__,
  buildConfig,
  completeChild,
  createHarness,
  discoverSessions,
  endDispatcher,
  spawnChild,
  startMissionFlow
};
