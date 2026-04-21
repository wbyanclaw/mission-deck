const DEFAULT_ENGINEERING_KEYWORDS = [];

const DEFAULT_ENTRYPOINT_PATTERNS = [
  "repo path",
  "repository path",
  "git url",
  "git address",
  "session key",
  "session id",
  "session entry",
  "project directory",
  "project dir",
  "project path",
  "workspace path",
  "仓库路径",
  "git 地址",
  "git地址",
  "会话入口",
  "会话 id",
  "项目目录",
  "项目路径",
  "工作区路径",
  "请直接发",
  "请提供"
];

const DEFAULT_DISCOVERY_TOOL_NAMES = [
  "exec",
  "read",
  "ls",
  "glob",
  "find",
  "grep",
  "rg",
  "file_reader",
  "file-reader"
];

const INTERNAL_COORDINATION_TOOL_NAMES = new Set([
  "sessions_list",
  "sessions_history",
  "agents_list",
  "subagents"
]);

const EXECUTION_LANE_TOOL_NAMES = new Set([
  "sessions_spawn",
  "sessions_send"
]);

const MESSAGE_TOOL_NAME = "message";
const SESSIONS_SEND_TOOL_NAME = "sessions_send";
const SILENT_REPLY_TOKEN = "NO_REPLY";
const MAX_LABEL_LENGTH = 48;

const EVENT_TYPES = Object.freeze({
  NEW_TASK: "new_task",
  RESUME_TASK: "resume_task",
  RESET_TASK: "reset_task",
  TOOL_REQUEST: "tool_request",
  TOOL_RESULT: "tool_result",
  CHILD_REPORT: "child_report",
  PROGRESS_UPDATE: "progress_update",
  FINALIZE_CANDIDATE: "finalize_candidate",
  SYSTEM_ANNOUNCE: "system_announce",
  AGENT_ENDED: "agent_ended"
});

const FLOW_STATES = Object.freeze({
  INTAKE: "intake",
  PLANNED: "planned",
  ROUTING: "routing",
  DELEGATED: "delegated",
  WAITING_CHILD: "waiting_child",
  REVIEWING: "reviewing",
  AWAITING_USER_INPUT: "awaiting_user_input",
  BLOCKED: "blocked",
  FINALIZING: "finalizing",
  COMPLETED: "completed",
  FAILED: "failed",
  CANCELLED: "cancelled"
});

const FINAL_DELIVERY_PATTERNS = [
  "done",
  "completed",
  "complete",
  "finished",
  "ready",
  "summary:",
  "here is the summary",
  "here's the summary",
  "final summary",
  "final result",
  "final answer",
  "已收齐",
  "现已收齐",
  "汇总如下",
  "如下",
  "结论：",
  "结论:",
  "盘点如下",
  "工作计划如下",
  "下面是",
  "已完成",
  "已整理",
  "已汇总"
];

const UNVERIFIED_EXECUTION_PATTERNS = [
  "已在执行",
  "正在执行",
  "开始执行",
  "已安排执行",
  "已安排处理",
  "已交给",
  "已委派",
  "已发起",
  "already executing",
  "currently executing",
  "execution is in progress",
  "delegated",
  "spawned"
];

const FOLLOWUP_SUMMARY_PATTERNS = [
  "等",
  "回执后",
  "结果后",
  "拿到",
  "收到",
  "汇总给你",
  "再汇总",
  "then summarize",
  "after",
  "once"
];

const AWAITING_USER_INPUT_PATTERNS = [
  "please provide",
  "please send",
  "send me",
  "once you send",
  "once provided",
  "i can continue",
  "test url",
  "test address",
  "project directory",
  "startup command",
  "startup steps",
  "test account",
  "repo path",
  "repository path",
  "git url",
  "project path",
  "请提供",
  "请直接发",
  "请发",
  "你把",
  "给我一套",
  "我就能继续",
  "继续推进",
  "你一发",
  "测试地址",
  "项目目录",
  "启动方式",
  "测试账号",
  "仓库路径"
];

function normalizeString(value) {
  return typeof value === "string" ? value.trim() : "";
}

function hasNonEmptyString(value) {
  return normalizeString(value).length > 0;
}

function isoNow() {
  return new Date().toISOString();
}

function toFlatText(value) {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map((item) => toFlatText(item)).join(" ");
  if (value && typeof value === "object") {
    return Object.values(value).map((item) => toFlatText(item)).join(" ");
  }
  return "";
}

function tokenizeText(value) {
  return normalizeString(value)
    .toLowerCase()
    .split(/[^a-z0-9\u4e00-\u9fff]+/i)
    .map((token) => token.trim())
    .filter(Boolean);
}

function stripPromptScaffolding(prompt) {
  const lines = normalizeString(prompt).split(/\r?\n/);
  const kept = [];
  let skipFence = false;
  let metadataFence = false;
  for (const rawLine of lines) {
    const line = rawLine.trimEnd();
    const trimmed = line.trim();
    if (skipFence) {
      if (trimmed.startsWith("```")) {
        skipFence = false;
        metadataFence = false;
      }
      continue;
    }
    if (/^(Conversation info|Sender \(untrusted metadata\)|Recipient \(untrusted metadata\)|Tool result metadata)/i.test(trimmed)) {
      metadataFence = true;
      continue;
    }
    if (metadataFence && trimmed.startsWith("```")) {
      skipFence = true;
      continue;
    }
    metadataFence = false;
    if (
      /^\[message_id:/i.test(trimmed) ||
      /^Current time:/i.test(trimmed) ||
      /^Return your response as plain text/i.test(trimmed)
    ) {
      continue;
    }
    kept.push(line);
  }
  return kept.join("\n");
}

function sanitizeTaskPrompt(prompt) {
  const stripped = stripPromptScaffolding(prompt)
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  if (!stripped) return normalizeString(prompt);
  return stripped;
}

function toLowerSet(values) {
  return new Set(
    (Array.isArray(values) ? values : [])
      .map((value) => normalizeString(value).toLowerCase())
      .filter(Boolean)
  );
}

function getAgentEntries(cfg) {
  const list = cfg?.agents?.list;
  if (Array.isArray(list)) {
    return list
      .filter((entry) => entry && typeof entry === "object" && hasNonEmptyString(entry.id))
      .map((entry) => ({ id: entry.id.trim(), config: entry }));
  }
  if (list && typeof list === "object") {
    return Object.entries(list)
      .filter(([id, entry]) => hasNonEmptyString(id) && entry && typeof entry === "object")
      .map(([id, entry]) => ({ id: id.trim(), config: entry }));
  }
  return [];
}

function resolveAgentConfig(cfg, agentId) {
  return getAgentEntries(cfg).find((entry) => entry.id === agentId)?.config;
}

function listConfiguredAgentIds(cfg) {
  return getAgentEntries(cfg).map((entry) => entry.id);
}

function resolvePeerAgents(cfg, currentAgentId) {
  return listConfiguredAgentIds(cfg).filter((agentId) => agentId !== currentAgentId);
}

function resolveDelegationAllowAgents(cfg, currentAgentId) {
  const currentAgentConfig = resolveAgentConfig(cfg, currentAgentId);
  const explicitAgentAllow = Array.isArray(currentAgentConfig?.subagents?.allowAgents)
    ? currentAgentConfig.subagents.allowAgents
    : null;
  const defaultAllow = Array.isArray(cfg?.agents?.defaults?.subagents?.allowAgents)
    ? cfg.agents.defaults.subagents.allowAgents
    : null;
  const source = explicitAgentAllow ?? defaultAllow;
  if (!Array.isArray(source)) return [];
  return source.map((value) => normalizeString(value)).filter(Boolean);
}

function resolveA2APolicy(cfg) {
  const policy = cfg?.tools?.agentToAgent;
  const enabled = policy?.enabled === true;
  const allowed = Array.isArray(policy?.allow)
    ? new Set(policy.allow.map((value) => normalizeString(value)).filter(Boolean))
    : null;
  return { enabled, allowed };
}

function resolveAllowedExecutorAgents(cfg, currentAgentId) {
  const peers = resolvePeerAgents(cfg, currentAgentId);
  const resolvedAllowAgents = resolveDelegationAllowAgents(cfg, currentAgentId);
  const allowAgents = resolvedAllowAgents.length ? new Set(resolvedAllowAgents) : null;
  const a2a = resolveA2APolicy(cfg);
  return peers.filter((agentId) => {
    if (allowAgents && !allowAgents.has(agentId)) return false;
    if (a2a.enabled && a2a.allowed && !a2a.allowed.has(agentId)) return false;
    return true;
  });
}

function resolveWorkspaceDir(cfg, agentId) {
  const agentConfig = resolveAgentConfig(cfg, agentId);
  return normalizeString(agentConfig?.workspace) || normalizeString(cfg?.agents?.defaults?.workspace);
}

function resolveAgentIdentity(cfg, agentId) {
  const agentConfig = resolveAgentConfig(cfg, agentId);
  const identity = agentConfig?.identity ?? {};
  return {
    name: normalizeString(identity?.name),
    theme: normalizeString(identity?.theme),
    toolProfile: normalizeString(agentConfig?.tools?.profile)
  };
}

function resolveCoordinatorAgentId(cfg, pluginConfig = null) {
  const configuredCoordinator = normalizeString(
    pluginConfig?.coordinatorAgentId ??
    cfg?.plugins?.entries?.["mission-deck"]?.config?.coordinatorAgentId
  );
  if (configuredCoordinator) return configuredCoordinator;
  const defaultAgent = getAgentEntries(cfg).find((entry) => entry?.config?.default === true)?.id;
  return normalizeString(defaultAgent);
}

function resolveConfiguredCodeExecutorAgentIds(cfg, currentAgentId, pluginConfig = null) {
  const configured = Array.isArray(
    pluginConfig?.codeExecutorAgentIds ??
    cfg?.plugins?.entries?.["mission-deck"]?.config?.codeExecutorAgentIds
  )
    ? (pluginConfig?.codeExecutorAgentIds ??
      cfg?.plugins?.entries?.["mission-deck"]?.config?.codeExecutorAgentIds)
    : [];
  const allowed = new Set(resolveAllowedExecutorAgents(cfg, currentAgentId));
  return configured
    .map((value) => normalizeString(value))
    .filter((agentId) => agentId && allowed.has(agentId));
}

function pluginLikeWorkspaceRoots(cfg, pluginConfig) {
  return pluginConfig?.agentWorkspaceRoots ?? cfg?.plugins?.entries?.["mission-deck"]?.config?.agentWorkspaceRoots ?? null;
}

function resolveWorkspaceRoots(cfg, currentAgentId, pluginConfig = null) {
  const roots = new Set();
  const explicitRoots = pluginLikeWorkspaceRoots(cfg, pluginConfig);
  if (explicitRoots && typeof explicitRoots === "object") {
    for (const [agentId, root] of Object.entries(explicitRoots)) {
      if (!hasNonEmptyString(agentId)) continue;
      if (agentId === currentAgentId || resolvePeerAgents(cfg, currentAgentId).includes(agentId)) {
        const normalizedRoot = normalizeString(root);
        if (normalizedRoot) roots.add(normalizedRoot);
      }
    }
  }
  const currentWorkspace = resolveWorkspaceDir(cfg, currentAgentId);
  if (currentWorkspace) roots.add(currentWorkspace);
  for (const peerId of resolvePeerAgents(cfg, currentAgentId)) {
    const peerWorkspace = resolveWorkspaceDir(cfg, peerId);
    if (peerWorkspace) roots.add(peerWorkspace);
  }
  return Array.from(roots);
}

function resolveEnabledAgents(cfg, pluginConfig) {
  const configured = Array.isArray(pluginConfig?.enabledAgents)
    ? pluginConfig.enabledAgents.map((value) => normalizeString(value)).filter(Boolean)
    : [];
  if (configured.length > 0) return new Set(configured);
  return new Set(listConfiguredAgentIds(cfg));
}

function canDelegateToOtherAgents(cfg, currentAgentId) {
  const allowAgents = resolveDelegationAllowAgents(cfg, currentAgentId);
  if (!allowAgents.length) return false;
  return resolveAllowedExecutorAgents(cfg, currentAgentId).length > 0;
}

function looksLikeAwaitingUserInputReply(text) {
  const normalized = normalizeString(text).toLowerCase();
  if (!normalized) return false;
  return AWAITING_USER_INPUT_PATTERNS.some((pattern) => normalized.includes(pattern.toLowerCase()));
}

function shouldTreatVisibleReplyAsFinalDelivery(text) {
  const normalized = normalizeString(text);
  if (!normalized) return false;
  if (looksLikeAwaitingUserInputReply(normalized)) return false;
  return FINAL_DELIVERY_PATTERNS.some((pattern) => normalized.includes(pattern));
}

function looksLikeUnverifiedExecutionClaim(text) {
  const normalized = normalizeString(text).toLowerCase();
  if (!normalized) return false;
  const executionSignal = UNVERIFIED_EXECUTION_PATTERNS.some((pattern) => normalized.includes(pattern.toLowerCase()));
  if (!executionSignal) return false;
  return FOLLOWUP_SUMMARY_PATTERNS.some((pattern) => normalized.includes(pattern.toLowerCase()));
}

function looksLikeMarketResearchTask(prompt) {
  const text = sanitizeTaskPrompt(prompt).toLowerCase();
  if (!text) return false;
  return /(\ba股\b|\b港股\b|\b美股\b|股市|大盘|走势|行情|指数|板块|投资|研判|宏观|策略|仓位|资产|基金|债券|期货|外汇|黄金|原油|加密|比特币|etf|财报|cpi|非农|联储|伊朗|美国|地缘|news|market|macro|stocks?|equity|fed|inflation|oil|gold)/i.test(text);
}

function looksLikeDeliveryManagementTask(prompt) {
  const text = sanitizeTaskPrompt(prompt).toLowerCase();
  if (!text) return false;
  return /(进展|汇报|排期|推进|协调|督办|负责人|里程碑|验收|跟进|同步|风险|管理|安排|项目状态|project|timeline|owner|delivery)/i.test(text);
}

function requiresMultiPartyEvidence(prompt) {
  const text = sanitizeTaskPrompt(prompt).toLowerCase();
  if (!text) return false;
  const participantSignal = /(每个人|每位|各自|逐个|分别|大家|所有人|全员|一人一条|每个agent|每个 agent|everyone|every agent|each agent|each member|all agents|all teammates|individually|separately)/i.test(text);
  const reportingSignal = /(汇报|同步|反馈|回复|说明|职责|分工|状态|进展|当前在做|report|reply|respond|share|status|role|responsibilit|ownership|update)/i.test(text);
  return participantSignal && reportingSignal;
}

function isEngineeringPrompt(prompt, pluginConfig) {
  const text = sanitizeTaskPrompt(prompt).toLowerCase();
  if (!text) return false;
  const normalized = text.replace(/\s+/g, " ").trim();
  if (!normalized) return false;

  const trivialPatterns = [
    /^(hi|hello|hey|thanks|thank you|ok|okay|sure|got it|收到|好的|好|行|嗯|哦|谢谢)[!. ]*$/i,
    /^(heartbeat_ok|no_reply)$/i
  ];
  if (trivialPatterns.some((pattern) => pattern.test(normalized))) return false;

  const taskKeywords = Array.isArray(pluginConfig?.taskKeywords)
    ? pluginConfig.taskKeywords.map((value) => normalizeString(value).toLowerCase()).filter(Boolean)
    : [];
  if (taskKeywords.some((keyword) => normalized.includes(keyword))) return true;

  const actionablePatterns = [
    /\b(check|look|find|search|investigate|analyze|analyse|compare|summarize|report|review|fix|implement|continue|track|verify|prepare|draft|research|plan|deliver)\b/i,
    /(查一下|看一下|看下|帮我|继续|跟进|汇总|分析|判断|研究|整理|排查|修复|实现|准备|追踪|比较|总结|汇报|核实|确认|推进|处理)/i
  ];
  if (actionablePatterns.some((pattern) => pattern.test(normalized))) return true;

  const executionPatterns = [
    /\b(e2e|acceptance|execute|execution|actually execute|write(?:\s+to)?\s+\/|file content|confirm file|verify file|real task|real run)\b/i,
    /(真实|实测|验收|实际执行|写入文本|写文件|落文件|文件内容|确认文件|核对文件|e2e|端到端)/i
  ];
  if (executionPatterns.some((pattern) => pattern.test(normalized))) return true;

  const tokenCount = tokenizeText(normalized).length;
  if (tokenCount >= 4) return true;
  if (normalized.length >= 12) return true;
  return false;
}

function inferExecutorCandidates(cfg, currentAgentId, prompt, pluginConfig = null) {
  const taskPrompt = sanitizeTaskPrompt(prompt);
  const promptTokens = new Set(tokenizeText(taskPrompt));
  const engineeringTask = isEngineeringPrompt(taskPrompt, {});
  const codeExecutionTask = /(code|coding|developer|development|engineer|engineering|bug|fix|repo|execute|execution|e2e|acceptance|write file|file content|开发|代码|工程|修复|执行|验收|写文件|文件内容|写入文本)/i.test(taskPrompt);
  const marketResearchTask = looksLikeMarketResearchTask(taskPrompt);
  const deliveryManagementTask = looksLikeDeliveryManagementTask(taskPrompt);
  const configuredCodeExecutors = new Set(resolveConfiguredCodeExecutorAgentIds(cfg, currentAgentId, pluginConfig));
  return resolveAllowedExecutorAgents(cfg, currentAgentId)
    .map((agentId) => {
      const identity = resolveAgentIdentity(cfg, agentId);
      const identityText = [identity.name, identity.theme, identity.toolProfile].filter(Boolean).join(" ");
      const identityTokens = new Set(tokenizeText([agentId, identityText].filter(Boolean).join(" ")));
      let score = 0;
      for (const token of promptTokens) {
        if (identityTokens.has(token)) score += 4;
      }
      if ((identity.toolProfile === "coding" || identity.toolProfile === "full") && codeExecutionTask) score += 3;
      if (configuredCodeExecutors.has(agentId) && codeExecutionTask) score += 100;
      if (configuredCodeExecutors.has(agentId) && engineeringTask && !deliveryManagementTask) score += 40;
      if (/(code|coding|developer|development|engineer|engineering|bug|fix|repo|开发|代码|工程|修复)/i.test(identityText) && codeExecutionTask) score += 5;
      if (/(research|analyst|analysis|macro|market|trading|finance|investment|investing|投资|研究|行情|宏观|策略|资产)/i.test(identityText) && marketResearchTask) score += 8;
      if (/(manager|management|project|delivery|coordination|operations|督办|项目|协调|推进|管理|交付)/i.test(identityText) && deliveryManagementTask) score += 7;
      return { agentId, identity, score };
    })
    .sort((a, b) => b.score - a.score || a.agentId.localeCompare(b.agentId));
}

function slugifyLabel(value) {
  const normalized = normalizeString(value)
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fff]+/gi, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  return normalized.slice(0, MAX_LABEL_LENGTH) || "task";
}

function buildSpawnSuggestion(cfg, currentAgentId, prompt, pluginConfig = null) {
  const task = sanitizeTaskPrompt(prompt) || "Handle the requested task.";
  const shortPrompt = tokenizeText(task).length <= 2 && task.length <= 12;
  const roleSignal =
    looksLikeMarketResearchTask(task) ||
    looksLikeDeliveryManagementTask(task) ||
    /(code|coding|dev|engineer|bug|fix|repo|开发|代码|工程|修复)/i.test(task);
  if (shortPrompt && !roleSignal) return null;
  const [topCandidate] = inferExecutorCandidates(cfg, currentAgentId, prompt, pluginConfig);
  if (!topCandidate || Number(topCandidate.score || 0) < 4) return null;
  return {
    agentId: topCandidate.agentId,
    label: slugifyLabel(task),
    task,
    theme: topCandidate.identity.theme,
    name: topCandidate.identity.name
  };
}

function classifyOrchestrationMode(cfg, currentAgentId, prompt, pluginConfig = null) {
  const task = sanitizeTaskPrompt(prompt);
  if (!task) return "solo";
  if (/heartbeat_ok|read heartbeat\.md|nothing needs attention/i.test(task)) return "solo";
  if (requiresMultiPartyEvidence(task)) return "multi_party_required";
  const coordinatorAgentId = resolveCoordinatorAgentId(cfg, pluginConfig);
  const spawn = buildSpawnSuggestion(cfg, currentAgentId, task, pluginConfig);
  const explicitExecutionSignal = /(code|coding|developer|development|engineer|engineering|bug|fix|repo|build|test run|execute|execution|e2e|acceptance|write file|file content|开发|代码|工程|修复|构建|测试|执行|实测|验收|写文件|文件内容|写入文本)/i.test(task);
  const explicitDelegationSignal = /(sub[\s-]?agent|child agent|delegate|delegation|spawn|让.+agent|让合适的子 agent|子 agent|子agent|委派|协同)/i.test(task);
  if (
    spawn?.agentId &&
    spawn.agentId !== currentAgentId &&
    (explicitExecutionSignal || explicitDelegationSignal) &&
    (!coordinatorAgentId || currentAgentId === coordinatorAgentId)
  ) {
    return "delegate_once";
  }
  return "solo";
}

function buildOrchestrationPlan(cfg, currentAgentId, prompt, pluginConfig = null) {
  const mode = classifyOrchestrationMode(cfg, currentAgentId, prompt, pluginConfig);
  const task = sanitizeTaskPrompt(prompt);
  const allowedPeers = resolveAllowedExecutorAgents(cfg, currentAgentId);
  const spawn = buildSpawnSuggestion(cfg, currentAgentId, task, pluginConfig);
  const targetAgentIds =
    mode === "multi_party_required"
      ? allowedPeers.slice(0, 4)
      : (spawn?.agentId ? [spawn.agentId] : []);
  const requiredEvidenceCount =
    mode === "multi_party_required"
      ? Math.max(2, Math.min(targetAgentIds.length || 2, 4))
      : mode === "delegate_once"
        ? 1
        : 0;
  const routeHint =
    mode === "multi_party_required"
      ? "先检查可复用 teammate session，再至少发起多路真实协同。"
      : mode === "delegate_once"
        ? "先检查可复用 teammate session，再至少完成一次真实委派。"
        : "主控可自主完成；如出现明确分工需求再转协同。";
  const finishCondition =
    mode === "multi_party_required"
      ? `至少保留 ${requiredEvidenceCount} 份独立 teammate evidence 后才能完成。`
      : mode === "delegate_once"
        ? "至少保留 1 份 child evidence 后才能完成。"
        : "主控完成内部检查或直接给出最终答复即可完成。";
  const summary =
    mode === "multi_party_required"
      ? `链路规划：多方协同，目标 ${targetAgentIds.join(", ") || "待路由"}；${finishCondition}`
      : mode === "delegate_once"
        ? `链路规划：单次委派，目标 ${targetAgentIds[0] || "待路由"}；${finishCondition}`
        : `链路规划：自主完成；${finishCondition}`;
  return {
    mode,
    targetAgentIds,
    requiredEvidenceCount,
    routeHint,
    finishCondition,
    summary
  };
}

function classifyMissionEntryMode(cfg, currentAgentId, prompt, pluginConfig = null) {
  const task = sanitizeTaskPrompt(prompt);
  if (!task) return "plain";
  if (/heartbeat_ok|read heartbeat\.md|nothing needs attention/i.test(task)) return "plain";
  if (!isEngineeringPrompt(task, pluginConfig)) return "plain";
  const mode = classifyOrchestrationMode(cfg, currentAgentId, task, pluginConfig);
  if (mode === "delegate_once" || mode === "multi_party_required") return "mission-flow";
  if (/(任务状态|当前任务|安排|汇报|同步|跟进|负责人|排期|里程碑|验收|全员|每个人|职责|分工|project status|assignment|delivery)/i.test(task)) return "mission-flow";
  return "mission-lite";
}

function buildChainAssessment(state) {
  const entryMode = normalizeString(state?.entryMode);
  const mode = normalizeString(state?.orchestrationMode);
  const targets = Array.isArray(state?.orchestrationPlan?.targetAgentIds) ? state.orchestrationPlan.targetAgentIds.filter(Boolean) : [];
  const routeHint = normalizeString(state?.orchestrationPlan?.routeHint);
  const finishCondition = normalizeString(state?.orchestrationPlan?.finishCondition);
  const evidenceCount = Number(state?.durable?.receivedEvidenceCount || 0);
  if (entryMode === "plain") {
    return {
      code: "plain-bypass",
      summary: "简单任务，已绕过 mission-deck 编排。",
      missing: "",
      nextAction: "主控可直接处理。",
      correct: true
    };
  }
  if (mode === "solo") {
    return {
      code: "solo-correct",
      summary: normalizeString(state?.parentRunId)
        ? "这是执行子任务，当前链路应直接执行并回报父任务。"
        : "这是单人处理链路，不需要额外协同。",
      missing: "",
      nextAction: finishCondition || "继续本地执行。",
      correct: true
    };
  }
  if (!state?.internalCoordinationSeen && !state?.executionLaneSeen) {
    return {
      code: "needs-routing",
      summary: `当前链路还没进入真实协同，目标应先路由到 ${targets.join(", ") || "合适执行者"}。`,
      missing: "缺少首次路由动作",
      nextAction: routeHint || "先 sessions_list / agents_list，再 sessions_send 或 sessions_spawn。",
      correct: false
    };
  }
  if (mode === "delegate_once" && evidenceCount < 1) {
    return {
      code: "awaiting-evidence",
      summary: "已进入委派链路，但还没有首次真实协同证据。",
      missing: "缺少 child evidence",
      nextAction: "等待或获取子任务回执后再汇总。",
      correct: false
    };
  }
  if (mode === "multi_party_required" && evidenceCount < Math.max(2, Number(state?.orchestrationPlan?.requiredEvidenceCount || 0) || 2)) {
    return {
      code: "partial-collaboration",
      summary: "多方协同已开始，但独立证据仍不足。",
      missing: "缺少足量 teammate evidence",
      nextAction: "继续补齐多方反馈，再统一汇总。",
      correct: false
    };
  }
  return {
    code: "correct",
    summary: "当前任务链路方向正确，正在按计划推进。",
    missing: "",
    nextAction: normalizeString(state?.flowCurrentStep) || finishCondition || "继续推进当前步骤。",
    correct: true
  };
}

function describeSessionKey(sessionKey) {
  const normalized = normalizeString(sessionKey);
  if (!normalized) return {
    sessionScope: "",
    targetKind: ""
  };
  const parts = normalized.split(":");
  const sessionScope = parts[2] || "";
  let targetKind = sessionScope || "session";
  if (sessionScope === "feishu" || sessionScope === "openclaw-weixin" || sessionScope === "telegram") {
    targetKind = "persistent-channel-session";
  } else if (sessionScope === "subagent") {
    targetKind = "subagent-session";
  } else if (sessionScope === "cron") {
    targetKind = "cron-session";
  }
  return { sessionScope, targetKind };
}

function extractAgentIdFromSessionKey(sessionKey) {
  const normalized = normalizeString(sessionKey);
  const match = normalized.match(/^agent:([^:]+):/);
  return normalizeString(match?.[1]);
}

function getMessageText(params) {
  if (!params || typeof params !== "object") return "";
  return normalizeString(params.text ?? params.message ?? params.body ?? params.content);
}

function readToolResultDetails(event) {
  const candidates = [
    event?.result,
    event?.result?.details,
    event?.details,
    event?.message?.details
  ];
  const merged = {};
  for (const candidate of candidates) {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) continue;
    Object.assign(merged, candidate);
  }
  return merged;
}

function extractDispatchTarget(toolName, params, details) {
  const normalizedToolName = normalizeString(toolName).toLowerCase();
  if (normalizedToolName === "sessions_spawn") {
    const childSessionKey = normalizeString(details?.childSessionKey);
    const sessionMeta = describeSessionKey(childSessionKey);
    return {
      agentId: normalizeString(params?.agentId) || extractAgentIdFromSessionKey(childSessionKey),
      childSessionKey,
      runId: normalizeString(details?.runId),
      label: normalizeString(params?.label),
      task: sanitizeTaskPrompt(params?.task),
      routeType: "spawn",
      sessionScope: sessionMeta.sessionScope,
      targetKind: sessionMeta.targetKind || "spawned-run"
    };
  }
  if (normalizedToolName === "sessions_send") {
    const childSessionKey = normalizeString(details?.sessionKey) || normalizeString(params?.sessionKey);
    const sessionMeta = describeSessionKey(childSessionKey);
    return {
      agentId: normalizeString(params?.agentId) || extractAgentIdFromSessionKey(childSessionKey),
      childSessionKey,
      runId: normalizeString(details?.runId),
      label: normalizeString(params?.label),
      task: sanitizeTaskPrompt(normalizeString(params?.task) || getMessageText(params)),
      routeType: "send",
      sessionScope: sessionMeta.sessionScope,
      targetKind: sessionMeta.targetKind || "existing-session"
    };
  }
  return null;
}

function classifyDispatchResult(toolName, details, dispatch = null) {
  const normalizedToolName = normalizeString(toolName).toLowerCase();
  const status = normalizeString(details?.status).toLowerCase();
  const error = normalizeString(details?.error);
  const failureStatuses = new Set(["error", "failed", "forbidden", "rejected", "denied", "cancelled"]);
  if (normalizedToolName === "sessions_spawn") {
    if (status === "accepted") return { track: true, phase: "accepted", failed: false };
    if (!status && (dispatch?.childSessionKey || dispatch?.runId)) return { track: true, phase: "accepted", failed: false };
    if (failureStatuses.has(status)) {
      return { track: false, phase: status, failed: true, reason: error || status };
    }
    return { track: false, phase: status || "unknown", failed: false };
  }
  if (normalizedToolName === "sessions_send") {
    if (["ok", "pending", "accepted"].includes(status)) return { track: true, phase: status, failed: false };
    if (!status && dispatch?.childSessionKey) return { track: true, phase: "sent", failed: false };
    if (status === "timeout") {
      return {
        track: false,
        phase: status,
        failed: false,
        reason: "sessions_send timed out before traceable delivery was confirmed"
      };
    }
    if (failureStatuses.has(status)) return { track: false, phase: status, failed: true, reason: error || status };
    return { track: false, phase: status || "unknown", failed: false };
  }
  if (failureStatuses.has(status)) return { track: false, phase: status, failed: true, reason: error || status };
  return { track: false, phase: status || "unknown", failed: false };
}

function inferTaskRuntime(toolName) {
  return normalizeString(toolName).toLowerCase() === "sessions_spawn" ? "subagent" : "acp";
}

function looksLikeEntrypointEscalation(params, pluginConfig) {
  const flat = toFlatText(params).toLowerCase();
  if (!flat) return false;
  const patterns = Array.isArray(pluginConfig?.entrypointPatterns) && pluginConfig.entrypointPatterns.length > 0
    ? pluginConfig.entrypointPatterns
    : DEFAULT_ENTRYPOINT_PATTERNS;
  return patterns.some((pattern) => flat.includes(normalizeString(pattern).toLowerCase()));
}

function looksLikeWorkspaceDiscoveryTool(toolName, params, workspaceRoots, pluginConfig) {
  const allowedNames = toLowerSet(
    Array.isArray(pluginConfig?.discoveryToolNames) && pluginConfig.discoveryToolNames.length > 0
      ? pluginConfig.discoveryToolNames
      : DEFAULT_DISCOVERY_TOOL_NAMES
  );
  const normalizedToolName = normalizeString(toolName).toLowerCase();
  if (!allowedNames.has(normalizedToolName)) return false;
  const flat = toFlatText(params).toLowerCase();
  return workspaceRoots.some((root) => flat.includes(root.toLowerCase()));
}

function shouldForceSpawnInsteadOfSend(currentAgentId, params) {
  const targetAgentId = normalizeString(params?.agentId);
  const hasSessionKey = hasNonEmptyString(params?.sessionKey);
  const hasLabel = hasNonEmptyString(params?.label);
  if (!targetAgentId || targetAgentId === currentAgentId) return false;
  if (hasSessionKey) return false;
  return hasLabel;
}

function looksLikeExplicitIsolationNeed(params, prompt = "") {
  const runtime = normalizeString(params?.runtime).toLowerCase();
  const mode = normalizeString(params?.mode).toLowerCase();
  const flat = `${toFlatText(params)} ${sanitizeTaskPrompt(prompt)}`.toLowerCase();
  if (runtime === "acp") return true;
  if (["run", "session"].includes(mode) && /(acp|worker|subagent|后台|background)/i.test(flat)) return true;
  return /(parallel|isolate|isolated|background|worker|subagent|sandbox|独立|隔离|并行|后台|专项|专线|子任务|子线程)/i.test(flat);
}

function buildCoordinationGuidance({ agentId, cfg, pluginConfig, prompt, entryMode = "", orchestrationPlan = null }) {
  const workspaceRoots = resolveWorkspaceRoots(cfg, agentId, pluginConfig);
  const peers = resolveAllowedExecutorAgents(cfg, agentId);
  const a2a = resolveA2APolicy(cfg);
  const coordinatorAgentId = resolveCoordinatorAgentId(cfg, pluginConfig);
  const lines = [
    "You are running under the Team Orchestrator plugin.",
    "Treat hooks as event adapters and TaskFlow as the durable source of truth.",
    "Normalize the request, choose the correct route, and keep final completion gated by evidence.",
    "sessions_send only targets an existing session and requires sessionKey or label.",
    "Use sessions_send to continue a visible reusable teammate session.",
    "Use sessions_spawn only when you intentionally need a new isolated work lane."
  ];
  if (entryMode) lines.push(`Entry mode for this run: ${entryMode}.`);
  if (orchestrationPlan?.summary) lines.push(`Orchestration plan: ${normalizeString(orchestrationPlan.summary)}`);
  if (orchestrationPlan?.routeHint) lines.push(`Route hint: ${normalizeString(orchestrationPlan.routeHint)}`);
  if (orchestrationPlan?.finishCondition) lines.push(`Finish condition: ${normalizeString(orchestrationPlan.finishCondition)}`);
  if (peers.length > 0) lines.push(`Configured peer agents: ${peers.join(", ")}.`);
  if (coordinatorAgentId) lines.push(`Configured coordinator for root orchestration: ${coordinatorAgentId}.`);
  if (workspaceRoots.length > 0) lines.push(`Known team workspaces from config: ${workspaceRoots.join(", ")}.`);
  if (a2a.enabled) lines.push("Agent-to-agent messaging is enabled.");
  const spawnSuggestion = buildSpawnSuggestion(cfg, agentId, prompt, pluginConfig);
  if (spawnSuggestion) {
    lines.push(
      `Recommended internal executor for this task: ${spawnSuggestion.agentId}.`,
      `Preferred sessions_spawn payload: ${JSON.stringify({ agentId: spawnSuggestion.agentId, label: spawnSuggestion.label, task: spawnSuggestion.task })}`
    );
  }
  return lines.join("\n");
}

function buildExecutionMandate(cfg, agentId, prompt, flowId, pluginConfig = null, options = {}) {
  const spawn = buildSpawnSuggestion(cfg, agentId, prompt, pluginConfig);
  const lines = [
    "Execution mandate for this run:",
    "1. Perform an internal action immediately.",
    "2. Keep coordination traceable through TaskFlow and structured child evidence.",
    "3. Do not treat an assistant summary as completion unless evidence and finalize conditions are satisfied."
  ];
  if (options?.entryMode) lines.push(`Run mode: ${normalizeString(options.entryMode)}.`);
  if (flowId) lines.push(`Current TaskFlow flowId=${flowId}.`);
  if (options?.orchestrationPlan?.finishCondition) {
    lines.push(`Finish condition: ${normalizeString(options.orchestrationPlan.finishCondition)}`);
  }
  if (spawn) {
    lines.push(`Default executor for this task: ${spawn.agentId}.`);
  }
  return lines.join("\n");
}

function extractAssistantText(message) {
  if (!message || typeof message !== "object") return "";
  if (message.role !== "assistant") return "";
  const content = Array.isArray(message.content) ? message.content : [];
  return content
    .filter((item) => item && typeof item === "object" && item.type === "text" && typeof item.text === "string")
    .map((item) => item.text)
    .join("\n")
    .trim();
}

function rewriteAssistantTextMessage(message, text) {
  if (!message || typeof message !== "object" || message.role !== "assistant") return message;
  const content = Array.isArray(message.content) ? message.content : [];
  let replaced = false;
  const nextContent = content.map((item) => {
    if (!replaced && item && typeof item === "object" && item.type === "text" && typeof item.text === "string") {
      replaced = true;
      return { ...item, text };
    }
    return item;
  });
  if (!replaced) nextContent.push({ type: "text", text });
  return { ...message, content: nextContent };
}

function isSilentReply(text) {
  return normalizeString(text).toUpperCase() === SILENT_REPLY_TOKEN;
}

function getRuntimeTaskFlow(api, ctx) {
  const sessionKey = normalizeString(ctx?.sessionKey);
  if (!sessionKey) return null;
  const runtime = api.runtime?.tasks?.flow ?? api.runtime?.taskFlow;
  if (!runtime || typeof runtime.bindSession !== "function") return null;
  return runtime.bindSession({ sessionKey });
}

function hasAnyInternalExecutionStep(state) {
  return Boolean(
    state?.internalCoordinationSeen ||
    state?.workspaceDiscoverySeen ||
    state?.dispatchAttempted ||
    state?.executionLaneSeen
  );
}

function appendTimelineEvent(state, entry = {}) {
  if (!state) return;
  const timestamp = normalizeString(entry.timestamp) || isoNow();
  const role = normalizeString(entry.role);
  const owner = normalizeString(entry.owner);
  const text = normalizeString(entry.text);
  if (!role || !text) return;
  state.timelineEvents = Array.isArray(state.timelineEvents) ? state.timelineEvents : [];
  const nextEvent = {
    timestamp,
    role,
    owner,
    text: text.slice(0, 2000),
    tone: normalizeString(entry.tone)
  };
  const last = state.timelineEvents.at(-1);
  if (last && last.role === nextEvent.role && last.owner === nextEvent.owner && last.text === nextEvent.text) return;
  state.timelineEvents.push(nextEvent);
  state.timelineEvents = state.timelineEvents.slice(-40);
}

function setRunTelemetry(state, eventName, extra = {}) {
  if (!state.dashboardStartedAt) state.dashboardStartedAt = isoNow();
  state.dashboardUpdatedAt = isoNow();
  state.lastEvent = normalizeString(eventName);
  if (normalizeString(eventName) !== "supervisor_intervention") state.supervisorPending = false;
  if (hasNonEmptyString(extra.toolName)) state.lastToolName = normalizeString(extra.toolName);
  if (hasNonEmptyString(extra.toolStatus)) state.lastToolStatus = normalizeString(extra.toolStatus);
  if (hasNonEmptyString(extra.externalMessage)) state.lastExternalMessage = normalizeString(extra.externalMessage).slice(0, 280);
  if (hasNonEmptyString(extra.blockReason)) state.lastBlockReason = normalizeString(extra.blockReason).slice(0, 280);
  state.activityTrail = Array.isArray(state.activityTrail) ? state.activityTrail : [];
  state.activityTrail.push({
    timestamp: state.dashboardUpdatedAt,
    event: normalizeString(eventName),
    toolName: normalizeString(extra.toolName),
    toolStatus: normalizeString(extra.toolStatus),
    externalMessage: normalizeString(extra.externalMessage).slice(0, 280),
    blockReason: normalizeString(extra.blockReason).slice(0, 280)
  });
  state.activityTrail = state.activityTrail.slice(-16);
}

function buildSupervisorIntervention(state, options = {}, nowMs = Date.now()) {
  const idleMinutes = Math.max(1, Number(options.interventionIdleMinutes) || 30);
  const supervisorAgentId = normalizeString(options.supervisorAgentId);
  if (!state?.engineeringTask) return null;
  if (!normalizeString(state?.flowId)) return null;
  if (normalizeString(state?.parentRunId)) return null;
  const flowStatus = normalizeString(state?.flowStatus).toLowerCase();
  const waitingLike = flowStatus === "waiting" || flowStatus === "blocked" || hasNonEmptyString(state?.lastBlockReason);
  if (!waitingLike) return null;
  if (looksLikeAwaitingUserInputReply(state?.lastExternalMessage)) return null;
  const lastUpdateMs = Date.parse(normalizeString(state?.dashboardUpdatedAt) || normalizeString(state?.dashboardStartedAt));
  if (!Number.isFinite(lastUpdateMs)) return null;
  const idleMs = Math.max(0, nowMs - lastUpdateMs);
  if (idleMs < idleMinutes * 60_000) return null;
  const lastInterventionMs = Date.parse(normalizeString(state?.supervisorLastInterventionAt));
  if (Number.isFinite(lastInterventionMs) && nowMs - lastInterventionMs < idleMinutes * 60_000) return null;
  const reason = normalizeString(state?.lastBlockReason) ||
    normalizeString(state?.flowWaitSummary) ||
    (flowStatus === "blocked" ? "flow is blocked without follow-up" : "flow has been waiting without progress");
  return {
    supervisorAgentId,
    idleMinutes: Number((idleMs / 60_000).toFixed(1)),
    reason
  };
}

function defaultRunState() {
  return {
    agentId: "",
    ownerAgentId: "",
    sessionKey: "",
    promptText: "",
    normalizedPromptText: "",
    engineeringTask: false,
    entryMode: "plain",
    orchestrationMode: "solo",
    orchestrationPlan: null,
    normalizedEvent: null,
    durable: null,
    chainAssessment: null,
    internalCoordinationSeen: false,
    workspaceDiscoverySeen: false,
    executionLaneSeen: false,
    dispatchAttempted: false,
    taskFlowSeen: false,
    userVisibleMessageSent: false,
    flowId: "",
    flowRevision: 0,
    flowStatus: "",
    flowCurrentStep: "",
    flowWaitSummary: "",
    flowTaskSummary: null,
    childTaskIds: [],
    childTasks: [],
    supervisorPending: false,
    supervisorAgentId: "",
    supervisorReason: "",
    supervisorLastInterventionAt: "",
    supervisorInterventionCount: 0,
    parentRunId: "",
    parentFlowId: "",
    parentTaskId: "",
    parentSessionKey: "",
    parentAgentId: "",
    lastToolName: "",
    lastToolStatus: "",
    lastEvent: "",
    lastExternalMessage: "",
    lastBlockReason: "",
    pendingDispatches: new Map(),
    activityTrail: [],
    timelineEvents: [],
    dashboardStartedAt: "",
    dashboardUpdatedAt: ""
  };
}

function detectPromptDirective(prompt) {
  const normalized = sanitizeTaskPrompt(prompt).toLowerCase();
  if (normalized.startsWith("/reset") || normalized.startsWith("reset ")) return EVENT_TYPES.RESET_TASK;
  if (normalized.startsWith("/new") || normalized.startsWith("new task")) return EVENT_TYPES.NEW_TASK;
  return "";
}

function classifyIncomingEvent({ hookName, event = {}, ctx = {}, runState = null, parentLink = null }) {
  const runId = normalizeString(ctx?.runId);
  const synthetic = runId.startsWith("announce:v1:");
  if (synthetic) return EVENT_TYPES.SYSTEM_ANNOUNCE;
  if (hookName === "before_prompt_build") {
    const directive = detectPromptDirective(event.prompt);
    if (directive) return directive;
    if (normalizeString(runState?.flowId)) return EVENT_TYPES.RESUME_TASK;
    return EVENT_TYPES.NEW_TASK;
  }
  if (hookName === "before_tool_call") return EVENT_TYPES.TOOL_REQUEST;
  if (hookName === "after_tool_call") return EVENT_TYPES.TOOL_RESULT;
  if (hookName === "before_message_write") {
    const text = extractAssistantText(event?.message);
    if (parentLink) return EVENT_TYPES.CHILD_REPORT;
    if (shouldTreatVisibleReplyAsFinalDelivery(text)) return EVENT_TYPES.FINALIZE_CANDIDATE;
    return EVENT_TYPES.PROGRESS_UPDATE;
  }
  if (hookName === "agent_end") return EVENT_TYPES.AGENT_ENDED;
  return EVENT_TYPES.PROGRESS_UPDATE;
}

function buildCanonicalEvent({ hookName, event = {}, ctx = {}, runState = null, parentLink = null }) {
  const eventType = classifyIncomingEvent({ hookName, event, ctx, runState, parentLink });
  const runId = normalizeString(ctx?.runId);
  const agentId = normalizeString(ctx?.agentId);
  const sessionKey = normalizeString(ctx?.sessionKey);
  const promptText = sanitizeTaskPrompt(event?.prompt);
  const assistantText = extractAssistantText(event?.message);
  const details = readToolResultDetails(event);
  return {
    eventType,
    runId,
    agentId,
    sessionKey,
    sourceKind:
      eventType === EVENT_TYPES.SYSTEM_ANNOUNCE ? "system" :
      eventType === EVENT_TYPES.TOOL_REQUEST || eventType === EVENT_TYPES.TOOL_RESULT ? "tool" :
      parentLink ? "child" : "user",
    isSynthetic: eventType === EVENT_TYPES.SYSTEM_ANNOUNCE,
    parentRunId: normalizeString(parentLink?.parentRunId) || normalizeString(runState?.parentRunId) || null,
    parentFlowId: normalizeString(parentLink?.parentFlowId) || normalizeString(runState?.parentFlowId) || null,
    timestamp: isoNow(),
    payload: {
      promptText,
      toolName: normalizeString(event?.toolName),
      toolCallId: normalizeString(event?.toolCallId),
      params: event?.params ?? null,
      result: event?.result ?? null,
      details,
      assistantText,
      messageText: getMessageText(event?.params),
      parentTaskId: normalizeString(parentLink?.childTaskId) || normalizeString(runState?.parentTaskId) || null,
      childRunId: normalizeString(parentLink?.childRunId),
      childSessionKey: normalizeString(parentLink?.childSessionKey)
    }
  };
}

function buildCanonicalFlowState({ runId, sessionKey, parentLink = null, entryMode = "plain", orchestrationMode = "solo", orchestrationPlan = null }) {
  return {
    schemaVersion: 1,
    state: FLOW_STATES.INTAKE,
    entryMode,
    orchestrationMode,
    orchestrationPlan: orchestrationPlan ? {
      mode: normalizeString(orchestrationPlan.mode),
      targetAgentIds: Array.isArray(orchestrationPlan.targetAgentIds) ? orchestrationPlan.targetAgentIds.slice(0, 8) : [],
      requiredEvidenceCount: Number(orchestrationPlan.requiredEvidenceCount || 0),
      routeHint: normalizeString(orchestrationPlan.routeHint),
      finishCondition: normalizeString(orchestrationPlan.finishCondition),
      summary: normalizeString(orchestrationPlan.summary)
    } : null,
    rootRunId: normalizeString(parentLink?.parentRunId) || normalizeString(runId),
    rootSessionKey: normalizeString(parentLink?.parentSessionKey) || normalizeString(sessionKey),
    parentRunId: normalizeString(parentLink?.parentRunId),
    parentFlowId: normalizeString(parentLink?.parentFlowId),
    parentTaskId: normalizeString(parentLink?.childTaskId),
    parentSessionKey: normalizeString(parentLink?.parentSessionKey),
    childTasks: [],
    childSessions: [],
    requiredEvidenceCount: Number(orchestrationPlan?.requiredEvidenceCount || 0),
    receivedEvidenceCount: 0,
    retryCount: 0,
    maxRetry: 2,
    lastFailureKind: "",
    lastFailureReason: "",
    finalizeCandidate: null,
    finalOutput: null,
    auditTrail: []
  };
}

function cloneSimple(value) {
  return JSON.parse(JSON.stringify(value));
}

function recordAuditEntry(flowState, canonicalEvent, summary = "") {
  const durable = flowState && typeof flowState === "object" ? flowState : {};
  const auditTrail = Array.isArray(durable.auditTrail) ? durable.auditTrail.slice(-31) : [];
  auditTrail.push({
    timestamp: normalizeString(canonicalEvent?.timestamp) || isoNow(),
    eventType: normalizeString(canonicalEvent?.eventType),
    summary: normalizeString(summary)
  });
  durable.auditTrail = auditTrail.slice(-32);
  return durable;
}

function buildDurableFlowStatePayload(existingState, patch = {}, canonicalEvent = null, summary = "") {
  const durable = cloneSimple(existingState || {});
  Object.assign(durable, patch);
  if (canonicalEvent) recordAuditEntry(durable, canonicalEvent, summary);
  return durable;
}

function applyDurableFlowToRun(state, flow = null) {
  if (!state) return state;
  const durable = flow?.stateJson && typeof flow.stateJson === "object"
    ? cloneSimple(flow.stateJson)
    : (state.durable ? cloneSimple(state.durable) : null);
  state.durable = durable;
  state.flowId = normalizeString(flow?.flowId || state.flowId);
  state.flowRevision = Number(flow?.revision ?? state.flowRevision ?? 0);
  state.flowStatus = normalizeString(flow?.status || state.flowStatus);
  state.flowCurrentStep = normalizeString(flow?.currentStep || state.flowCurrentStep);
  state.flowWaitSummary = normalizeString(flow?.blockedSummary || flow?.waitJson?.summary || state.flowWaitSummary);
  state.taskFlowSeen = Boolean(state.flowId);
  if (durable) {
    state.parentRunId = normalizeString(durable.parentRunId || state.parentRunId);
    state.parentFlowId = normalizeString(durable.parentFlowId || state.parentFlowId);
    state.parentTaskId = normalizeString(durable.parentTaskId || state.parentTaskId);
    state.parentSessionKey = normalizeString(durable.parentSessionKey || state.parentSessionKey);
    state.childTasks = Array.isArray(durable.childTasks) ? cloneSimple(durable.childTasks) : [];
    state.childTaskIds = state.childTasks.map((task) => normalizeString(task?.taskId)).filter(Boolean);
  }
  return state;
}

export {
  DEFAULT_DISCOVERY_TOOL_NAMES,
  DEFAULT_ENGINEERING_KEYWORDS,
  DEFAULT_ENTRYPOINT_PATTERNS,
  EVENT_TYPES,
  EXECUTION_LANE_TOOL_NAMES,
  FLOW_STATES,
  INTERNAL_COORDINATION_TOOL_NAMES,
  MESSAGE_TOOL_NAME,
  SESSIONS_SEND_TOOL_NAME,
  SILENT_REPLY_TOKEN,
  appendTimelineEvent,
  applyDurableFlowToRun,
  buildCanonicalEvent,
  buildCanonicalFlowState,
  buildChainAssessment,
  buildCoordinationGuidance,
  buildDurableFlowStatePayload,
  buildExecutionMandate,
  buildOrchestrationPlan,
  buildSpawnSuggestion,
  buildSupervisorIntervention,
  canDelegateToOtherAgents,
  classifyDispatchResult,
  classifyIncomingEvent,
  classifyMissionEntryMode,
  classifyOrchestrationMode,
  defaultRunState,
  describeSessionKey,
  extractAssistantText,
  extractDispatchTarget,
  getMessageText,
  getRuntimeTaskFlow,
  hasAnyInternalExecutionStep,
  hasNonEmptyString,
  inferTaskRuntime,
  isEngineeringPrompt,
  isSilentReply,
  isoNow,
  looksLikeAwaitingUserInputReply,
  looksLikeUnverifiedExecutionClaim,
  looksLikeEntrypointEscalation,
  looksLikeExplicitIsolationNeed,
  looksLikeWorkspaceDiscoveryTool,
  normalizeString,
  pluginLikeWorkspaceRoots,
  readToolResultDetails,
  resolveCoordinatorAgentId,
  resolveEnabledAgents,
  resolveWorkspaceRoots,
  rewriteAssistantTextMessage,
  sanitizeTaskPrompt,
  setRunTelemetry,
  shouldForceSpawnInsteadOfSend,
  shouldTreatVisibleReplyAsFinalDelivery,
  stripPromptScaffolding
};
