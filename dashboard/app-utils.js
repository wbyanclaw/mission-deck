export const STATUS_TEXT = {
  blocked: "需要关注",
  waiting: "处理中",
  reviewing: "汇总中",
  completed: "已完成",
  delegated: "已分派",
  lane_open: "已建立处理通道",
  coordinating: "协同中",
  triaging: "分流中",
  non_engineering: "其他"
};

export const TARGET_KIND_TEXT = {
  "persistent-channel-session": "继续当前 Channel Session",
  "subagent-session": "新建专用 Subagent Session",
  "cron-session": "在定时 Session 中继续处理",
  "spawned-run": "新建隔离 Run 通道",
  "existing-session": "复用已有 Session"
};

export function fmtTime(value) {
  if (!value) return "-";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString();
}

export function timeAgo(value) {
  if (!value) return "-";
  const diff = Math.max(0, Date.now() - new Date(value).getTime());
  const secs = Math.floor(diff / 1000);
  if (secs < 1) return "刚刚";
  if (secs < 60) return `${secs} 秒前`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins} 分钟前`;
  const hours = Math.floor(mins / 60);
  return `${hours} 小时前`;
}

export function esc(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

export function isValidSnapshot(data) {
  if (!data || typeof data !== "object") return false;
  if (!data.meta || !data.meta.generatedAt) return false;
  if (!Array.isArray(data.agentRoster)) return false;
  if (!Array.isArray(data.recentRuns)) return false;
  if (!Array.isArray(data.activeRuns)) return false;
  if (!Array.isArray(data.recentDispatches)) return false;
  return true;
}

export function shouldIgnoreSnapshot(data, lastGoodData) {
  if (!lastGoodData) return false;
  const hadVisibleData =
    (lastGoodData.recentRuns || []).length > 0 ||
    (lastGoodData.activeRuns || []).length > 0 ||
    (lastGoodData.recentDispatches || []).length > 0;
  const hasVisibleData =
    (data.recentRuns || []).length > 0 ||
    (data.activeRuns || []).length > 0 ||
    (data.recentDispatches || []).length > 0;
  return hadVisibleData && !hasVisibleData;
}

export function getStatusText(status) {
  return STATUS_TEXT[status] || "活跃";
}

export function fmtCompactNumber(value) {
  const num = Number(value) || 0;
  if (num >= 1000000) return `${(num / 1000000).toFixed(1).replace(/\.0$/, "")}M`;
  if (num >= 1000) return `${(num / 1000).toFixed(1).replace(/\.0$/, "")}k`;
  return String(num);
}

export function sortByTimestampAsc(items, pickTimestamp) {
  return [...items].sort((a, b) =>
    String(pickTimestamp(a) || "").localeCompare(String(pickTimestamp(b) || ""))
  );
}

export function truncateText(value, max = 120) {
  const text = String(value || "").trim();
  if (text.length <= max) return text;
  return `${text.slice(0, max)}...`;
}

export function needsTextToggle(value) {
  const text = String(value || "");
  return text.length > 96 || text.includes("\n");
}

export function sortTimelineDesc(items) {
  return items.sort((a, b) => String(b.timestamp || "").localeCompare(String(a.timestamp || "")));
}

export function renderEmpty(target, text) {
  target.innerHTML = `<div class="empty">${esc(text)}</div>`;
}
