import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { canTreatWaitingRunAsCompleted, createDashboardStore } from "../lib/dashboard-store.js";
import { buildTaskChain } from "../dashboard/app-task-core.js";

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

test("task chain includes coordinator final reply and user delivery nodes", () => {
  const chain = buildTaskChain(
    {
      runId: "run-1",
      agentId: "main",
      promptText: "修一下构建",
      lastExternalMessage: "已交付，结果如下。",
      status: "completed",
      childTasks: [
        { agentId: "coder", phase: "delivered", updatedAt: "2026-04-22T02:10:00.000Z" }
      ],
      timelineEvents: [
        { role: "最终回复", text: "已交付，结果如下。" }
      ]
    },
    {
      agentRoster: [
        { agentId: "main", displayName: "招钳" },
        { agentId: "coder", displayName: "码钳" }
      ],
      recentDispatches: []
    }
  );

  assert.deepEqual(
    chain.map((node) => ({ title: node.title, note: node.note })),
    [
      { title: "用户问句", note: "修一下构建" },
      { title: "招钳", note: "Coordinator" },
      { title: "码钳", note: "Child Task: delivered" },
      { title: "招钳", note: "最终汇总" },
      { title: "回复用户", note: "已交付" }
    ]
  );
});
