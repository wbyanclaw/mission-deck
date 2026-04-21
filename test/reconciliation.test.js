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
