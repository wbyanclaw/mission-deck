import {
  fmtTime,
  needsTextToggle,
  sortTimelineDesc,
  truncateText
} from "./app-utils.js?v=dashboard-live-20260422-4";
import {
  deriveTaskSummary,
  getAgentDisplayName,
  getLatestBlocker,
  getLatestDispatch,
  getFlowStepText,
  humanizeLatestDetail
} from "./app-task-core.js?v=dashboard-live-20260422-4";

export function getTimelineOwnerName(data, owner, fallbackAgentId) {
  const normalizedOwner = String(owner || "").trim();
  if (!normalizedOwner) return getAgentDisplayName(data, fallbackAgentId);
  if (normalizedOwner === "用户") return "用户";
  return getAgentDisplayName(data, normalizedOwner);
}

export function summarizeBlocker(reason) {
  const text = String(reason || "").trim();
  if (!text) return "处理过程中遇到异常，需要重新跟进。";
  if (/not allowed|forbidden|denied/i.test(text)) return "当前这条协作没有权限发出去，需要换一种处理方式。";
  if (/timeout|timed out/i.test(text)) return "等待时间过长，暂时还没有收到后续结果。";
  if (/invalid|without sessionkey|label/i.test(text)) return "这次交接方式不成立，需要重新建立任务连接。";
  return truncateText(text, 72);
}

export function buildWorkTreeRows(run, data) {
  const rows = [{
    timestamp: run.startedAt,
    owner: "用户",
    role: "用户发起",
    text: deriveTaskSummary(run)
  }];

  for (const item of (Array.isArray(run.timelineEvents) ? run.timelineEvents : [])) {
    rows.push({
      timestamp: item.timestamp,
      owner: getTimelineOwnerName(data, item.owner, run.agentId),
      role: item.role === "最终回复"
        ? "回复用户"
        : item.role === "内部查询"
          ? "任务拆解"
          : item.role === "安排跟进"
            ? "任务分配"
            : item.role === "对外同步"
              ? "外部同步"
              : (item.role || "任务更新"),
      text: item.text || "",
      tone: item.tone || ""
    });
  }

  for (const entry of (data.recentDispatches || []).filter((item) => item.runId === run.runId)) {
    const targetName = getAgentDisplayName(data, entry.target?.agentId);
    rows.push({
      timestamp: entry.timestamp,
      owner: getAgentDisplayName(data, entry.agentId || run.agentId),
      role: "安排跟进",
      text: `已交给${targetName}继续处理。`
    });
  }

  for (const task of (run.childTasks || [])) {
    rows.push({
      timestamp: task.updatedAt,
      owner: getAgentDisplayName(data, task.agentId),
      role: "协同反馈",
      text: task.progressSummary || task.label || "当前正在推进中"
    });
  }

  for (const entry of (data.recentBlockers || []).filter((item) => item.runId === run.runId)) {
    rows.push({
      timestamp: entry.timestamp,
      owner: getAgentDisplayName(data, entry.agentId || run.agentId),
      role: "异常摘要",
      text: summarizeBlocker(entry.reason),
      tone: "blocked"
    });
  }

  if (run.lastExternalMessage) {
    rows.push({
      timestamp: run.updatedAt,
      owner: getAgentDisplayName(data, run.agentId),
      role: "对话更新",
      text: run.lastExternalMessage
    });
  }

  if (rows.length === 1) {
    rows.push({
      timestamp: run.updatedAt || run.startedAt,
      owner: getAgentDisplayName(data, run.agentId),
      role: "对话更新",
      text: "已接单，正在处理中。"
    });
  }

  const seen = new Set();
  return sortTimelineDesc(rows.filter((item) => {
    if (!item.text) return false;
    const key = [
      String(item.timestamp || ""),
      String(item.owner || ""),
      String(item.role || ""),
      String(item.text || "")
    ].join("\u0000");
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }));
}

export function getSupervisorSummary(run) {
  if (!run.supervisorPending && !run.supervisorLastInterventionAt) return null;
  const owner = String(run.supervisorAgentId || "").trim() || "manager";
  const reason = String(run.supervisorReason || run.flowWaitSummary || run.lastBlockReason || "").trim() || "任务等待时间过长，需要人工收敛";
  return {
    owner,
    reason,
    count: Number(run.supervisorInterventionCount || 0),
    time: run.supervisorLastInterventionAt || ""
  };
}

export function buildSupervisorFacts(run) {
  const summary = getSupervisorSummary(run);
  if (!summary) return [];
  return [
    { label: "Supervisor", value: summary.owner },
    { label: "督办时间", value: fmtTime(summary.time) },
    { label: "督办次数", value: String(summary.count || 1) },
    { label: "督办原因", value: summary.reason }
  ];
}

export function getCurrentProgress(run, data) {
  if (run.flowWaitSummary) return run.flowWaitSummary;
  if (getFlowStepText(run)) return `当前阶段：${getFlowStepText(run)}`;
  return run.childTasks?.at?.(-1)?.progressSummary ||
    run.lastExternalMessage ||
    humanizeLatestDetail(run, getLatestBlocker(run, data));
}

export function getCurrentOwner(run, data) {
  const latestDispatch = getLatestDispatch(run, data);
  return run.childTasks?.at?.(-1)?.agentId ||
    latestDispatch?.target?.agentId ||
    run.agentId ||
    "待分配";
}

export { needsTextToggle };
