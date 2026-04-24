import {
  fmtTime,
  needsTextToggle,
  sortTimelineDesc,
  truncateText
} from "./app-utils.js?v=dashboard-live-20260424202409-g32df9";
import {
  getAgentDisplayName,
  deriveTaskSummary
} from "./app-task-core.js?v=dashboard-live-20260424202409-g32df9";

export function getTimelineOwnerName(data, owner, fallbackAgentId) {
  const normalizedOwner = String(owner || "").trim();
  if (!normalizedOwner) return getAgentDisplayName(data, fallbackAgentId);
  if (normalizedOwner === "用户") return "用户";
  return getAgentDisplayName(data, normalizedOwner);
}

function isUserFacingTimelineRole(role) {
  const normalized = String(role || "").trim();
  return normalized === "最终回复" || normalized === "对外同步" || normalized === "用户追问";
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
    timestamp: run.userAskedAt || run.startedAt,
    owner: "用户",
    role: "用户发起",
    text: deriveTaskSummary(run)
  }];

  for (const item of (Array.isArray(run.timelineEvents) ? run.timelineEvents : [])) {
    if (!isUserFacingTimelineRole(item.role)) continue;
    rows.push({
      timestamp: item.timestamp,
      owner: getTimelineOwnerName(data, item.owner, run.agentId),
      role: item.role === "用户追问" ? "用户追问" : "模型回复",
      text: item.text || "",
      tone: item.tone || ""
    });
  }

  if (run.lastExternalMessage) {
    const hasVisibleReply = rows.some((item) => item.role === "模型回复" && item.text === run.lastExternalMessage);
    if (!hasVisibleReply) {
      rows.push({
        timestamp: run.updatedAt,
        owner: getAgentDisplayName(data, run.agentId),
        role: "模型回复",
        text: run.lastExternalMessage
      });
    }
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
