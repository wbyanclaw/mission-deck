export function getDashboardElements() {
  return {
    versionBadge: document.getElementById("versionBadge"),
    generatedAt: document.getElementById("generatedAt"),
    heroSub: document.getElementById("heroSub"),
    summary: document.getElementById("summary"),
    agents: document.getElementById("agents"),
    graph: document.getElementById("graph"),
    timeline: document.getElementById("timeline"),
    taskCount: document.getElementById("task-count"),
    directSessions: document.getElementById("directSessions"),
    directCount: document.getElementById("direct-count"),
    sessionFilterChips: Array.from(document.querySelectorAll("[data-session-kind]")),
    tabTasks: document.getElementById("tab-tasks"),
    tabSessions: document.getElementById("tab-sessions"),
    tasksPanel: document.getElementById("tasks-panel"),
    sessionsPanel: document.getElementById("sessions-panel")
  };
}

export function createUiState() {
  return {
    agentOpen: new Set(),
    taskOpen: new Set(),
    activeTab: "tasks",
    visibleSessionKinds: new Set(["direct", "cron", "system", "empty"])
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
    button.textContent = expanded ? "收起全文" : "展开全文";
    button.setAttribute("aria-expanded", expanded ? "true" : "false");
  });
}

export function bindTabs(el, uiState) {
  const applyTab = (tab) => {
    uiState.activeTab = tab;
    const tasksActive = tab === "tasks";
    el.tabTasks?.classList.toggle("is-active", tasksActive);
    el.tabSessions?.classList.toggle("is-active", !tasksActive);
    el.tabTasks?.setAttribute("aria-selected", tasksActive ? "true" : "false");
    el.tabSessions?.setAttribute("aria-selected", tasksActive ? "false" : "true");
    if (el.tasksPanel) {
      el.tasksPanel.hidden = !tasksActive;
      el.tasksPanel.classList.toggle("is-active", tasksActive);
    }
    if (el.sessionsPanel) {
      el.sessionsPanel.hidden = tasksActive;
      el.sessionsPanel.classList.toggle("is-active", !tasksActive);
    }
  };

  el.tabTasks?.addEventListener("click", () => applyTab("tasks"));
  el.tabSessions?.addEventListener("click", () => applyTab("sessions"));
  applyTab(uiState.activeTab || "tasks");
}

export function bindSessionFilters(el, uiState, onChange) {
  for (const chip of el.sessionFilterChips || []) {
    const kind = String(chip.dataset.sessionKind || "").toLowerCase();
    if (!kind) continue;
    chip.classList.toggle("is-active", uiState.visibleSessionKinds.has(kind));
    chip.addEventListener("click", () => {
      if (uiState.visibleSessionKinds.has(kind)) {
        uiState.visibleSessionKinds.delete(kind);
      } else {
        uiState.visibleSessionKinds.add(kind);
      }
      for (const next of el.sessionFilterChips || []) {
        const nextKind = String(next.dataset.sessionKind || "").toLowerCase();
        next.classList.toggle("is-active", uiState.visibleSessionKinds.has(nextKind));
      }
      onChange?.();
    });
  }
}
