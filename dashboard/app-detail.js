import {
  esc,
  fmtTime,
  getStatusText,
  isValidSnapshot,
  renderEmpty,
} from "./app-utils.js?v=dashboard-live-20260424192000-sessionfilters";
import {
  buildTaskCards,
  buildTaskChain,
  buildTaskChainFacts,
  deriveTaskSummary,
  getEffectiveStatus,
} from "./app-task-core.js?v=dashboard-live-20260424192000-sessionfilters";
import {
  buildSupervisorFacts,
  buildWorkTreeRows,
  getSupervisorSummary,
  needsTextToggle
} from "./app-timeline-models.js?v=dashboard-live-20260424192000-sessionfilters";

const detailTitle = document.getElementById("detailTitle");
const detailSub = document.getElementById("detailSub");
const detailGeneratedAt = document.getElementById("detailGeneratedAt");
const detailContent = document.getElementById("detailContent");

function query() {
  const params = new URLSearchParams(window.location.search);
  return {
    type: params.get("type") || "",
    flowId: params.get("flowId") || "",
    sessionKey: params.get("sessionKey") || ""
  };
}

function directRows(run) {
  const rows = [...(Array.isArray(run.timelineEvents) ? run.timelineEvents : [])]
    .filter((item) => item?.text && (item?.role === "用户发起" || item?.role === "用户追问" || item?.role === "对外同步" || item?.role === "最终回复"))
    .map((item) => ({
      timestamp: item.timestamp,
      role: item.role === "对外同步" || item.role === "最终回复" ? "模型回复" : item.role,
      owner: item.owner || run.agentId || "-",
      text: item.text
    }))
    .sort((a, b) => String(a.timestamp || "").localeCompare(String(b.timestamp || "")));
  if (rows.length) return rows;
  const fallback = [];
  if (run.initialUserPrompt || run.promptText) {
    fallback.push({
      timestamp: run.userAskedAt || run.startedAt || run.updatedAt,
      role: "用户发起",
      owner: "用户",
      text: run.initialUserPrompt || run.promptText
    });
  }
  if (run.lastExternalMessage) {
    fallback.push({
      timestamp: run.updatedAt,
      role: "模型回复",
      owner: run.agentId || "-",
      text: run.lastExternalMessage
    });
  }
  return fallback;
}

function renderTimelineRows(rows) {
  if (!rows.length) return `<div class="empty-inline">暂无完整时间线。</div>`;
  return `
    <div class="worktree-rail">
      ${rows.map((item) => {
        const collapsible = item.role === "模型回复" && needsTextToggle(item.text);
        return `
          <article class="worktree-node ${esc(item.tone || "")}">
            <div class="worktree-dot"></div>
            <div class="worktree-content">
              <div class="worktree-meta">${esc(item.role)} · ${esc(item.owner || "-")} · ${esc(fmtTime(item.timestamp))}</div>
              <div class="worktree-text ${collapsible ? "is-collapsed" : ""}">${esc(item.text)}</div>
              ${collapsible ? `<button type="button" class="worktree-toggle" aria-expanded="false">展开全文</button>` : ""}
            </div>
          </article>
        `;
      }).join("")}
    </div>
  `;
}

function renderTaskDetail(task, data) {
  const status = getEffectiveStatus(task);
  const chain = buildTaskChain(task, data);
  const facts = buildTaskChainFacts(task, data);
  const supervisorSummary = getSupervisorSummary(task);
  const supervisorFacts = buildSupervisorFacts(task);
  const rows = buildWorkTreeRows(task, data);

  detailTitle.textContent = deriveTaskSummary(task);
  detailSub.textContent = `任务详情 · ${getStatusText(status)} · ${fmtTime(task.userAskedAt || task.startedAt || task.updatedAt)}`;

  detailContent.innerHTML = `
    <article class="task-card detail-card">
      <div class="task-head">
        <div>
          <div class="task-time">TaskFlow · ${esc(task.flowId || "-")}</div>
          <h3>${esc(deriveTaskSummary(task))}</h3>
        </div>
        <div class="task-status ${esc(status)}">${esc(getStatusText(status))}</div>
      </div>
      <section class="task-chain">
        <div class="chain-title">任务链路</div>
        <div class="chain-path">
          ${chain.map((node, chainIndex) => `
            ${chainIndex > 0 ? `<span class="chain-arrow">→</span>` : ""}
            <span class="chain-node">
              <span class="chain-node-title">${esc(node.title)}</span>
              ${node.note ? `<span class="chain-node-note">${esc(node.note)}</span>` : ""}
            </span>
          `).join("")}
        </div>
        <div class="chain-facts">
          ${facts.map((item) => `
            <div class="chain-fact">
              <div class="chain-fact-label">${esc(item.label)}</div>
              <div class="chain-fact-value">${esc(item.value || "-")}</div>
            </div>
          `).join("")}
        </div>
        ${supervisorSummary ? `
          <div class="supervisor-panel ${task.supervisorPending ? "pending" : ""}">
            <div class="supervisor-head">
              <div>
                <div class="chain-title">督办状态</div>
                <div class="supervisor-title">${esc(supervisorSummary.owner)}</div>
              </div>
            </div>
            <div class="supervisor-reason">${esc(supervisorSummary.reason)}</div>
            <div class="supervisor-facts">
              ${supervisorFacts.map((item) => `
                <div class="supervisor-fact">
                  <div class="chain-fact-label">${esc(item.label)}</div>
                  <div class="chain-fact-value">${esc(item.value || "-")}</div>
                </div>
              `).join("")}
            </div>
          </div>
        ` : ""}
      </section>
      <section class="task-chain">
        <div class="chain-title">完整时间线</div>
        <div class="worktree-body">
          ${renderTimelineRows(rows)}
        </div>
      </section>
    </article>
  `;
}

function renderSessionDetail(run) {
  const status = getEffectiveStatus(run);
  const rows = directRows(run);
  detailTitle.textContent = run.sessionTitle || run.promptText || "会话详情";
  detailSub.textContent = `会话详情 · ${getStatusText(status)} · ${fmtTime(run.userAskedAt || run.startedAt || run.updatedAt)}`;
  detailContent.innerHTML = `
    <article class="task-card detail-card">
      <div class="task-head">
        <div>
          <div class="task-time">${esc(run.agentId || "-")} · ${esc(run.sessionKind || "direct")}</div>
          <h3>${esc(run.sessionTitle || run.promptText || "会话记录")}</h3>
        </div>
        <div class="task-status ${esc(status)}">${esc(getStatusText(status))}</div>
      </div>
      <section class="task-chain">
        <div class="chain-facts">
          <div class="chain-fact">
            <div class="chain-fact-label">Agent</div>
            <div class="chain-fact-value">${esc(run.agentId || "-")}</div>
          </div>
          <div class="chain-fact">
            <div class="chain-fact-label">会话类型</div>
            <div class="chain-fact-value">${esc(run.sessionKind || "-")}</div>
          </div>
          <div class="chain-fact">
            <div class="chain-fact-label">会话键</div>
            <div class="chain-fact-value">${esc(run.sessionKey || "-")}</div>
          </div>
          <div class="chain-fact">
            <div class="chain-fact-label">最新更新时间</div>
            <div class="chain-fact-value">${esc(fmtTime(run.updatedAt))}</div>
          </div>
        </div>
      </section>
      <section class="task-chain">
        <div class="chain-title">完整时间线</div>
        <div class="worktree-body">
          ${renderTimelineRows(rows)}
        </div>
      </section>
    </article>
  `;
}

function bindTextToggle() {
  document.addEventListener("click", (event) => {
    const button = event.target.closest(".worktree-toggle");
    if (!button) return;
    const text = button.parentElement?.querySelector(".worktree-text");
    if (!text) return;
    const expanded = text.classList.toggle("is-expanded");
    text.classList.toggle("is-collapsed", !expanded);
    button.textContent = expanded ? "收起全文" : "展开全文";
    button.setAttribute("aria-expanded", expanded ? "true" : "false");
  });
}

async function load() {
  const q = query();
  try {
    const response = await fetch(`./status.json?t=${Date.now()}`, { cache: "no-store" });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data = await response.json();
    if (!isValidSnapshot(data)) throw new Error("快照结构不完整");
    detailGeneratedAt.textContent = `更新时间：${fmtTime(data.meta?.generatedAt)}`;
    if (q.type === "task" && q.flowId) {
      const task = buildTaskCards(data).find((item) => String(item.flowId || "") === q.flowId);
      if (!task) return renderEmpty(detailContent, "未找到这条任务链路。");
      return renderTaskDetail(task, data);
    }
    if (q.type === "session" && q.sessionKey) {
      const run = (Array.isArray(data.directSessions) ? data.directSessions : [])
        .find((item) => String(item.sessionKey || "") === q.sessionKey);
      if (!run) return renderEmpty(detailContent, "未找到这条会话链路。");
      return renderSessionDetail(run);
    }
    renderEmpty(detailContent, "参数不完整，无法展示详情。");
  } catch (error) {
    detailTitle.textContent = "加载失败";
    detailSub.textContent = "详情页读取失败";
    renderEmpty(detailContent, `暂时无法加载：${error.message}`);
  }
}

bindTextToggle();
load();
