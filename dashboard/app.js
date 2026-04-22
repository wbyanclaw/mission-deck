import {
  fmtTime,
  isValidSnapshot,
  renderEmpty,
  shouldIgnoreSnapshot,
  timeAgo
} from "./app-utils.js?v=dashboard-live-20260422-4";
import {
  bindTimelineToggle,
  captureUiState,
  createUiState,
  getDashboardElements
} from "./app-dom.js?v=dashboard-live-20260422-4";
import {
  renderAgents,
  renderGraph,
  renderHero,
  renderSummary,
  renderTimeline
} from "./app-renderers.js?v=dashboard-live-20260422-4";

const el = getDashboardElements();

const DASHBOARD_VERSION = "v0.1.0+patch4";

let lastGeneratedAt = "";
let lastGoodData = null;
const uiState = createUiState();

if (el.versionBadge) {
  el.versionBadge.textContent = DASHBOARD_VERSION;
}

function renderUpdatedAt(value, suffix = "") {
  const relative = timeAgo(value);
  el.generatedAt.textContent = suffix
    ? `更新时间：${relative} · ${suffix}`
    : `更新时间：${relative}`;
}

function applyDashboard(data) {
  lastGeneratedAt = data.meta?.generatedAt || "";
  renderUpdatedAt(lastGeneratedAt);
  renderHero(el, data);
  renderSummary(el, data);
  renderAgents(el, data);
  renderGraph(el, data);
  renderTimeline(el, uiState, data);
}

async function loadDashboard() {
  try {
    captureUiState(uiState);
    const response = await fetch(`./status.json?t=${Date.now()}`, { cache: "no-store" });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data = await response.json();
    if (!isValidSnapshot(data)) {
      throw new Error("快照结构不完整");
    }
    if (shouldIgnoreSnapshot(data, lastGoodData)) {
      renderUpdatedAt(lastGoodData?.meta?.generatedAt, "正在等待稳定快照");
      return;
    }
    lastGoodData = data;
    applyDashboard(data);
  } catch (error) {
    if (lastGoodData) {
      renderUpdatedAt(lastGoodData?.meta?.generatedAt, "拉取暂时失败，正在显示最近一次缓存快照");
      return;
    }
    lastGeneratedAt = "";
    el.generatedAt.textContent = "更新时间：加载失败";
    el.heroSub.textContent = "暂时无法加载 Dashboard 快照。";
    renderEmpty(el.summary, "等待数据中");
    renderEmpty(el.agents, "等待数据中");
    renderEmpty(el.graph, "等待数据中");
    renderEmpty(el.timeline, `暂时无法加载：${error.message}`);
  }
}

loadDashboard();
setInterval(() => renderUpdatedAt(lastGeneratedAt), 1000);
setInterval(loadDashboard, 3000);

bindTimelineToggle();
