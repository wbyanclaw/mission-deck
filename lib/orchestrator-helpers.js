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
  "仓库路径",
  "repo path",
  "git url",
  "project path"
];

function defaultRunState() {
  return {
    internalCoordinationSeen: false,
    workspaceDiscoverySeen: false,
    executionLaneSeen: false,
    dispatchAttempted: false,
    taskFlowSeen: false,
    userVisibleMessageSent: false,
    engineeringTask: false,
    promptText: "",
    normalizedPromptText: "",
    suggestedSpawn: null,
    flowId: "",
    flowRevision: 0,
    flowStatus: "",
    flowCurrentStep: "",
    flowWaitSummary: "",
    flowTaskSummary: null,
    childTaskIds: [],
    childTasks: [],
    pendingDispatches: new Map(),
    activityTrail: [],
    timelineEvents: []
  };
}

function normalizeString(value) {
  return typeof value === "string" ? value.trim() : "";
}

function hasNonEmptyString(value) {
  return normalizeString(value).length > 0;
}

function toLowerSet(values) {
  return new Set(
    (Array.isArray(values) ? values : [])
      .map((value) => normalizeString(value).toLowerCase())
      .filter(Boolean)
  );
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

function resolveWorkspaceDir(cfg, agentId) {
  const agentConfig = resolveAgentConfig(cfg, agentId);
  const workspace = normalizeString(agentConfig?.workspace) || normalizeString(cfg?.agents?.defaults?.workspace);
  return workspace || "";
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

function listConfiguredAgentIds(cfg) {
  return getAgentEntries(cfg).map((entry) => entry.id);
}

function resolvePeerAgents(cfg, currentAgentId) {
  return listConfiguredAgentIds(cfg).filter((agentId) => agentId !== currentAgentId);
}

function resolveAllowedExecutorAgents(cfg, currentAgentId) {
  const peers = resolvePeerAgents(cfg, currentAgentId);
  const currentAgentConfig = resolveAgentConfig(cfg, currentAgentId);
  const allowAgents = Array.isArray(currentAgentConfig?.subagents?.allowAgents)
    ? new Set(currentAgentConfig.subagents.allowAgents.map((value) => normalizeString(value)).filter(Boolean))
    : null;
  const a2a = resolveA2APolicy(cfg);
  return peers.filter((agentId) => {
    if (allowAgents && !allowAgents.has(agentId)) return false;
    if (a2a.enabled && a2a.allowed && !a2a.allowed.has(agentId)) return false;
    return true;
  });
}

function canDelegateToOtherAgents(cfg, currentAgentId) {
  const currentAgentConfig = resolveAgentConfig(cfg, currentAgentId);
  const explicitAllowAgents = Array.isArray(currentAgentConfig?.subagents?.allowAgents)
    ? currentAgentConfig.subagents.allowAgents.map((value) => normalizeString(value)).filter(Boolean)
    : [];
  if (!explicitAllowAgents.length) return false;
  return resolveAllowedExecutorAgents(cfg, currentAgentId).length > 0;
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

function inferExecutorCandidates(cfg, currentAgentId, prompt) {
  const taskPrompt = sanitizeTaskPrompt(prompt);
  const promptTokens = new Set(tokenizeText(taskPrompt));
  const engineeringTask = isEngineeringPrompt(taskPrompt, {});
  const codeExecutionTask = /(code|coding|developer|development|engineer|engineering|bug|fix|repo|开发|代码|工程|修复)/i.test(taskPrompt);
  const marketResearchTask = looksLikeMarketResearchTask(taskPrompt);
  const deliveryManagementTask = looksLikeDeliveryManagementTask(taskPrompt);
  const candidates = resolveAllowedExecutorAgents(cfg, currentAgentId)
    .map((agentId) => {
      const identity = resolveAgentIdentity(cfg, agentId);
      const identityText = [
        identity.name,
        identity.theme,
        identity.toolProfile
      ].filter(Boolean).join(" ");
      const identityTokens = new Set(tokenizeText([
        agentId,
        identityText
      ].filter(Boolean).join(" ")));
      let score = 0;
      for (const token of promptTokens) {
        if (identityTokens.has(token)) score += 4;
      }
      if (identity.toolProfile === "coding" && codeExecutionTask) score += 3;
      if (/(code|coding|developer|development|engineer|engineering|bug|fix|repo|开发|代码|工程|修复)/i.test(identityText) && codeExecutionTask) score += 5;
      if (/(research|analyst|analysis|macro|market|trading|finance|investment|investing|投资|研究|行情|宏观|策略|资产)/i.test(identityText) && marketResearchTask) score += 8;
      if (/(manager|management|project|delivery|coordination|operations|督办|项目|协调|推进|管理|交付)/i.test(identityText) && deliveryManagementTask) score += 7;
      return {
        agentId,
        identity,
        score
      };
    })
    .sort((a, b) => b.score - a.score || a.agentId.localeCompare(b.agentId));
  return candidates;
}

function slugifyLabel(value) {
  const normalized = normalizeString(value)
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fff]+/gi, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  return normalized.slice(0, MAX_LABEL_LENGTH) || "task";
}

function buildSpawnSuggestion(cfg, currentAgentId, prompt) {
  const task = sanitizeTaskPrompt(prompt) || "Handle the requested task.";
  const shortPrompt = tokenizeText(task).length <= 2 && task.length <= 12;
  const roleSignal =
    looksLikeMarketResearchTask(task) ||
    looksLikeDeliveryManagementTask(task) ||
    /(code|coding|dev|engineer|bug|fix|repo|开发|代码|工程|修复)/i.test(task);
  if (shortPrompt && !roleSignal) return null;
  const [topCandidate] = inferExecutorCandidates(cfg, currentAgentId, prompt);
  if (!topCandidate || Number(topCandidate.score || 0) < 4) return null;
  return {
    agentId: topCandidate.agentId,
    label: slugifyLabel(task),
    task,
    theme: topCandidate.identity.theme,
    name: topCandidate.identity.name
  };
}

function buildNextActionGuidance(cfg, currentAgentId, prompt) {
  const spawn = buildSpawnSuggestion(cfg, currentAgentId, prompt);
  const steps = [
    "Next required actions:",
    "1. Inspect visible teammates with agents_list or sessions_list.",
    "2. Prefer sessions_send when the teammate already has a visible reusable session so the collaboration stays visible in the primary conversation.",
    "3. Use sessions_send only when you are continuing a known existing sessionKey/label for that same teammate conversation.",
    "4. Use sessions_spawn only when you explicitly need a new isolated lane and no visible reusable session is suitable.",
    "5. Only ask the user after internal coordination and workspace discovery both fail."
  ];
  if (spawn) {
    const identityLabel = [spawn.name, spawn.theme].filter(Boolean).join(" / ");
    steps.push(
      `Recommended executor from config: ${spawn.agentId}${identityLabel ? ` (${identityLabel})` : ""}.`,
      `Example sessions_spawn payload: ${JSON.stringify({ agentId: spawn.agentId, label: spawn.label, task: spawn.task })}`
    );
  }
  return steps.join("\n");
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

function resolveEnabledAgents(cfg, pluginConfig) {
  const configured = Array.isArray(pluginConfig?.enabledAgents)
    ? pluginConfig.enabledAgents.map((value) => normalizeString(value)).filter(Boolean)
    : [];
  if (configured.length > 0) return new Set(configured);
  return new Set(listConfiguredAgentIds(cfg));
}

function pluginLikeWorkspaceRoots(cfg) {
  return arguments[1]?.agentWorkspaceRoots ?? cfg?.plugins?.entries?.["mission-deck"]?.config?.agentWorkspaceRoots ?? null;
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

function resolveA2APolicy(cfg) {
  const policy = cfg?.tools?.agentToAgent;
  const enabled = policy?.enabled === true;
  const allowed = Array.isArray(policy?.allow)
    ? new Set(policy.allow.map((value) => normalizeString(value)).filter(Boolean))
    : null;
  return { enabled, allowed };
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

  const tokenCount = tokenizeText(normalized).length;
  if (tokenCount >= 4) return true;
  if (normalized.length >= 12) return true;
  return false;
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

function buildCoordinationGuidance({ agentId, cfg, pluginConfig, prompt }) {
  const workspaceRoots = resolveWorkspaceRoots(cfg, agentId, pluginConfig);
  const peers = resolveAllowedExecutorAgents(cfg, agentId);
  const a2a = resolveA2APolicy(cfg);
  const hasPeers = peers.length > 0;
  const internalFirst = pluginConfig?.internalFirst !== false;
  const lines = [
    "You are running under the Team Orchestrator plugin.",
    "Use configuration-driven coordination, not hardcoded teammate assumptions.",
    "Before escalating missing project entrypoints to the user, prefer internal coordination and workspace discovery.",
    "sessions_send only targets an existing session and requires sessionKey or label. agentId alone is not a valid sessions_send target.",
    "Visibility rule: first look for a reusable visible teammate session; keep collaboration in that existing reusable session whenever such a session is already available.",
    "Route selection rule: use sessions_send to continue an already-existing teammate session; use sessions_spawn only when you intentionally need a new isolated work lane.",
    "If no suitable visible target session exists, create an execution lane with sessions_spawn instead of failing closed."
  ];

  if (isEngineeringPrompt(prompt, pluginConfig)) {
    lines.push("This looks like a task request that should enter TaskFlow and internal orchestration.");
  }
  if (internalFirst && hasPeers) {
    lines.push(`Configured peer agents: ${peers.join(", ")}.`);
    if (a2a.enabled) {
      lines.push("Agent-to-agent messaging is enabled. Prefer internal-first coordination before asking the user for missing repo or project entrypoints.");
    } else {
      lines.push("Agent-to-agent messaging is disabled. Use visible sessions, workspace discovery, and spawn lanes where allowed before escalating to the user.");
    }
  }
  if (workspaceRoots.length > 0) {
    lines.push(`Known team workspaces from config: ${workspaceRoots.join(", ")}.`);
  }
  const spawnSuggestion = buildSpawnSuggestion(cfg, agentId, prompt);
  if (spawnSuggestion) {
    const identityLabel = [spawnSuggestion.name, spawnSuggestion.theme].filter(Boolean).join(" / ");
    lines.push(
      `Recommended internal executor for this task: ${spawnSuggestion.agentId}${identityLabel ? ` (${identityLabel})` : ""}.`,
      `If no reusable session exists, call sessions_spawn with a payload shaped like: ${JSON.stringify({ agentId: spawnSuggestion.agentId, label: spawnSuggestion.label, task: spawnSuggestion.task })}`
    );
  }
  lines.push(
    "A good orchestration sequence is: acknowledge -> inspect visible sessions and workspaces -> prefer reusing a visible teammate session -> only open an isolated lane when necessary -> hand off concrete acceptance criteria -> report only key progress and blockers.",
    "Simple rule: first look for a reusable visible teammate session; persistent teammate conversation or follow-up on the same known session => sessions_send; only choose sessions_spawn for explicit isolation, parallelism, ACP/background workers, or when no visible reusable session exists.",
    "Do not end the turn after an acknowledgement if you have not yet attempted at least one internal coordination or workspace discovery action."
  );
  return lines.join("\n");
}

function isSilentReply(text) {
  return normalizeString(text).toUpperCase() === SILENT_REPLY_TOKEN;
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
  if (!replaced) {
    nextContent.push({ type: "text", text });
  }
  return {
    ...message,
    content: nextContent
  };
}

function getMessageText(params) {
  if (!params || typeof params !== "object") return "";
  return normalizeString(params.text ?? params.message ?? params.body ?? params.content);
}

function extractAgentIdFromSessionKey(sessionKey) {
  const normalized = normalizeString(sessionKey);
  const match = normalized.match(/^agent:([^:]+):/);
  return normalizeString(match?.[1]);
}

function describeSessionKey(sessionKey) {
  const normalized = normalizeString(sessionKey);
  if (!normalized) {
    return {
      sessionScope: "",
      targetKind: ""
    };
  }
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
  return {
    sessionScope,
    targetKind
  };
}

function getRuntimeTaskFlow(api, ctx) {
  const sessionKey = normalizeString(ctx?.sessionKey);
  if (!sessionKey) return null;
  const runtime = api.runtime?.tasks?.flow ?? api.runtime?.taskFlow;
  if (!runtime || typeof runtime.bindSession !== "function") return null;
  return runtime.bindSession({ sessionKey });
}

function inferTaskRuntime(toolName) {
  return normalizeString(toolName).toLowerCase() === "sessions_spawn" ? "subagent" : "acp";
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
    if (["ok", "pending", "accepted"].includes(status)) {
      return { track: true, phase: status, failed: false };
    }
    if (!status && dispatch?.childSessionKey) {
      return { track: true, phase: "sent", failed: false };
    }
    if (status === "timeout") {
      return {
        track: false,
        phase: status,
        failed: false,
        reason: "sessions_send timed out before traceable delivery was confirmed"
      };
    }
    if (failureStatuses.has(status)) {
      return { track: false, phase: status, failed: true, reason: error || status };
    }
    return { track: false, phase: status || "unknown", failed: false };
  }
  if (failureStatuses.has(status)) {
    return { track: false, phase: status, failed: true, reason: error || status };
  }
  return { track: false, phase: status || "unknown", failed: false };
}

function ensureManagedFlowForState(api, ctx, state) {
  if (!state?.engineeringTask) return null;
  const taskFlow = getRuntimeTaskFlow(api, ctx);
  if (!taskFlow) return null;
  let flow = state.flowId ? taskFlow.get(state.flowId) : undefined;
  if (!flow) {
    flow = taskFlow.createManaged({
      controllerId: "mission-deck",
      goal: state.promptText || "Handle the requested engineering task.",
      status: "running",
      currentStep: "triage-and-dispatch"
    });
  }
  state.flowId = normalizeString(flow?.flowId);
  state.flowRevision = Number(flow?.revision ?? 0);
  state.taskFlowSeen = Boolean(state.flowId);
  return flow ?? null;
}

function buildExecutionMandate(cfg, agentId, prompt, flowId) {
  const spawn = buildSpawnSuggestion(cfg, agentId, prompt);
  const lines = [
    "Execution mandate for this run:",
    "1. Do the work, not just the narration.",
    "2. Start with an internal action immediately: inspect visible sessions, inspect configured workspaces, or spawn the executor lane.",
    "3. First look for a visible reusable teammate session and prefer sessions_send so collaboration stays in the existing conversation.",
    "4. Use sessions_spawn only when you explicitly need isolation, background/ACP execution, or no suitable visible session exists.",
    "5. After delegation, continue driving the task: check results, identify blockers, and push the next concrete step.",
    "6. External updates should summarize real execution progress, not just intent."
  ];
  if (flowId) {
    lines.push(`This run is bound to TaskFlow flowId=${flowId}. Any delegated run should become a linked child-task under this flow.`);
  }
  if (spawn) {
    lines.push(
      `Default executor for this task: ${spawn.agentId}.`,
      `Preferred spawn payload: ${JSON.stringify({ agentId: spawn.agentId, label: spawn.label, task: spawn.task })}`
    );
  }
  return lines.join("\n");
}

function hasAnyInternalExecutionStep(state) {
  return Boolean(
    state?.internalCoordinationSeen ||
    state?.workspaceDiscoverySeen ||
    state?.dispatchAttempted ||
    state?.executionLaneSeen
  );
}

function looksLikeDelegationClaim(params) {
  const text = getMessageText(params).toLowerCase();
  if (!text) return false;
  return /(已分派|已派给|已交给|assigned|delegated|handed off|让.+处理|交给.+处理)/i.test(text);
}

function isoNow() {
  return new Date().toISOString();
}

function setRunTelemetry(state, eventName, extra = {}) {
  if (!state.dashboardStartedAt) state.dashboardStartedAt = isoNow();
  state.dashboardUpdatedAt = isoNow();
  state.lastEvent = normalizeString(eventName);
  if (hasNonEmptyString(extra.toolName)) state.lastToolName = normalizeString(extra.toolName);
  if (hasNonEmptyString(extra.toolStatus)) state.lastToolStatus = normalizeString(extra.toolStatus);
  if (hasNonEmptyString(extra.externalMessage)) {
    state.lastExternalMessage = normalizeString(extra.externalMessage).slice(0, 280);
  }
  if (hasNonEmptyString(extra.blockReason)) {
    state.lastBlockReason = normalizeString(extra.blockReason).slice(0, 280);
  }
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
  if (
    last &&
    last.role === nextEvent.role &&
    last.owner === nextEvent.owner &&
    last.text === nextEvent.text
  ) {
    return;
  }
  state.timelineEvents.push(nextEvent);
  state.timelineEvents = state.timelineEvents.slice(-40);
}

export {
  DEFAULT_ENGINEERING_KEYWORDS,
  DEFAULT_ENTRYPOINT_PATTERNS,
  DEFAULT_DISCOVERY_TOOL_NAMES,
  EXECUTION_LANE_TOOL_NAMES,
  INTERNAL_COORDINATION_TOOL_NAMES,
  MESSAGE_TOOL_NAME,
  SESSIONS_SEND_TOOL_NAME,
  SILENT_REPLY_TOKEN,
  buildCoordinationGuidance,
  buildExecutionMandate,
  buildNextActionGuidance,
  buildSpawnSuggestion,
  defaultRunState,
  ensureManagedFlowForState,
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
  looksLikeEntrypointEscalation,
  looksLikeWorkspaceDiscoveryTool,
  normalizeString,
  pluginLikeWorkspaceRoots,
  readToolResultDetails,
  canDelegateToOtherAgents,
  resolveEnabledAgents,
  resolveWorkspaceRoots,
  rewriteAssistantTextMessage,
  setRunTelemetry,
  appendTimelineEvent,
  shouldForceSpawnInsteadOfSend,
  looksLikeExplicitIsolationNeed,
  classifyDispatchResult,
  describeSessionKey,
  sanitizeTaskPrompt,
  shouldTreatVisibleReplyAsFinalDelivery,
  stripPromptScaffolding,
  looksLikeDelegationClaim,
  toFlatText,
  tokenizeText
};
