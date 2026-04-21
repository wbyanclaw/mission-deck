export function getDashboardElements() {
  return {
    versionBadge: document.getElementById("versionBadge"),
    generatedAt: document.getElementById("generatedAt"),
    heartbeat: document.getElementById("heartbeat"),
    heroSub: document.getElementById("heroSub"),
    summary: document.getElementById("summary"),
    agents: document.getElementById("agents"),
    graph: document.getElementById("graph"),
    timeline: document.getElementById("timeline"),
    taskCount: document.getElementById("task-count")
  };
}

export function createUiState() {
  return {
    agentOpen: new Set(),
    taskOpen: new Set()
  };
}

export function captureUiState(uiState) {
  uiState.agentOpen = new Set(
    Array.from(document.querySelectorAll("[data-agent-id]"))
      .filter((node) => node.open)
      .map((node) => node.dataset.agentId)
      .filter(Boolean)
  );
  uiState.taskOpen = new Set(
    Array.from(document.querySelectorAll("[data-run-id]"))
      .filter((node) => node.open)
      .map((node) => node.dataset.runId)
      .filter(Boolean)
  );
}

export function bindTimelineToggle() {
  document.addEventListener("click", (event) => {
    const button = event.target.closest(".worktree-toggle");
    if (!button) return;
    const text = button.parentElement?.querySelector(".worktree-text");
    if (!text) return;
    const expanded = text.classList.toggle("is-expanded");
    text.classList.toggle("is-collapsed", !expanded);
    button.textContent = expanded ? "收起" : "展开";
    button.setAttribute("aria-expanded", expanded ? "true" : "false");
  });
}
