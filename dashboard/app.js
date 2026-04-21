import {
  fmtTime,
  isValidSnapshot,
  renderEmpty,
  shouldIgnoreSnapshot,
  timeAgo
} from "./app-utils.js";
import {
  bindTimelineToggle,
  captureUiState,
  createUiState,
  getDashboardElements
} from "./app-dom.js";
import {
  renderAgents,
  renderGraph,
  renderHero,
  renderSummary,
  renderTimeline
} from "./app-renderers.js";

const el = getDashboardElements();

const DASHBOARD_VERSION = "v0.1.0+patch3";

let lastGeneratedAt = "";
let lastGoodData = null;
const uiState = createUiState();

function refreshHeartbeat() {
  el.heartbeat.textContent = lastGeneratedAt
    ? `实时心跳：${timeAgo(lastGeneratedAt)}`
    : "实时心跳：-";
}

function applyDashboard(data) {
  if (el.versionBadge) {
    el.versionBadge.textContent = `Version: ${DASHBOARD_VERSION}`;
  }
  el.generatedAt.textContent = `更新时间：${fmtTime(data.meta?.generatedAt)}`;
  lastGeneratedAt = data.meta?.generatedAt || "";
  refreshHeartbeat();
  renderHero(el, data);
  renderSummary(el, data);
  renderAgents(el, data);
  renderGraph(el, data);
  renderTimeline(el, uiState, data);
}

async function loadDashboard() {
  try {
    captureUiState();
    const response = await fetch(`./status.json?t=${Date.now()}`, { cache: "no-store" });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data = await response.json();
    if (!isValidSnapshot(data)) {
      throw new Error("快照结构不完整");
    }
    if (shouldIgnoreSnapshot(data, lastGoodData)) {
      el.generatedAt.textContent = `更新时间：${fmtTime(lastGoodData?.meta?.generatedAt)} · 正在等待稳定快照`;
      return;
    }
    lastGoodData = data;
    applyDashboard(data);
  } catch (error) {
    if (lastGoodData) {
      el.generatedAt.textContent = `更新时间：${fmtTime(lastGoodData?.meta?.generatedAt)} · 拉取暂时失败，正在显示最近一次缓存快照`;
      refreshHeartbeat();
      return;
    }
    lastGeneratedAt = "";
    el.generatedAt.textContent = "更新时间：加载失败";
    el.heartbeat.textContent = "实时心跳：加载失败";
    el.heroSub.textContent = "暂时无法加载 Dashboard 快照。";
    renderEmpty(el.summary, "等待数据中");
    renderEmpty(el.agents, "等待数据中");
    renderEmpty(el.graph, "等待数据中");
    renderEmpty(el.timeline, `暂时无法加载：${error.message}`);
  }
}

loadDashboard();
setInterval(refreshHeartbeat, 1000);
setInterval(loadDashboard, 3000);

bindTimelineToggle();
