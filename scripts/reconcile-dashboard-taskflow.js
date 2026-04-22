#!/usr/bin/env node

import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";

function parseArgs(argv) {
  const options = {
    flowsDb: "/root/.openclaw/flows/registry.sqlite",
    dashboardStatus: "/root/.openclaw/extensions/mission-deck/dashboard/status.json",
    flowId: ""
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--flows-db") options.flowsDb = argv[index + 1] || options.flowsDb;
    if (arg === "--dashboard-status") options.dashboardStatus = argv[index + 1] || options.dashboardStatus;
    if (arg === "--flow-id") options.flowId = argv[index + 1] || "";
    if (arg === "--help") options.help = true;
  }
  return options;
}

function normalizeString(value) {
  return String(value || "").trim();
}

function normalizeFlowStep(value) {
  const step = normalizeString(value).toLowerCase();
  if (!step) return "";
  if (["completed", "blocked", "failed", "cancelled", "ghost_fragment"].includes(step)) return step;
  if (step === "reviewing") return "reviewing";
  if (step === "waiting_child" || step === "awaiting_user_input") return "waiting";
  return step;
}

function normalizeFlowStatus(value) {
  const status = normalizeString(value).toLowerCase();
  if (!status) return "";
  if (["succeeded", "completed"].includes(status)) return "completed";
  if (["failed", "blocked", "cancelled"].includes(status)) return "blocked";
  if (status === "waiting" || status === "running") return "waiting";
  return status;
}

function buildDashboardIndex(statusPath, onlyFlowId = "") {
  const snapshot = JSON.parse(readFileSync(statusPath, "utf8"));
  const runs = [...(snapshot.activeRuns || []), ...(snapshot.recentRuns || [])];
  const byFlow = new Map();
  for (const run of runs) {
    const flowId = normalizeString(run?.flowId);
    if (!flowId) continue;
    if (onlyFlowId && flowId !== onlyFlowId) continue;
    const bucket = byFlow.get(flowId) || [];
    bucket.push(run);
    byFlow.set(flowId, bucket);
  }
  return {
    snapshot,
    byFlow
  };
}

function buildFlowIndex(flowsDb, onlyFlowId = "") {
  const db = new DatabaseSync(flowsDb, { readonly: true });
  try {
    const sql = `
      SELECT flow_id, status, current_step, state_json, goal, created_at, updated_at
      FROM flow_runs
      ${onlyFlowId ? "WHERE flow_id = ?" : ""}
      ORDER BY updated_at DESC
    `;
    const rows = onlyFlowId ? db.prepare(sql).all(onlyFlowId) : db.prepare(sql).all();
    return new Map(rows.map((row) => [normalizeString(row.flow_id), row]));
  } finally {
    db.close();
  }
}

function summarizeDashboardFlow(entries) {
  const canonical = [...entries].sort((a, b) =>
    String(b.updatedAt || b.startedAt || "").localeCompare(String(a.updatedAt || a.startedAt || ""))
  )[0] || null;
  if (!canonical) return null;
  return {
    flowId: normalizeString(canonical.flowId),
    flowSource: normalizeString(canonical.flowSource),
    hiddenInDashboard: Boolean(canonical.hiddenInDashboard),
    parentFlowId: normalizeString(canonical.parentFlowId),
    dashboardStatus: normalizeFlowStatus(canonical.status || canonical.flowStatus || canonical.flowCurrentStep),
    dashboardStep: normalizeFlowStep(canonical.flowCurrentStep || canonical.status),
    rawStatus: normalizeString(canonical.status),
    rawFlowStatus: normalizeString(canonical.flowStatus),
    rawStep: normalizeString(canonical.flowCurrentStep),
    runCount: entries.length
  };
}

function summarizeFlowRow(row) {
  const state = row?.state_json ? JSON.parse(row.state_json) : {};
  return {
    flowId: normalizeString(row?.flow_id),
    hiddenInDashboard: Boolean(state?.hiddenInDashboard),
    parentFlowId: normalizeString(state?.parentFlowId),
    flowStatus: normalizeFlowStatus(row?.status),
    flowStep: normalizeFlowStep(row?.current_step || state?.state),
    rawStatus: normalizeString(row?.status),
    rawStep: normalizeString(row?.current_step || state?.state)
  };
}

function classifyFlow(flowSummary, dashboardSummary) {
  if (flowSummary && dashboardSummary) {
    const exactMatch =
      flowSummary.hiddenInDashboard === dashboardSummary.hiddenInDashboard &&
      flowSummary.parentFlowId === dashboardSummary.parentFlowId &&
      flowSummary.rawStatus === dashboardSummary.rawFlowStatus &&
      flowSummary.rawStep === dashboardSummary.rawStep;
    if (exactMatch) return "exact_match";

    const normalizedMatch =
      flowSummary.hiddenInDashboard === dashboardSummary.hiddenInDashboard &&
      flowSummary.parentFlowId === dashboardSummary.parentFlowId &&
      flowSummary.flowStatus === dashboardSummary.dashboardStatus &&
      flowSummary.flowStep === dashboardSummary.dashboardStep;
    if (normalizedMatch) return "normalized_match";

    return "state_mismatch";
  }
  if (flowSummary && !dashboardSummary) return flowSummary.hiddenInDashboard ? "hidden_only" : "flow_only";
  if (!flowSummary && dashboardSummary) return "dashboard_only";
  return "unknown";
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log("Usage: node scripts/reconcile-dashboard-taskflow.js [--flows-db PATH] [--dashboard-status PATH] [--flow-id FLOW]");
    return;
  }

  const dashboardIndex = buildDashboardIndex(options.dashboardStatus, options.flowId);
  const flowIndex = buildFlowIndex(options.flowsDb, options.flowId);
  const flowIds = new Set([...flowIndex.keys(), ...dashboardIndex.byFlow.keys()]);

  const items = [];
  for (const flowId of Array.from(flowIds).sort()) {
    const flowSummary = flowIndex.has(flowId) ? summarizeFlowRow(flowIndex.get(flowId)) : null;
    const dashboardSummary = dashboardIndex.byFlow.has(flowId) ? summarizeDashboardFlow(dashboardIndex.byFlow.get(flowId)) : null;
    items.push({
      flowId,
      classification: classifyFlow(flowSummary, dashboardSummary),
      flow: flowSummary,
      dashboard: dashboardSummary
    });
  }

  const summary = {
    exactMatch: items.filter((item) => item.classification === "exact_match").length,
    normalizedMatch: items.filter((item) => item.classification === "normalized_match").length,
    hiddenOnly: items.filter((item) => item.classification === "hidden_only").length,
    flowOnly: items.filter((item) => item.classification === "flow_only").length,
    dashboardOnly: items.filter((item) => item.classification === "dashboard_only").length,
    stateMismatch: items.filter((item) => item.classification === "state_mismatch").length
  };

  console.log(JSON.stringify({
    generatedAt: new Date().toISOString(),
    dashboardGeneratedAt: dashboardIndex.snapshot?.meta?.generatedAt || "",
    summary,
    items
  }, null, 2));
}

main();
