#!/usr/bin/env node

import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";

import { createDashboardStore } from "../lib/dashboard-store.js";
import { normalizeString } from "../lib/orchestrator-helpers.js";

function parseArgs(argv) {
  const options = {
    tasksDb: "/root/.openclaw/tasks/runs.sqlite",
    flowsDb: "/root/.openclaw/flows/registry.sqlite",
    dashboardStatusPath: "/root/.openclaw/extensions/mission-deck/dashboard/status.json",
    dashboardDataDir: "/root/.openclaw/extensions/mission-deck/dashboard/data",
    openclawConfigPath: "/root/.openclaw/openclaw.json",
    flowId: "",
    write: false
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--tasks-db") options.tasksDb = argv[index + 1] || options.tasksDb;
    if (arg === "--flows-db") options.flowsDb = argv[index + 1] || options.flowsDb;
    if (arg === "--dashboard-status") options.dashboardStatusPath = argv[index + 1] || options.dashboardStatusPath;
    if (arg === "--dashboard-data") options.dashboardDataDir = argv[index + 1] || options.dashboardDataDir;
    if (arg === "--openclaw-config") options.openclawConfigPath = argv[index + 1] || options.openclawConfigPath;
    if (arg === "--flow-id") options.flowId = argv[index + 1] || "";
    if (arg === "--write") options.write = true;
    if (arg === "--help") options.help = true;
  }
  return options;
}

function sqlQuote(value) {
  return `'${String(value ?? "").replaceAll("'", "''")}'`;
}

function queryJsonRows(dbPath, sql) {
  const db = new DatabaseSync(dbPath, { readonly: true });
  try {
    const rows = db.prepare(sql).all();
    return rows
      .map((row) => Object.values(row)[0])
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  } finally {
    db.close();
  }
}

function queryRows(dbPath, sql, params = []) {
  const db = new DatabaseSync(dbPath, { readonly: true });
  try {
    return db.prepare(sql).all(...params);
  } finally {
    db.close();
  }
}

function derivePhase(row) {
  const deliveryStatus = String(row.delivery_status || "").toLowerCase();
  const status = String(row.status || "").toLowerCase();
  if (deliveryStatus === "delivered") return "delivered";
  if (["blocked", "failed", "timed_out", "timeout", "cancelled"].includes(status)) return status;
  if (["succeeded", "success", "completed", "done"].includes(status)) return "completed";
  return status || "running";
}

function isTerminalPhase(phase) {
  return ["reported", "succeeded", "success", "completed", "done", "delivered", "failed", "blocked", "cancelled", "timed_out", "timeout"].includes(String(phase || "").toLowerCase());
}

function isFailurePhase(phase) {
  return ["failed", "blocked", "cancelled", "timed_out", "timeout"].includes(String(phase || "").toLowerCase());
}

function stripPromptMetadata(value) {
  return String(value || "")
    .replace(/Conversation info \(untrusted metadata\):\s*```json[\s\S]*?```/gi, "")
    .replace(/Sender \(untrusted metadata\):\s*```json[\s\S]*?```/gi, "")
    .replace(/Recipient \(untrusted metadata\):\s*```json[\s\S]*?```/gi, "")
    .replace(/System \(untrusted\):[\s\S]*$/gi, "")
    .replace(/Current time:[^\n]*\n?/gi, "")
    .replace(/```[\s\S]*?```/g, "")
    .trim();
}

function looksLikeAsyncContinuation(value) {
  const text = String(value || "").trim().toLowerCase();
  return text.includes("system (untrusted):") || /^system-untrusted-.*-exec-$/.test(text);
}

function deriveInitialUserPrompt(flowRow, currentState) {
  const existing = normalizeString(currentState?.initialUserPrompt);
  if (existing) return existing;
  const goal = normalizeString(flowRow?.goal);
  const stripped = stripPromptMetadata(goal);
  return looksLikeAsyncContinuation(goal) ? "" : stripped;
}

function summarizeChildOutcome(task) {
  const agentId = normalizeString(task?.agentId) || "teammate";
  const summary = normalizeString(task?.progressSummary);
  return summary ? `${agentId}: ${summary}` : `${agentId}: 已完成。`;
}

function buildRepairDeliveryText(childTasks) {
  const completed = childTasks.filter((task) => ["completed", "succeeded", "success", "done", "reported", "delivered"].includes(String(task?.phase || "").toLowerCase()));
  const blocked = childTasks.filter((task) => isFailurePhase(task?.phase));
  if (completed.length === 0 && blocked.length === 0) return "";
  const lines = ["已完成，汇总如下。", ""];
  for (const task of completed) lines.push(summarizeChildOutcome(task));
  if (blocked.length > 0) {
    lines.push("", "未完成部分：");
    for (const task of blocked) lines.push(summarizeChildOutcome(task));
  }
  return lines.join("\n").trim();
}

function isInternalOnlyCompletionText(value) {
  const text = String(value || "").trim().toLowerCase();
  if (!text) return false;
  return text.includes("handled internally") ||
    text.includes("handle the result internally") ||
    text.includes("no further action needed from this subtask") ||
    text.includes("no blocker surfaced from the result");
}

function buildCanonicalChildTasks(rows) {
  const merged = new Map();
  for (const row of rows) {
    const key = String(row.task_id || row.child_session_key || row.run_id || "");
    if (!key) continue;
    const phase = derivePhase(row);
    const existing = merged.get(key) || {};
    const existingTerminal = isTerminalPhase(existing.phase);
    const nextTerminal = isTerminalPhase(phase);
    const preferExistingTerminal = existingTerminal && !nextTerminal;
    merged.set(key, {
      ...existing,
      taskId: row.task_id || existing.taskId || "",
      childRunId: row.run_id || existing.childRunId || "",
      childSessionKey: row.child_session_key || existing.childSessionKey || "",
      agentId: row.agent_id || existing.agentId || "",
      label: row.label || existing.label || "",
      phase: preferExistingTerminal ? existing.phase : phase,
      progressSummary: preferExistingTerminal
        ? (existing.progressSummary || row.progress_summary || row.terminal_summary || "")
        : (row.terminal_summary || row.progress_summary || existing.progressSummary || ""),
      updatedAt: new Date(Number(row.last_event_at || row.ended_at || row.started_at || row.created_at || Date.now())).toISOString()
    });
  }
  return Array.from(merged.values());
}

function countEvidence(childTasks) {
  const keys = new Set();
  for (const task of childTasks) {
    if (!isTerminalPhase(task.phase)) continue;
    if (task.taskId) keys.add(`task:${task.taskId}`);
    else if (task.childSessionKey) keys.add(`session:${task.childSessionKey}`);
    else if (task.agentId) keys.add(`agent:${task.agentId}`);
  }
  return keys.size;
}

function buildFlowRepair(flowRow, taskRows) {
  const currentState = flowRow.state_json ? JSON.parse(flowRow.state_json) : {};
  if (currentState.hiddenInDashboard) return null;
  const childTasks = buildCanonicalChildTasks(taskRows);
  const openCount = childTasks.filter((task) => !isTerminalPhase(task.phase)).length;
  const failureCount = childTasks.filter((task) => isFailurePhase(task.phase)).length;
  const currentStep = String(flowRow.current_step || currentState.state || "");
  const hasFinalOutput = Boolean(currentState.finalOutput?.text);
  const initialUserPrompt = deriveInitialUserPrompt(flowRow, currentState);
  const systemContinuation = !initialUserPrompt && looksLikeAsyncContinuation(flowRow.goal);
  const repairDeliveryText = buildRepairDeliveryText(childTasks);
  const hiddenSystemContinuation = systemContinuation &&
    openCount === 0 &&
    failureCount === 0 &&
    !normalizeString(currentState.lastFailureReason) &&
    (!repairDeliveryText || isInternalOnlyCompletionText(repairDeliveryText));
  const preserveCompleted = currentStep === "completed" || String(flowRow.status || "").toLowerCase() === "succeeded";
  let nextStep = "reviewing";
  if (preserveCompleted) nextStep = "completed";
  else if (openCount > 0) nextStep = "waiting_child";
  else if (failureCount > 0) nextStep = "blocked";
  else if (systemContinuation) nextStep = "completed";
  else if (hasFinalOutput) nextStep = "completed";
  else if (repairDeliveryText) nextStep = "completed";
  const nextStatus = nextStep === "completed" ? "succeeded" : (nextStep === "blocked" ? "failed" : "waiting");
  const nextStateJson = {
    ...currentState,
    state: nextStep,
    initialUserPrompt,
    hiddenInDashboard: hiddenSystemContinuation,
    childTasks,
    childSessions: childTasks.map((task) => task.childSessionKey).filter(Boolean),
    receivedEvidenceCount: countEvidence(childTasks),
    lastFailureReason: nextStep === "blocked"
      ? normalizeString(currentState.lastFailureReason) || childTasks.find((task) => isFailurePhase(task.phase))?.progressSummary || "child task failed"
      : "",
    finalOutput: nextStep === "completed" && repairDeliveryText
      ? {
          text: repairDeliveryText,
          deliveredAt: new Date().toISOString()
        }
      : (nextStep === "completed" ? currentState.finalOutput || null : currentState.finalOutput || null)
  };
  return {
    flowId: flowRow.flow_id,
    previous: {
      status: flowRow.status,
      currentStep: flowRow.current_step,
      receivedEvidenceCount: Number(currentState.receivedEvidenceCount || 0),
      childTaskCount: Array.isArray(currentState.childTasks) ? currentState.childTasks.length : 0
    },
    next: {
      status: nextStatus,
      currentStep: nextStep,
      receivedEvidenceCount: nextStateJson.receivedEvidenceCount,
      childTaskCount: childTasks.length
    },
    stateJson: nextStateJson
  };
}

function looksLikeGhostSystemFlow(flowRow) {
  const goal = normalizeString(flowRow?.goal).toLowerCase();
  const stateJson = normalizeString(flowRow?.state_json);
  return /^system-untrusted-.*-exec-$/.test(goal) && !stateJson;
}

function buildDuplicateOwnershipMap(duplicates) {
  const map = new Map();
  for (const duplicate of duplicates) {
    const runId = normalizeString(duplicate?.runId);
    const parentFlowIds = Array.isArray(duplicate?.parentFlowIds) ? duplicate.parentFlowIds.map((item) => normalizeString(item)).filter(Boolean) : [];
    if (!runId || parentFlowIds.length < 2) continue;
    map.set(runId, parentFlowIds);
  }
  return map;
}

function inferPrimaryParentFlowId(flowRow, duplicateOwnershipMap, flowRowsById) {
  if (!looksLikeGhostSystemFlow(flowRow)) return "";
  for (const [runId, parentFlowIds] of duplicateOwnershipMap.entries()) {
    if (!parentFlowIds.includes(flowRow.flow_id)) continue;
    const candidates = parentFlowIds
      .filter((flowId) => flowId !== flowRow.flow_id)
      .map((flowId) => flowRowsById.get(flowId))
      .filter(Boolean)
      .sort((a, b) => Number(Boolean(normalizeString(b.state_json))) - Number(Boolean(normalizeString(a.state_json))));
    const chosen = candidates.find((row) => normalizeString(row?.state_json)) || candidates[0];
    if (chosen?.flow_id) return normalizeString(chosen.flow_id);
  }
  return "";
}

function buildGhostFlowRepair(flowRow, parentFlowId) {
  if (!parentFlowId) return null;
  return {
    flowId: flowRow.flow_id,
    kind: "ghost_fragment",
    previous: {
      status: flowRow.status,
      currentStep: flowRow.current_step,
      parentFlowId: "",
      hiddenInDashboard: false
    },
    next: {
      status: flowRow.status || "succeeded",
      currentStep: flowRow.current_step || "ghost_fragment",
      parentFlowId,
      hiddenInDashboard: true
    },
    stateJson: {
      schemaVersion: 1,
      state: "ghost_fragment",
      hiddenInDashboard: true,
      parentFlowId,
      finalOutput: null,
      childTasks: [],
      childSessions: [],
      receivedEvidenceCount: 0,
      auditTrail: [
        {
          timestamp: new Date().toISOString(),
          eventType: "repair",
          summary: `ghost fragment linked to durable parent ${parentFlowId}`
        }
      ]
    }
  };
}

function writeFlowRepair(flowsDb, repair) {
  const now = Date.now();
  const sql = `
    UPDATE flow_runs
    SET status=${sqlQuote(repair.next.status)},
        current_step=${sqlQuote(repair.next.currentStep)},
        state_json=${sqlQuote(JSON.stringify(repair.stateJson))},
        wait_json=${repair.next.currentStep === "waiting_child" ? sqlQuote(JSON.stringify({ kind: "child_progress", summary: "repaired from task ledger" })) : "NULL"},
        updated_at=${now}
    WHERE flow_id=${sqlQuote(repair.flowId)};
  `;
  const db = new DatabaseSync(flowsDb);
  try {
    db.exec(sql);
  } finally {
    db.close();
  }
}

function buildRepairPlan(flowRows, duplicateRunOwnership, tasksDb) {
  const flowRowsById = new Map(flowRows.map((row) => [normalizeString(row.flow_id), row]));
  const duplicateOwnershipMap = buildDuplicateOwnershipMap(duplicateRunOwnership);
  const rootRepairs = flowRows.map((flowRow) => {
    const taskRows = queryJsonRows(tasksDb, `
      SELECT json_object(
        'task_id', task_id,
        'child_session_key', child_session_key,
        'run_id', run_id,
        'agent_id', agent_id,
        'label', label,
        'status', status,
        'delivery_status', delivery_status,
        'progress_summary', progress_summary,
        'terminal_summary', terminal_summary,
        'created_at', created_at,
        'started_at', started_at,
        'ended_at', ended_at,
        'last_event_at', last_event_at
      )
      FROM task_runs
      WHERE parent_flow_id=${sqlQuote(flowRow.flow_id)}
      ORDER BY last_event_at DESC, ended_at DESC, created_at DESC;
    `);
    return buildFlowRepair(flowRow, taskRows);
  }).filter(Boolean).filter((repair) =>
    repair.previous.currentStep !== repair.next.currentStep ||
    repair.previous.status !== repair.next.status ||
    repair.previous.receivedEvidenceCount !== repair.next.receivedEvidenceCount ||
    repair.previous.childTaskCount !== repair.next.childTaskCount
  );

  const ghostRepairs = flowRows
    .map((flowRow) => buildGhostFlowRepair(flowRow, inferPrimaryParentFlowId(flowRow, duplicateOwnershipMap, flowRowsById)))
    .filter(Boolean);

  return {
    rootRepairs,
    ghostRepairs
  };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log("Usage: node scripts/repair-flow-state.js [--tasks-db PATH] [--flows-db PATH] [--dashboard-status PATH] [--dashboard-data PATH] [--openclaw-config PATH] [--flow-id FLOW] [--write]");
    return;
  }

  const duplicateRunOwnership = queryJsonRows(options.tasksDb, `
    SELECT json_object(
      'runId', run_id,
      'parentFlowIds', json_group_array(DISTINCT parent_flow_id),
      'parentCount', count(DISTINCT parent_flow_id)
    )
    FROM task_runs
    WHERE trim(coalesce(run_id, '')) <> '' AND trim(coalesce(parent_flow_id, '')) <> ''
    GROUP BY run_id
    HAVING count(DISTINCT parent_flow_id) > 1;
  `);

  const candidateFlows = queryJsonRows(options.flowsDb, `
    SELECT json_object(
      'flow_id', flow_id,
      'status', status,
      'current_step', current_step,
      'state_json', state_json,
      'goal', goal
    )
    FROM flow_runs
    ${options.flowId ? `WHERE flow_id=${sqlQuote(options.flowId)}` : ""}
    ORDER BY updated_at DESC;
  `);
  const { rootRepairs, ghostRepairs } = buildRepairPlan(candidateFlows, duplicateRunOwnership, options.tasksDb);
  const repairs = [...rootRepairs, ...ghostRepairs];

  if (options.write) {
    for (const repair of repairs) writeFlowRepair(options.flowsDb, repair);
    const dashboard = createDashboardStore({ warn() {} }, {
      statusPath: options.dashboardStatusPath,
      dataDir: options.dashboardDataDir,
      flowRegistryPath: options.flowsDb,
      configuredAgents: loadConfiguredAgents(options.openclawConfigPath)
    });
    await dashboard.flush();
  }

  console.log(JSON.stringify({
    duplicates: duplicateRunOwnership,
    repairs,
    summary: {
      rootRepairs: rootRepairs.length,
      ghostRepairs: ghostRepairs.length
    },
    writeApplied: options.write
  }, null, 2));
}

await main();
  function loadConfiguredAgents(configPath) {
    try {
      const raw = readFileSync(configPath, "utf8");
      const config = JSON.parse(raw);
      return (Array.isArray(config?.agents?.list) ? config.agents.list : []).map((agent, index) => ({
        agentId: normalizeString(agent?.id),
        displayName: normalizeString(agent?.identity?.name) || normalizeString(agent?.id),
        emoji: normalizeString(agent?.identity?.emoji),
        theme: normalizeString(agent?.identity?.theme),
        profile: normalizeString(agent?.tools?.profile),
        allowAgents: Array.isArray(agent?.subagents?.allowAgents) ? agent.subagents.allowAgents : [],
        isDefault: Boolean(agent?.default),
        orderIndex: index
      })).filter((entry) => entry.agentId);
    } catch {
      return [];
    }
  }
