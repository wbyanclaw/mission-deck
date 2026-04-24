import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";

import { canTreatWaitingRunAsCompleted, createDashboardStore } from "../lib/dashboard-store.js";
import { buildDashboardSnapshot } from "../lib/dashboard-snapshot.js";
import { buildAgentRoster, mergeLiveRuns } from "../lib/dashboard-summary.js";
import { buildGraphModel } from "../dashboard/app-graph-models.js";
import { buildTaskCards, buildTaskChain, buildTaskChainFacts, deriveTaskSummary, getCurrentProgress, getEffectiveStatus, getNextAction } from "../dashboard/app-task-core.js";
import { buildWorkTreeRows } from "../dashboard/app-timeline-models.js";
import { fmtTime } from "../dashboard/app-utils.js";

test("dashboard flush remains stable under concurrent writes", async () => {
  const tempRoot = await mkdtemp(join(tmpdir(), "mission-deck-dashboard-"));
  const statusPath = join(tempRoot, "status.json");
  const dashboard = createDashboardStore(
    { warn() {} },
    {
      statusPath,
      dataDir: join(tempRoot, "data"),
      flowRegistryPath: join(tempRoot, "flows-empty.sqlite"),
      sessionsRoot: join(tempRoot, "sessions")
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
      flowRegistryPath: join(tempRoot, "flows-empty.sqlite"),
      sessionsRoot: join(tempRoot, "sessions")
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

test("dashboard attachChildOutcome ignores duplicate terminal outcomes for the same child task", async () => {
  const tempRoot = await mkdtemp(join(tmpdir(), "mission-deck-dashboard-"));
  const statusPath = join(tempRoot, "status.json");
  const dataDir = join(tempRoot, "data");
  const dashboard = createDashboardStore(
    { warn() {} },
    {
      statusPath,
      dataDir,
      flowRegistryPath: join(tempRoot, "flows-empty.sqlite")
    }
  );

  dashboard.trackActiveRun("run-parent-1", "main", {
    engineeringTask: true,
    entryMode: "mission-flow",
    orchestrationMode: "delegate_once",
    taskFlowSeen: true,
    flowId: "flow-1",
    childTaskIds: ["task-1"],
    childTasks: [
      {
        taskId: "task-1",
        childSessionKey: "agent:coder:subagent:1",
        childRunId: "child-run-1",
        phase: "completed",
        progressSummary: "已收到最新进展"
      }
    ],
    dashboardStartedAt: "2026-04-23T05:54:27.024Z",
    dashboardUpdatedAt: "2026-04-23T05:55:20.375Z"
  });

  await dashboard.attachChildOutcome({
    parentRunId: "run-parent-1",
    childTaskId: "task-1",
    childSessionKey: "agent:coder:subagent:1",
    childRunId: "child-run-2",
    childAgentId: "coder",
    phase: "completed",
    summary: "已收到最新进展",
    updatedAt: "2026-04-23T05:56:12.564Z"
  });
  await dashboard.flush();

  const logPath = join(dataDir, "2026-04-23.jsonl");
  let raw = "";
  try {
    raw = await readFile(logPath, "utf8");
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  assert.equal(raw.includes("\"type\":\"child-outcome\""), false);
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
  const sessionsRoot = join(tempRoot, "sessions");
  await mkdir(join(sessionsRoot, "main", "sessions"), { recursive: true });
  await writeFile(
    join(sessionsRoot, "main", "sessions", "run-flow-1.jsonl"),
    [
      JSON.stringify({
        type: "message",
        timestamp: "2026-04-22T06:59:00.000Z",
        message: {
          role: "user",
          content: [{ type: "text", text: "Conversation info (untrusted metadata):\n```json\n{\"timestamp\":\"Wed 2026-04-22 15:00 GMT+8\"}\n```\n\n修复构建失败" }]
        }
      }),
      JSON.stringify({
        type: "message",
        timestamp: "2026-04-22T07:00:00.000Z",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "我先检查构建链路。" }]
        }
      }),
      JSON.stringify({
        type: "message",
        timestamp: "2026-04-22T07:01:00.000Z",
        message: {
          role: "user",
          content: [{ type: "text", text: "顺便把 lint 也一起看一下" }]
        }
      }),
      JSON.stringify({
        type: "message",
        timestamp: "2026-04-22T07:02:00.000Z",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "已修复，构建恢复正常。" }]
        }
      })
    ].join("\n"),
    "utf8"
  );
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
      sessionsRoot,
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
  assert.equal(snapshot.activeRuns[0].lastExternalMessage, "已修复，构建恢复正常。");
  assert.equal(snapshot.activeRuns[0].timelineEvents.some((item) => item.role === "对外同步" && item.text === "我先检查构建链路。"), true);
  assert.equal(snapshot.activeRuns[0].timelineEvents.some((item) => item.role === "用户追问" && item.text === "顺便把 lint 也一起看一下"), true);
  const mainAgent = snapshot.agentRoster.find((entry) => entry.agentId === "main");
  assert.equal(mainAgent?.state, "busy");
  assert.equal(mainAgent?.activeRuns, 1);
});

test("taskflow rebuild prefers the first visible user text over internal dispatch prompts", async () => {
  const tempRoot = await mkdtemp(join(tmpdir(), "mission-deck-dashboard-"));
  const statusPath = join(tempRoot, "status.json");
  const flowRegistryPath = join(tempRoot, "flows.sqlite");
  const sessionsRoot = join(tempRoot, "sessions");
  await mkdir(join(sessionsRoot, "main", "sessions"), { recursive: true });
  await writeFile(
    join(sessionsRoot, "main", "sessions", "run-flow-internal.jsonl"),
    [
      JSON.stringify({
        type: "message",
        timestamp: "2026-04-22T06:59:00.000Z",
        message: {
          role: "user",
          content: [{ type: "text", text: "Conversation info (untrusted metadata):\n```json\n{\"timestamp\":\"Wed 2026-04-22 15:00 GMT+8\"}\n```\n\n帮我修一下构建失败" }]
        }
      }),
      JSON.stringify({
        type: "message",
        timestamp: "2026-04-22T07:00:00.000Z",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "我先检查构建链路。" }]
        }
      })
    ].join("\n"),
    "utf8"
  );
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
    "flow-internal",
    "agent:main:main",
    1,
    "waiting",
    "none",
    "内部派工",
    "reviewing",
    JSON.stringify({
      entryMode: "mission-flow",
      orchestrationMode: "delegate_once",
      initialUserPrompt: "[peer:redacted]: 已接单，继续处理构建失败",
      rootRunId: "run-flow-internal",
      rootSessionKey: "agent:main:main",
      state: "reviewing"
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
      sessionsRoot
    }
  );
  await dashboard.flush();

  const snapshot = JSON.parse(await readFile(statusPath, "utf8"));
  assert.equal(snapshot.activeRuns[0].promptText, "帮我修一下构建失败");
  assert.equal(snapshot.activeRuns[0].initialUserPrompt, "帮我修一下构建失败");
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
  assert.equal(tasks[0].originSummary, "修一下构建");
});

test("task cards hide internal peer and cron flows without a real user-origin prompt", () => {
  const tasks = buildTaskCards({
    activeRuns: [
      {
        runId: "run-peer",
        agentId: "main",
        flowId: "flow-peer",
        taskFlowSeen: true,
        promptText: "[peer:redacted]: 【记忆规范 · main】",
        updatedAt: "2026-04-23T05:52:00.000Z"
      },
      {
        runId: "run-ack",
        agentId: "main",
        flowId: "flow-ack",
        taskFlowSeen: true,
        promptText: "[Thu 2026-04-23 13:54 GMT+8] 已接单",
        updatedAt: "2026-04-23T05:55:50.427Z"
      },
      {
        runId: "run-cron",
        agentId: "invest",
        flowId: "flow-cron",
        taskFlowSeen: true,
        promptText: "[cron:job-1 daily-brief] 请输出今天的早报",
        updatedAt: "2026-04-23T05:56:00.000Z"
      },
      {
        runId: "run-user",
        agentId: "main",
        flowId: "flow-user",
        taskFlowSeen: true,
        promptText: "帮我修一下构建失败",
        updatedAt: "2026-04-23T05:57:00.000Z"
      }
    ],
    recentRuns: []
  });

  assert.equal(tasks.length, 1);
  assert.equal(tasks[0].flowId, "flow-user");
  assert.equal(tasks[0].promptText, "帮我修一下构建失败");
});

test("task summary strips peer wrapper and keeps the underlying user request", () => {
  const summary = deriveTaskSummary({
    promptText: "[peer:redacted]: 可以，那你帮我设计一下，我发给他们每个人"
  });

  assert.equal(summary, "可以，那你帮我设计一下，我发给他们每个人");
});

test("task summary strips cron wrapper and keeps the actual cron task body", () => {
  const summary = deriveTaskSummary({
    promptText: "[cron:job-1 daily-brief] 请输出今天的早报"
  });

  assert.equal(summary, "请输出今天的早报");
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

test("effective task status treats reviewing runs with block reasons as blocked", () => {
  const [task] = buildTaskCards({
    activeRuns: [
      {
        runId: "run-reviewing-blocked",
        agentId: "main",
        flowId: "flow-1",
        taskFlowSeen: true,
        promptText: "统一 memory 规范",
        status: "reviewing",
        flowCurrentStep: "reviewing",
        lastBlockReason: "This task requires routing first. Follow the orchestration plan before using read.",
        updatedAt: "2026-04-23T03:16:53.265Z"
      }
    ],
    recentRuns: []
  });

  assert.equal(getEffectiveStatus(task), "blocked");
});

test("next action derives concrete closure guidance for blocked visible-reply gaps", () => {
  const task = {
    flowId: "flow-1",
    status: "blocked",
    flowCurrentStep: "blocked",
    lastBlockReason: "agent run ended without sending a visible reply"
  };
  assert.equal(getNextAction(task, { recentBlockers: [] }), "补发最终回复；若不应再回复用户，则明确终止并归档。");
});

test("task facts include derived next action for waiting child flows", () => {
  const [task] = buildTaskCards({
    activeRuns: [
      {
        runId: "run-waiting-child",
        agentId: "main",
        flowId: "flow-waiting-child",
        taskFlowSeen: true,
        promptText: "检查子任务",
        status: "waiting",
        flowCurrentStep: "waiting_child",
        updatedAt: "2026-04-23T07:20:00.000Z"
      }
    ],
    recentRuns: [],
    recentDispatches: [],
    recentBlockers: [],
    agentRoster: []
  });

  const facts = buildTaskChainFacts(task, {
    recentDispatches: [],
    recentBlockers: [],
    agentRoster: []
  });
  const nextAction = facts.find((item) => item.label === "下一步");
  assert.equal(nextAction?.value, "检查子任务回执；若子任务已完成但父链未更新，重放 child outcome 或执行 repair。");
});

test("blocked task facts include blocker owner time and reason", () => {
  const [task] = buildTaskCards({
    activeRuns: [
      {
        runId: "run-blocked",
        agentId: "main",
        flowId: "flow-blocked",
        taskFlowSeen: true,
        promptText: "修一下构建",
        status: "reviewing",
        flowCurrentStep: "reviewing",
        lastBlockReason: "agent run ended without sending a visible reply",
        updatedAt: "2026-04-23T03:16:53.265Z"
      }
    ],
    recentRuns: [],
    recentBlockers: [
      {
        runId: "run-blocked",
        agentId: "coder",
        reason: "子任务已完成，但主控没有补发最终回复",
        timestamp: "2026-04-23T03:16:00.000Z"
      }
    ],
    agentRoster: [
      { agentId: "main", displayName: "招钳" },
      { agentId: "coder", displayName: "码钳" }
    ]
  });

  const facts = buildTaskChainFacts(task, {
    recentDispatches: [],
    recentBlockers: [
      {
        runId: "run-blocked",
        agentId: "coder",
        reason: "子任务已完成，但主控没有补发最终回复",
        timestamp: "2026-04-23T03:16:00.000Z"
      }
    ],
    agentRoster: [
      { agentId: "main", displayName: "招钳" },
      { agentId: "coder", displayName: "码钳" }
    ]
  });

  assert.equal(facts.find((item) => item.label === "阻塞责任")?.value, "码钳");
  assert.equal(facts.find((item) => item.label === "阻塞时间")?.value, "2026-04-23T03:16:00.000Z");
  assert.equal(facts.find((item) => item.label === "阻塞原因")?.value, "子任务已完成，但主控没有补发最终回复");
});

test("worktree rows for blocked tasks keep only the user-facing conversation", () => {
  const rows = buildWorkTreeRows(
    {
      runId: "run-blocked",
      agentId: "main",
      flowId: "flow-blocked",
      promptText: "修一下构建",
      originSummary: "修一下构建",
      status: "blocked",
      flowCurrentStep: "blocked",
      lastBlockReason: "主控没有补发最终回复",
      updatedAt: "2026-04-23T03:16:53.265Z",
      timelineEvents: []
    },
    {
      recentDispatches: [],
      recentBlockers: [],
      agentRoster: [{ agentId: "main", displayName: "招钳" }]
    }
  );

  assert.deepEqual(
    rows.map((item) => ({ role: item.role, text: item.text })),
    [
      { role: "用户发起", text: "修一下构建" }
    ]
  );
});

test("worktree rows only keep user question and visible replies", () => {
  const rows = buildWorkTreeRows(
    {
      runId: "run-visible",
      agentId: "main",
      flowId: "flow-visible",
      promptText: "修一下构建",
      originSummary: "修一下构建",
      updatedAt: "2026-04-23T03:16:53.265Z",
      timelineEvents: [
        { timestamp: "2026-04-23T03:16:00.000Z", role: "TaskFlow", owner: "", text: "flow initialized at planned" },
        { timestamp: "2026-04-23T03:17:00.000Z", role: "安排跟进", owner: "main", text: "已交给 coder 继续处理" },
        { timestamp: "2026-04-23T03:18:00.000Z", role: "最终回复", owner: "main", text: "已经修好了，你可以再试一次。" }
      ],
      lastExternalMessage: "已经修好了，你可以再试一次。"
    },
    {
      recentDispatches: [],
      recentBlockers: [],
      agentRoster: [{ agentId: "main", displayName: "招钳" }]
    }
  );

  assert.deepEqual(
    rows.map((item) => ({ role: item.role, text: item.text })),
    [
      { role: "模型回复", text: "已经修好了，你可以再试一次。" },
      { role: "用户发起", text: "修一下构建" }
    ]
  );
});

test("worktree rows preserve follow-up user turns between visible replies", () => {
  const rows = buildWorkTreeRows(
    {
      runId: "run-visible",
      agentId: "main",
      flowId: "flow-visible",
      promptText: "修一下构建",
      originSummary: "修一下构建",
      updatedAt: "2026-04-23T03:20:00.000Z",
      timelineEvents: [
        { timestamp: "2026-04-23T03:17:00.000Z", role: "对外同步", owner: "main", text: "我先检查构建链路。" },
        { timestamp: "2026-04-23T03:18:00.000Z", role: "用户追问", owner: "用户", text: "顺便把 lint 也一起看一下" },
        { timestamp: "2026-04-23T03:19:00.000Z", role: "对外同步", owner: "main", text: "已经修好了，你可以再试一次。" }
      ],
      lastExternalMessage: "已经修好了，你可以再试一次。"
    },
    {
      recentDispatches: [],
      recentBlockers: [],
      agentRoster: [{ agentId: "main", displayName: "招钳" }]
    }
  );

  assert.deepEqual(
    rows.map((item) => ({ role: item.role, text: item.text })),
    [
      { role: "模型回复", text: "已经修好了，你可以再试一次。" },
      { role: "用户追问", text: "顺便把 lint 也一起看一下" },
      { role: "模型回复", text: "我先检查构建链路。" },
      { role: "用户发起", text: "修一下构建" }
    ]
  );
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

test("dashboard flush does not accumulate duplicate taskflow fragments across repeated rebuilds", async () => {
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
    1,
    "waiting",
    "none",
    "修复 dashboard 重复问题",
    "reviewing",
    JSON.stringify({
      entryMode: "mission-flow",
      orchestrationMode: "solo",
      initialUserPrompt: "修复 dashboard 重复问题",
      rootRunId: "run-flow-1",
      rootSessionKey: "agent:main:main",
      state: "reviewing"
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
      flowRegistryPath
    }
  );

  await dashboard.flush();
  await dashboard.flush();

  const snapshot = JSON.parse(await readFile(statusPath, "utf8"));
  const flowIds = [...snapshot.activeRuns, ...snapshot.recentRuns]
    .map((entry) => entry.flowId)
    .filter(Boolean);
  assert.deepEqual(flowIds, ["flow-1"]);
});

test("dashboard snapshot hides mission-lite child runs from top-level task lists", async () => {
  const tempRoot = await mkdtemp(join(tmpdir(), "mission-deck-dashboard-"));
  const statusPath = join(tempRoot, "status.json");
  const dashboard = createDashboardStore(
    { warn() {} },
    {
      statusPath,
      dataDir: join(tempRoot, "data"),
      flowRegistryPath: join(tempRoot, "flows-empty.sqlite"),
      sessionsRoot: join(tempRoot, "sessions")
    }
  );

  dashboard.trackActiveRun("run-child-1", "coder", {
    engineeringTask: true,
    entryMode: "mission-lite",
    orchestrationMode: "solo",
    parentFlowId: "flow-parent-1",
    parentTaskId: "task-parent-1",
    chainAssessment: {
      code: "solo-correct",
      summary: "这是执行子任务，当前链路应直接执行并回报父任务。",
      missing: "",
      nextAction: "完成本地执行或明确报告阻塞后即可回传父任务。",
      correct: true
    },
    dashboardStartedAt: "2026-04-24T02:32:35.846Z",
    dashboardUpdatedAt: "2026-04-24T02:32:35.846Z"
  });

  await dashboard.flush();

  const snapshot = JSON.parse(await readFile(statusPath, "utf8"));
  assert.equal(snapshot.activeRuns.length, 0);
  assert.equal(snapshot.recentRuns.length, 0);
});

test("dashboard snapshot keeps direct agent sessions in dedicated directSessions list", async () => {
  const tempRoot = await mkdtemp(join(tmpdir(), "mission-deck-dashboard-"));
  const statusPath = join(tempRoot, "status.json");
  const dashboard = createDashboardStore(
    { warn() {} },
    {
      statusPath,
      dataDir: join(tempRoot, "data"),
      flowRegistryPath: join(tempRoot, "flows-empty.sqlite"),
      sessionsRoot: join(tempRoot, "sessions")
    }
  );

  dashboard.trackActiveRun("run-direct-1", "coder", {
    engineeringTask: true,
    entryMode: "mission-lite",
    orchestrationMode: "solo",
    promptText: "给主人产出一个可执行的比赛产品方案",
    normalizedPromptText: "给主人产出一个可执行的比赛产品方案",
    chainAssessment: {
      code: "solo-correct",
      summary: "这是直接对话任务，当前链路应直接执行。",
      missing: "",
      nextAction: "直接完成并回复。",
      correct: true
    },
    dashboardStartedAt: "2026-04-24T03:59:00.000Z",
    dashboardUpdatedAt: "2026-04-24T03:59:00.000Z"
  });

  await dashboard.flush();

  const snapshot = JSON.parse(await readFile(statusPath, "utf8"));
  assert.equal(snapshot.activeRuns.length, 0);
  assert.equal(snapshot.recentRuns.length, 0);
  assert.equal(Array.isArray(snapshot.directSessions), true);
  assert.equal(snapshot.directSessions.length, 1);
  assert.equal(snapshot.directSessions[0].runId, "run-direct-1");
  assert.equal(snapshot.directSessions[0].agentId, "coder");
});

test("dashboard snapshot rebuild keeps both automated and direct sessions with session kinds", async () => {
  const tempRoot = await mkdtemp(join(tmpdir(), "mission-deck-dashboard-"));
  const statusPath = join(tempRoot, "status.json");
  const sessionsRoot = join(tempRoot, "sessions");
  await mkdir(join(sessionsRoot, "main", "sessions"), { recursive: true });

  await writeFile(
    join(sessionsRoot, "main", "sessions", "mixed.jsonl"),
    [
      JSON.stringify({
        type: "message",
        timestamp: "2026-04-24T01:00:00.000Z",
        message: {
          role: "user",
          content: [
            {
              type: "text",
              text: "Read HEARTBEAT.md if it exists (workspace context). Follow it strictly. If nothing needs attention, reply HEARTBEAT_OK."
            }
          ]
        }
      }),
      JSON.stringify({
        type: "message",
        timestamp: "2026-04-24T01:00:30.000Z",
        message: {
          role: "assistant",
          content: [
            {
              type: "text",
              text: "HEARTBEAT_OK"
            }
          ]
        }
      })
    ].join("\n"),
    "utf8"
  );

  await writeFile(
    join(sessionsRoot, "main", "sessions", "direct.jsonl"),
    [
      JSON.stringify({
        type: "message",
        timestamp: "2026-04-24T02:00:00.000Z",
        message: {
          role: "user",
          content: [
            {
              type: "text",
              text: "Conversation info (untrusted metadata):\n```json\n{\"chat_id\":\"user:abc\",\"message_id\":\"msg-1\"}\n```\n\n[Thu 2026-04-24 10:00 GMT+8] 帮我查一下今天的订单进度"
            }
          ]
        }
      }),
      JSON.stringify({
        type: "message",
        timestamp: "2026-04-24T02:00:30.000Z",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "我先帮你核对订单状态。" }]
        }
      })
    ].join("\n"),
    "utf8"
  );

  const dashboard = createDashboardStore(
    { warn() {} },
    {
      statusPath,
      dataDir: join(tempRoot, "data"),
      flowRegistryPath: join(tempRoot, "flows-empty.sqlite"),
      sessionsRoot
    }
  );

  await dashboard.flush();

  const snapshot = JSON.parse(await readFile(statusPath, "utf8"));
  assert.equal(Array.isArray(snapshot.directSessions), true);
  assert.equal(snapshot.directSessions.length, 2);
  assert.equal(snapshot.directSessions[0].runId, "session:direct");
  assert.equal(snapshot.directSessions[0].promptText, "帮我查一下今天的订单进度");
  assert.equal(snapshot.directSessions[0].sessionKind, "direct");
  assert.equal(snapshot.directSessions[0].sessionTitle, "帮我查一下今天的订单进度");
  assert.equal(snapshot.directSessions[1].runId, "session:mixed");
  assert.equal(snapshot.directSessions[1].sessionKind, "heartbeat");
  assert.equal(snapshot.directSessions[1].sessionTitle, "静默心跳检查");
});

test("dashboard direct session rebuild uses the latest substantial user turn as the session title", async () => {
  const tempRoot = await mkdtemp(join(tmpdir(), "mission-deck-dashboard-"));
  const statusPath = join(tempRoot, "status.json");
  const sessionsRoot = join(tempRoot, "sessions");
  await mkdir(join(sessionsRoot, "coder", "sessions"), { recursive: true });

  await writeFile(
    join(sessionsRoot, "coder", "sessions", "thread.jsonl"),
    [
      JSON.stringify({
        type: "message",
        timestamp: "2026-04-24T02:00:00.000Z",
        message: {
          role: "user",
          content: [{ type: "text", text: "hello" }]
        }
      }),
      JSON.stringify({
        type: "message",
        timestamp: "2026-04-24T02:00:05.000Z",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "你好，我在。" }]
        }
      }),
      JSON.stringify({
        type: "message",
        timestamp: "2026-04-24T02:03:00.000Z",
        message: {
          role: "user",
          content: [{ type: "text", text: "按这三条闭环" }]
        }
      })
    ].join("\n"),
    "utf8"
  );

  const dashboard = createDashboardStore(
    { warn() {} },
    {
      statusPath,
      dataDir: join(tempRoot, "data"),
      flowRegistryPath: join(tempRoot, "flows-empty.sqlite"),
      sessionsRoot
    }
  );

  await dashboard.flush();

  const snapshot = JSON.parse(await readFile(statusPath, "utf8"));
  assert.equal(snapshot.directSessions.length, 1);
  assert.equal(snapshot.directSessions[0].runId, "session:thread");
  assert.equal(snapshot.directSessions[0].promptText, "按这三条闭环");
  assert.equal(snapshot.directSessions[0].sessionTitle, "按这三条闭环");
  assert.deepEqual(
    snapshot.directSessions[0].timelineEvents.map((item) => ({ role: item.role, text: item.text })),
    [
      { role: "用户发起", text: "hello" },
      { role: "对外同步", text: "你好，我在。" },
      { role: "用户追问", text: "按这三条闭环" }
    ]
  );
});

test("dashboard direct session rebuild keeps a stable title and drops placeholder assistant replies", async () => {
  const tempRoot = await mkdtemp(join(tmpdir(), "mission-deck-dashboard-"));
  const statusPath = join(tempRoot, "status.json");
  const sessionsRoot = join(tempRoot, "sessions");
  await mkdir(join(sessionsRoot, "coder", "sessions"), { recursive: true });

  await writeFile(
    join(sessionsRoot, "coder", "sessions", "thread.jsonl"),
    [
      JSON.stringify({
        type: "message",
        timestamp: "2026-04-24T02:00:00.000Z",
        message: {
          role: "user",
          content: [{ type: "text", text: "按这三条闭环，把样式和数据一起收好" }]
        }
      }),
      JSON.stringify({
        type: "message",
        timestamp: "2026-04-24T02:00:05.000Z",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "我先看现场。" }]
        }
      }),
      JSON.stringify({
        type: "message",
        timestamp: "2026-04-24T02:03:00.000Z",
        message: {
          role: "user",
          content: [{ type: "text", text: "继续" }]
        }
      }),
      JSON.stringify({
        type: "message",
        timestamp: "2026-04-24T02:03:05.000Z",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "REPLY_SKIP" }]
        }
      })
    ].join("\n"),
    "utf8"
  );

  const dashboard = createDashboardStore(
    { warn() {} },
    {
      statusPath,
      dataDir: join(tempRoot, "data"),
      flowRegistryPath: join(tempRoot, "flows-empty.sqlite"),
      sessionsRoot
    }
  );

  await dashboard.flush();

  const snapshot = JSON.parse(await readFile(statusPath, "utf8"));
  assert.equal(snapshot.directSessions.length, 1);
  assert.equal(snapshot.directSessions[0].sessionTitle, "按这三条闭环，把样式和数据一起收好");
  assert.deepEqual(
    snapshot.directSessions[0].timelineEvents.map((item) => ({ role: item.role, text: item.text })),
    [
      { role: "用户发起", text: "按这三条闭环，把样式和数据一起收好" },
      { role: "对外同步", text: "我先看现场。" },
      { role: "用户追问", text: "继续" }
    ]
  );
});

test("dashboard direct sessions deduplicate rebuilt sessions and runtime direct runs by session key", async () => {
  const rebuilt = {
    runId: "session:abc",
    sessionKey: "agent:coder:session:abc",
    agentId: "coder",
    engineeringTask: true,
    entryMode: "mission-lite",
    promptText: "最新用户问句",
    initialUserPrompt: "最新用户问句",
    updatedAt: "2026-04-24T08:00:00.000Z",
    lastExternalMessage: "收到"
  };
  const directSessions = buildDashboardSnapshot(
    {
      activeRuns: new Map([
        ["run-direct", {
          runId: "run-direct",
          engineeringTask: true,
          entryMode: "mission-lite",
          orchestrationMode: "solo",
          sessionKey: "agent:coder:session:abc",
          agentId: "coder",
          promptText: "旧的 runtime 文本",
          initialUserPrompt: "旧的 runtime 文本",
          updatedAt: "2026-04-24T08:01:00.000Z",
          startedAt: "2026-04-24T07:59:00.000Z",
          lastExternalMessage: ""
        }]
      ]),
      recentRuns: [],
      taskflowActiveRuns: [],
      taskflowRecentRuns: [],
      rebuiltDirectSessions: [rebuilt],
      recentDispatches: [],
      recentBlockers: []
    },
    {
      normalizeHistoricalRunStatus: (entry) => entry,
      configuredAgents: [],
      maxRecentRuns: 20
    }
  ).directSessions;

  assert.equal(directSessions.length, 1);
  assert.equal(directSessions[0].sessionKey, "agent:coder:session:abc");
  assert.equal(directSessions[0].promptText, "最新用户问句");
});

test("dashboard direct session rebuild derives a readable cron session title", async () => {
  const tempRoot = await mkdtemp(join(tmpdir(), "mission-deck-dashboard-"));
  const statusPath = join(tempRoot, "status.json");
  const sessionsRoot = join(tempRoot, "sessions");
  await mkdir(join(sessionsRoot, "invest", "sessions"), { recursive: true });

  await writeFile(
    join(sessionsRoot, "invest", "sessions", "cron.jsonl"),
    JSON.stringify({
      type: "message",
      timestamp: "2026-04-24T00:30:00.000Z",
      message: {
        role: "user",
        content: [{ type: "text", text: "[cron:job-1 invest-daily-market-book-summary] 请执行每日投资方法沉淀任务" }]
      }
    }),
    "utf8"
  );

  const dashboard = createDashboardStore(
    { warn() {} },
    {
      statusPath,
      dataDir: join(tempRoot, "data"),
      flowRegistryPath: join(tempRoot, "flows-empty.sqlite"),
      sessionsRoot
    }
  );
  await dashboard.flush();

  const snapshot = JSON.parse(await readFile(statusPath, "utf8"));
  assert.equal(snapshot.directSessions[0].sessionKind, "cron");
  assert.equal(snapshot.directSessions[0].sessionTitle, "定时任务 · invest-daily-market-book-summary");
});
