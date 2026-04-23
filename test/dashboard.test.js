import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";

import { canTreatWaitingRunAsCompleted, createDashboardStore } from "../lib/dashboard-store.js";
import { buildAgentRoster, mergeLiveRuns } from "../lib/dashboard-summary.js";
import { buildGraphModel } from "../dashboard/app-graph-models.js";
import { buildTaskCards, buildTaskChain, getCurrentProgress } from "../dashboard/app-task-core.js";
import { fmtTime } from "../dashboard/app-utils.js";

test("dashboard flush remains stable under concurrent writes", async () => {
  const tempRoot = await mkdtemp(join(tmpdir(), "mission-deck-dashboard-"));
  const statusPath = join(tempRoot, "status.json");
  const dashboard = createDashboardStore(
    { warn() {} },
    {
      statusPath,
      dataDir: join(tempRoot, "data"),
      flowRegistryPath: join(tempRoot, "flows-empty.sqlite")
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

test("dashboard active flow view deduplicates multiple runIds for the same flowId", async () => {
  const tempRoot = await mkdtemp(join(tmpdir(), "mission-deck-dashboard-"));
  const statusPath = join(tempRoot, "status.json");
  const dashboard = createDashboardStore(
    { warn() {} },
    {
      statusPath,
      dataDir: join(tempRoot, "data"),
      flowRegistryPath: join(tempRoot, "flows-empty.sqlite")
    }
  );
  const baseRun = {
    engineeringTask: true,
    entryMode: "mission-flow",
    orchestrationMode: "delegate_once",
    taskFlowSeen: true,
    flowId: "flow-1",
    childTaskIds: ["task-1"],
    childTasks: [{ taskId: "task-1", phase: "running" }],
    chainAssessment: {
      code: "correct",
      summary: "ok",
      missing: "",
      nextAction: "",
      correct: true
    }
  };
  dashboard.trackActiveRun("run-old", "dispatcher", {
    ...baseRun,
    dashboardStartedAt: "2026-04-22T07:00:00.000Z",
    dashboardUpdatedAt: "2026-04-22T07:00:00.000Z"
  });
  dashboard.trackActiveRun("run-new", "dispatcher", {
    ...baseRun,
    dashboardStartedAt: "2026-04-22T07:01:00.000Z",
    dashboardUpdatedAt: "2026-04-22T07:01:00.000Z"
  });

  await dashboard.flush();
  const snapshot = JSON.parse(await readFile(statusPath, "utf8"));
  assert.equal(snapshot.activeRuns.length, 1);
  assert.equal(snapshot.activeRuns[0].runId, "run-new");
  assert.equal(snapshot.activeRuns[0].flowId, "flow-1");
});

test("dashboard live merge prefers terminal taskflow run over newer reviewing fragment for the same flow", () => {
  const merged = mergeLiveRuns(
    [
      {
        runId: "run-reviewing",
        flowId: "flow-1",
        status: "reviewing",
        flowStatus: "waiting",
        flowCurrentStep: "reviewing",
        updatedAt: "2026-04-22T09:01:00.000Z",
        taskFlowSeen: true
      }
    ],
    [
      {
        runId: "run-completed",
        flowId: "flow-1",
        status: "completed",
        flowStatus: "succeeded",
        flowCurrentStep: "completed",
        updatedAt: "2026-04-22T09:00:00.000Z",
        lastExternalMessage: "已完成，汇总如下。",
        taskFlowSeen: true,
        flowSource: "taskflow"
      }
    ]
  );

  assert.equal(merged.length, 1);
  assert.equal(merged[0].runId, "run-completed");
  assert.equal(merged[0].status, "completed");
});

test("dashboard flush rebuilds taskflow-backed runs from flow registry", async () => {
  const tempRoot = await mkdtemp(join(tmpdir(), "mission-deck-dashboard-"));
  const statusPath = join(tempRoot, "status.json");
  const flowRegistryPath = join(tempRoot, "flows.sqlite");
  const db = new DatabaseSync(flowRegistryPath);
  db.exec(`
    CREATE TABLE flow_runs (
      flow_id TEXT PRIMARY KEY,
      shape TEXT,
      sync_mode TEXT NOT NULL DEFAULT 'managed',
      owner_key TEXT NOT NULL,
      requester_origin_json TEXT,
      controller_id TEXT,
      revision INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL,
      notify_policy TEXT NOT NULL,
      goal TEXT NOT NULL,
      current_step TEXT,
      blocked_task_id TEXT,
      blocked_summary TEXT,
      state_json TEXT,
      wait_json TEXT,
      cancel_requested_at INTEGER,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      ended_at INTEGER
    );
  `);
  db.prepare(`
    INSERT INTO flow_runs (
      flow_id, owner_key, revision, status, notify_policy, goal, current_step, state_json, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    "flow-1",
    "agent:main:main",
    3,
    "waiting",
    "none",
    "修复构建失败",
    "reviewing",
    JSON.stringify({
      entryMode: "mission-flow",
      orchestrationMode: "delegate_once",
      initialUserPrompt: "修复构建失败",
      rootRunId: "run-flow-1",
      rootSessionKey: "agent:main:main",
      state: "reviewing",
      childTasks: [
        {
          taskId: "task-1",
          childSessionKey: "agent:coder:subagent:1",
          childRunId: "child-run-1",
          agentId: "coder",
          phase: "delivered",
          progressSummary: "子任务真实完成"
        }
      ],
      receivedEvidenceCount: 1,
      auditTrail: [
        {
          timestamp: "2026-04-22T07:00:00.000Z",
          eventType: "child_report",
          summary: "child outcome applied: completed"
        }
      ]
    }),
    1776841200000,
    1776841260000
  );
  db.close();

  const dashboard = createDashboardStore(
    { warn() {} },
    {
      statusPath,
      dataDir: join(tempRoot, "data"),
      flowRegistryPath,
      configuredAgents: [
        { agentId: "main", displayName: "招钳", orderIndex: 0 }
      ]
    }
  );
  await dashboard.flush();

  const snapshot = JSON.parse(await readFile(statusPath, "utf8"));
  assert.equal(snapshot.activeRuns.length, 1);
  assert.equal(snapshot.activeRuns[0].flowId, "flow-1");
  assert.equal(snapshot.activeRuns[0].runId, "run-flow-1");
  assert.equal(snapshot.activeRuns[0].promptText, "修复构建失败");
  assert.equal(snapshot.activeRuns[0].initialUserPrompt, "修复构建失败");
  assert.equal(snapshot.activeRuns[0].flowCurrentStep, "reviewing");
  assert.equal(snapshot.activeRuns[0].status, "reviewing");
  assert.equal(snapshot.activeRuns[0].childTasks[0].phase, "delivered");
  const mainAgent = snapshot.agentRoster.find((entry) => entry.agentId === "main");
  assert.equal(mainAgent?.state, "busy");
  assert.equal(mainAgent?.activeRuns, 1);
});

test("task chain includes coordinator final reply and user delivery nodes", () => {
  const chain = buildTaskChain(
    {
      runId: "run-1",
      agentId: "main",
      flowId: "flow-1",
      promptText: "修一下构建",
      lastExternalMessage: "已交付，结果如下。",
      status: "completed",
      flowCurrentStep: "reviewing",
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
      { title: "主控接单", note: "招钳" },
      { title: "子任务反馈", note: "码钳 · 1 已交付" },
      { title: "主控汇总", note: "招钳" },
      { title: "回复用户", note: "已交付" }
    ]
  );
});

test("task cards aggregate multiple run fragments by flow and preserve the user prompt", () => {
  const tasks = buildTaskCards({
    activeRuns: [
      {
        runId: "run-latest",
        agentId: "main",
        flowId: "flow-1",
        taskFlowSeen: true,
        promptText: "System (untrusted): Exec completed",
        status: "reviewing",
        flowCurrentStep: "reviewing",
        startedAt: "2026-04-22T07:00:00.000Z",
        updatedAt: "2026-04-22T07:10:00.000Z",
        childTasks: [
          { taskId: "task-2", agentId: "coder", phase: "delivered", updatedAt: "2026-04-22T07:09:00.000Z", progressSummary: "已完成修复" }
        ],
        timelineEvents: [
          { timestamp: "2026-04-22T07:09:00.000Z", role: "最终回复", owner: "main", text: "已交付" }
        ]
      }
    ],
    recentRuns: [
      {
        runId: "run-earliest",
        agentId: "main",
        flowId: "flow-1",
        taskFlowSeen: true,
        promptText: "Conversation info (untrusted metadata):\n```json\n{\"timestamp\":\"Wed 2026-04-22 15:01 GMT+8\"}\n```\n\n修一下构建",
        status: "waiting",
        flowCurrentStep: "waiting_child",
        startedAt: "2026-04-22T07:00:00.000Z",
        updatedAt: "2026-04-22T07:01:00.000Z",
        childTasks: [
          { taskId: "task-1", agentId: "coder", phase: "running", updatedAt: "2026-04-22T07:01:30.000Z", progressSummary: "处理中" }
        ]
      }
    ]
  });

  assert.equal(tasks.length, 1);
  assert.equal(tasks[0].flowId, "flow-1");
  assert.equal(tasks[0].runId, "run-latest");
  assert.equal(tasks[0].promptText, "Conversation info (untrusted metadata):\n```json\n{\"timestamp\":\"Wed 2026-04-22 15:01 GMT+8\"}\n```\n\n修一下构建");
  assert.equal(tasks[0].userAskedAt, "2026-04-22T07:01:00.000Z");
  assert.deepEqual(tasks[0].flowRunIds, ["run-earliest", "run-latest"]);
  assert.equal(tasks[0].childTasks.length, 2);
});

test("task cards prefer terminal durable flow state over newer reviewing fragments", () => {
  const [task] = buildTaskCards({
    activeRuns: [
      {
        runId: "run-reviewing",
        agentId: "main",
        flowId: "flow-1",
        taskFlowSeen: true,
        promptText: "System (untrusted): Exec completed",
        status: "reviewing",
        flowStatus: "waiting",
        flowCurrentStep: "reviewing",
        updatedAt: "2026-04-22T09:01:00.000Z"
      }
    ],
    recentRuns: [
      {
        runId: "run-completed",
        agentId: "main",
        flowId: "flow-1",
        taskFlowSeen: true,
        flowSource: "taskflow",
        promptText: "验证一下昨天每个人推荐的股票今天哪些涨哪些跌",
        status: "completed",
        flowStatus: "succeeded",
        flowCurrentStep: "completed",
        lastExternalMessage: "已完成，汇总如下。",
        updatedAt: "2026-04-22T09:00:00.000Z"
      }
    ]
  });

  assert.equal(task.runId, "run-completed");
  assert.equal(task.status, "completed");
  assert.equal(task.flowCurrentStep, "completed");
  assert.equal(task.lastExternalMessage, "已完成，汇总如下。");
});

test("completed system flows are hidden instead of inheriting stale waiting signals", () => {
  const tasks = buildTaskCards({
    activeRuns: [
      {
        runId: "run-reviewing",
        agentId: "main",
        flowId: "flow-1",
        taskFlowSeen: true,
        promptText: "System (untrusted): Exec completed",
        status: "waiting",
        flowStatus: "waiting",
        flowCurrentStep: "waiting_child",
        flowWaitSummary: "awaiting child completion",
        chainAssessment: {
          code: "awaiting-evidence",
          summary: "已进入委派链路，但还没有首次真实协同证据。",
          missing: "缺少 child evidence",
          nextAction: "等待或获取子任务回执后再汇总。",
          correct: false
        },
        updatedAt: "2026-04-22T09:01:00.000Z"
      }
    ],
    recentRuns: [
      {
        runId: "run-completed",
        agentId: "main",
        flowId: "flow-1",
        taskFlowSeen: true,
        flowSource: "taskflow",
        promptText: "System (untrusted): Exec completed",
        status: "completed",
        flowStatus: "succeeded",
        flowCurrentStep: "completed",
        updatedAt: "2026-04-22T09:00:00.000Z"
      }
    ]
  });

  assert.equal(tasks.length, 0);
});

test("task chain collects dispatches across resumed runs in the same flow", () => {
  const [task] = buildTaskCards({
    activeRuns: [
      {
        runId: "run-latest",
        agentId: "main",
        flowId: "flow-1",
        taskFlowSeen: true,
        promptText: "System (untrusted): Exec completed",
        status: "reviewing",
        flowCurrentStep: "reviewing",
        updatedAt: "2026-04-22T07:10:00.000Z",
        childTasks: [
          { taskId: "task-1", agentId: "coder", phase: "delivered", updatedAt: "2026-04-22T07:09:00.000Z", progressSummary: "已完成" }
        ]
      }
    ],
    recentRuns: [
      {
        runId: "run-earliest",
        agentId: "main",
        flowId: "flow-1",
        taskFlowSeen: true,
        promptText: "修一下构建",
        status: "waiting",
        flowCurrentStep: "waiting_child",
        updatedAt: "2026-04-22T07:01:00.000Z"
      }
    ],
    recentDispatches: [
      {
        timestamp: "2026-04-22T07:02:00.000Z",
        runId: "run-earliest",
        agentId: "main",
        target: { agentId: "coder", routeType: "spawn" },
        taskflow: { flowId: "flow-1" }
      }
    ],
    agentRoster: [
      { agentId: "main", displayName: "招钳" },
      { agentId: "coder", displayName: "码钳" }
    ]
  });

  const chain = buildTaskChain(task, {
    recentDispatches: [
      {
        timestamp: "2026-04-22T07:02:00.000Z",
        runId: "run-earliest",
        agentId: "main",
        target: { agentId: "coder", routeType: "spawn" },
        taskflow: { flowId: "flow-1" }
      }
    ],
    agentRoster: [
      { agentId: "main", displayName: "招钳" },
      { agentId: "coder", displayName: "码钳" }
    ]
  });

  assert.deepEqual(
    chain.map((node) => ({ title: node.title, note: node.note })),
    [
      { title: "用户问句", note: "修一下构建" },
      { title: "主控接单", note: "招钳" },
      { title: "任务分派", note: "码钳 · 1 次" },
      { title: "子任务反馈", note: "码钳 · 1 已交付" },
      { title: "主控汇总", note: "招钳" }
    ]
  );
});

test("task cards ignore child flows and keep only root flow cards", () => {
  const tasks = buildTaskCards({
    activeRuns: [
      {
        runId: "root-run",
        agentId: "main",
        flowId: "flow-root",
        taskFlowSeen: true,
        promptText: "修一下构建",
        updatedAt: "2026-04-22T07:10:00.000Z"
      },
      {
        runId: "child-run",
        agentId: "coder",
        flowId: "flow-child",
        parentFlowId: "flow-root",
        taskFlowSeen: true,
        promptText: "System (untrusted): Exec completed",
        updatedAt: "2026-04-22T07:11:00.000Z"
      }
    ],
    recentRuns: []
  });

  assert.deepEqual(tasks.map((run) => run.flowId), ["flow-root"]);
});

test("task cards hide ghost standalone taskflow flows backed only by system exec slugs", () => {
  const tasks = buildTaskCards({
    activeRuns: [
      {
        runId: "ghost-run",
        agentId: "main",
        flowId: "ghost-flow",
        taskFlowSeen: true,
        promptText: "system-untrusted-2026-04-22-15-36-40-gmt-8-exec-",
        status: "completed",
        flowCurrentStep: "",
        childTasks: [],
        timelineEvents: [],
        updatedAt: "2026-04-22T07:37:39.141Z"
      },
      {
        runId: "root-run",
        agentId: "main",
        flowId: "flow-root",
        taskFlowSeen: true,
        promptText: "修一下构建",
        updatedAt: "2026-04-22T07:10:00.000Z"
      }
    ],
    recentRuns: []
  });

  assert.deepEqual(tasks.map((run) => run.flowId), ["flow-root"]);
});

test("task cards hide async continuation roots without any user-facing signal", () => {
  const tasks = buildTaskCards({
    activeRuns: [
      {
        runId: "async-root",
        agentId: "main",
        flowId: "flow-async",
        taskFlowSeen: true,
        promptText: "System (untrusted): Exec completed",
        status: "reviewing",
        flowCurrentStep: "reviewing",
        childTasks: [
          { taskId: "task-1", agentId: "coder", phase: "delivered", updatedAt: "2026-04-22T07:09:00.000Z", progressSummary: "已完成" }
        ],
        updatedAt: "2026-04-22T07:10:00.000Z"
      },
      {
        runId: "user-root",
        agentId: "main",
        flowId: "flow-user",
        taskFlowSeen: true,
        promptText: "排查行情mcp查不到数据",
        status: "blocked",
        lastBlockReason: "mcp unavailable",
        updatedAt: "2026-04-22T07:11:00.000Z"
      }
    ],
    recentRuns: []
  });

  assert.deepEqual(tasks.map((run) => run.flowId), ["flow-user"]);
});

test("task cards hide async continuation roots that only contain internal completion summaries", () => {
  const tasks = buildTaskCards({
    activeRuns: [
      {
        runId: "async-root",
        agentId: "main",
        flowId: "flow-async",
        taskFlowSeen: true,
        flowSource: "taskflow",
        promptText: "System (untrusted): Exec completed",
        status: "completed",
        flowStatus: "succeeded",
        flowCurrentStep: "completed",
        lastExternalMessage: "已完成，汇总如下。\n\ncoder: Handled internally. The async exec completed successfully with code 0. No blocker surfaced from the result.",
        childTasks: [
          { taskId: "task-1", agentId: "coder", phase: "delivered", updatedAt: "2026-04-22T07:09:00.000Z", progressSummary: "Handled internally." }
        ],
        updatedAt: "2026-04-22T07:10:00.000Z"
      },
      {
        runId: "user-root",
        agentId: "main",
        flowId: "flow-user",
        taskFlowSeen: true,
        promptText: "排查行情mcp查不到数据",
        status: "blocked",
        lastBlockReason: "mcp unavailable",
        updatedAt: "2026-04-22T07:11:00.000Z"
      }
    ],
    recentRuns: []
  });

  assert.deepEqual(tasks.map((run) => run.flowId), ["flow-user"]);
});

test("task cards sort by asked time before started or updated time", () => {
  const tasks = buildTaskCards({
    activeRuns: [
      {
        runId: "run-older",
        agentId: "main",
        flowId: "flow-older",
        taskFlowSeen: true,
        promptText: "旧任务",
        status: "completed",
        flowCurrentStep: "completed",
        userAskedAt: "2026-04-22T04:33:00.000Z",
        startedAt: "2026-04-22T04:34:00.000Z",
        updatedAt: "2026-04-22T09:00:00.000Z"
      },
      {
        runId: "run-newer",
        agentId: "main",
        flowId: "flow-newer",
        taskFlowSeen: true,
        promptText: "新任务",
        status: "completed",
        flowCurrentStep: "completed",
        userAskedAt: "2026-04-22T09:36:45.000Z",
        startedAt: "2026-04-22T09:37:08.000Z",
        updatedAt: "2026-04-22T09:37:39.000Z"
      }
    ],
    recentRuns: []
  });

  assert.deepEqual(tasks.map((task) => task.flowId), ["flow-newer", "flow-older"]);
});

test("task card sorting ignores invalid asked-time text and falls back to startedAt", () => {
  const tasks = buildTaskCards({
    activeRuns: [
      {
        runId: "run-a",
        agentId: "main",
        flowId: "flow-a",
        taskFlowSeen: true,
        promptText: "任务 A",
        status: "completed",
        flowCurrentStep: "completed",
        userAskedAt: "任务 A",
        startedAt: "2026-04-22T04:34:13.000Z",
        updatedAt: "2026-04-22T08:30:48.000Z"
      },
      {
        runId: "run-b",
        agentId: "main",
        flowId: "flow-b",
        taskFlowSeen: true,
        promptText: "任务 B",
        status: "completed",
        flowCurrentStep: "completed",
        userAskedAt: "2026-04-22T04:33:00.000Z",
        startedAt: "2026-04-22T04:34:00.000Z",
        updatedAt: "2026-04-22T09:00:00.000Z"
      }
    ],
    recentRuns: []
  });

  assert.deepEqual(tasks.map((task) => task.flowId), ["flow-a", "flow-b"]);
});

test("graph model keeps a single org edge per relationship and uses the latest dispatch", () => {
  const now = Date.now();
  const model = buildGraphModel({
    agentRoster: [
      { agentId: "main", displayName: "招钳", isDefault: true, orderIndex: 0, allowAgents: ["coder", "sale"], state: "busy" },
      { agentId: "coder", displayName: "码钳", orderIndex: 1, allowAgents: [], state: "idle" },
      { agentId: "sale", displayName: "销钳", orderIndex: 2, allowAgents: [], state: "busy" }
    ],
    recentDispatches: [
      {
        timestamp: new Date(now - 5 * 60_000).toISOString(),
        agentId: "main",
        target: { agentId: "coder", routeType: "spawn" }
      },
      {
        timestamp: new Date(now - 60_000).toISOString(),
        agentId: "main",
        target: { agentId: "coder", routeType: "send" }
      },
      {
        timestamp: new Date(now - 2 * 60_000).toISOString(),
        agentId: "main",
        target: { agentId: "sale", routeType: "spawn" }
      }
    ]
  });

  assert.equal(model.edges.length, 2);
  assert.deepEqual(
    model.edges.map((edge) => ({
      from: edge.from,
      to: edge.to,
      timestamp: edge.dispatch?.timestamp || null,
      active: edge.active
    })),
    [
      { from: "main", to: "coder", timestamp: new Date(now - 60_000).toISOString(), active: true },
      { from: "main", to: "sale", timestamp: new Date(now - 2 * 60_000).toISOString(), active: true }
    ]
  );
});

test("graph model keeps org edge active for busy child agents without recent dispatch", () => {
  const model = buildGraphModel({
    agentRoster: [
      { agentId: "main", displayName: "招钳", isDefault: true, orderIndex: 0, allowAgents: ["invest"] },
      { agentId: "invest", displayName: "金钳", orderIndex: 1, allowAgents: [], state: "busy" }
    ],
    recentDispatches: [
      {
        timestamp: "2026-04-22T00:00:00.000Z",
        agentId: "main",
        target: { agentId: "invest", routeType: "spawn" }
      }
    ]
  });

  assert.equal(model.edges.length, 1);
  assert.equal(model.edges[0].dispatch, null);
  assert.equal(model.edges[0].active, true);
});

test("agent roster ignores non-taskflow fragments when computing busy state", () => {
  const roster = buildAgentRoster(
    [{ agentId: "coder", displayName: "码钳", orderIndex: 0 }],
    [{ agentId: "coder", activeRuns: 3, delegatedRuns: 0, blockedRuns: 0, childTasks: 0, updatedAt: "2026-04-23T02:44:56.844Z" }],
    [
      {
        runId: "run-fragment-1",
        agentId: "coder",
        flowId: "",
        taskFlowSeen: false,
        status: "coordinating",
        updatedAt: "2026-04-23T02:44:56.844Z"
      },
      {
        runId: "run-fragment-2",
        agentId: "coder",
        flowId: "",
        taskFlowSeen: false,
        status: "triaging",
        updatedAt: "2026-04-23T02:43:54.665Z"
      }
    ],
    [],
    []
  );

  assert.equal(roster[0].state, "idle");
  assert.equal(roster[0].activeRuns, 0);
});

test("agent roster marks busy for visible taskflow execution and recent dispatches", () => {
  const roster = buildAgentRoster(
    [
      { agentId: "main", displayName: "主钳", orderIndex: 0 },
      { agentId: "coder", displayName: "码钳", orderIndex: 1 }
    ],
    [
      { agentId: "main", activeRuns: 1, delegatedRuns: 0, blockedRuns: 0, childTasks: 0, updatedAt: "2026-04-23T02:44:56.844Z" },
      { agentId: "coder", activeRuns: 0, delegatedRuns: 0, blockedRuns: 0, childTasks: 0, updatedAt: "" }
    ],
    [
      {
        runId: "run-flow-1",
        agentId: "main",
        flowId: "flow-1",
        taskFlowSeen: true,
        hiddenInDashboard: false,
        parentFlowId: "",
        status: "reviewing",
        flowStatus: "waiting",
        flowCurrentStep: "reviewing",
        updatedAt: "2026-04-23T02:44:56.844Z"
      }
    ],
    [
      {
        timestamp: new Date(Date.now() - 60_000).toISOString(),
        agentId: "coder",
        target: { agentId: "sale" }
      }
    ],
    []
  );

  const main = roster.find((entry) => entry.agentId === "main");
  const coder = roster.find((entry) => entry.agentId === "coder");
  assert.equal(main?.state, "busy");
  assert.equal(main?.activeRuns, 1);
  assert.equal(coder?.state, "busy");
  assert.equal(coder?.activeRuns, 0);
});

test("fmtTime always renders in Asia/Shanghai", () => {
  assert.equal(fmtTime("2026-04-22T03:44:00.000Z"), "2026-04-22 11:44");
});

test("completed task progress does not regress to processing text", () => {
  const progress = getCurrentProgress(
    {
      status: "completed",
      flowCurrentStep: "completed",
      flowWaitSummary: "",
      childTasks: [],
      lastExternalMessage: ""
    },
    { recentDispatches: [], recentBlockers: [] }
  );

  assert.equal(progress, "已完成交付。");
});
