import { createDashboardStore } from "./lib/dashboard-store.js";
import {
  DEFAULT_DISCOVERY_TOOL_NAMES,
  DEFAULT_ENGINEERING_KEYWORDS,
  DEFAULT_ENTRYPOINT_PATTERNS,
  EXECUTION_LANE_TOOL_NAMES,
  INTERNAL_COORDINATION_TOOL_NAMES,
  MESSAGE_TOOL_NAME,
  SESSIONS_SEND_TOOL_NAME,
  buildCoordinationGuidance,
  buildExecutionMandate,
  buildNextActionGuidance,
  buildSpawnSuggestion,
  classifyDispatchResult,
  canDelegateToOtherAgents,
  defaultRunState,
  ensureManagedFlowForState,
  appendTimelineEvent,
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
  looksLikeDelegationClaim,
  looksLikeExplicitIsolationNeed,
  looksLikeWorkspaceDiscoveryTool,
  normalizeString,
  pluginLikeWorkspaceRoots,
  readToolResultDetails,
  resolveEnabledAgents,
  resolveWorkspaceRoots,
  rewriteAssistantTextMessage,
  sanitizeTaskPrompt,
  setRunTelemetry,
  shouldTreatVisibleReplyAsFinalDelivery,
  shouldForceSpawnInsteadOfSend
} from "./lib/orchestrator-helpers.js";

const plugin = {
  id: "mission-deck",
  name: "MISSION DECK",
  description: "Configuration-driven multi-agent orchestration and execution-lane guidance.",
  configSchema: () => ({
    type: "object",
    additionalProperties: false,
    properties: {
      enabledAgents: {
        type: "array",
        items: { type: "string" }
      },
      internalFirst: { type: "boolean" },
      blockPrematureUserEscalation: { type: "boolean" },
      blockPrematureSpawn: { type: "boolean" },
      blockInvalidSessionsSend: { type: "boolean" },
      redactDashboardContent: { type: "boolean" },
      redactSessionKeys: { type: "boolean" },
      redactPromptMetadata: { type: "boolean" },
      taskKeywords: {
        type: "array",
        items: { type: "string" }
      },
      agentWorkspaceRoots: {
        type: "object",
        additionalProperties: {
          type: "string"
        }
      },
      entrypointPatterns: {
        type: "array",
        items: { type: "string" }
      },
      discoveryToolNames: {
        type: "array",
        items: { type: "string" }
      },
      dashboardRetentionDays: {
        type: "integer",
        minimum: 1
      },
      dashboardStatusPath: {
        type: "string"
      },
      dashboardDataDir: {
        type: "string"
      }
    }
  }),
  register(api) {
    const pluginConfig = api.pluginConfig ?? {};
    const runState = new Map();
    const latestRunByAgent = new Map();
    const childSessionToParent = new Map();
    const childRunToParent = new Map();
    const enabledAgents = Array.from(resolveEnabledAgents(api.config, pluginConfig));
    const taskFlowRuntime = api.runtime?.tasks?.flow ?? api.runtime?.taskFlow;
    const hostSupportsTaskFlow = Boolean(taskFlowRuntime && typeof taskFlowRuntime.bindSession === "function");
    const hostSupportsA2A = Boolean(api.config?.tools?.agentToAgent?.enabled === true);
    const missingHostPrereqs = [
      ...(hostSupportsTaskFlow ? [] : ["TaskFlow"]),
      ...(hostSupportsA2A ? [] : ["agentToAgent"])
    ];
    const configuredAgentMeta = (Array.isArray(api.config?.agents?.list) ? api.config.agents.list : [])
      .map((agent, index) => ({
        agentId: normalizeString(agent?.id),
        displayName: normalizeString(agent?.identity?.name) || normalizeString(agent?.id),
        emoji: normalizeString(agent?.identity?.emoji),
        theme: normalizeString(agent?.identity?.theme),
        profile: normalizeString(agent?.tools?.profile),
        allowAgents: Array.isArray(agent?.subagents?.allowAgents) ? agent.subagents.allowAgents : [],
        isDefault: Boolean(agent?.default),
        orderIndex: index
      }));
    const dashboard = createDashboardStore(api.logger, {
      retentionDays: pluginConfig?.dashboardRetentionDays,
      statusPath: pluginConfig?.dashboardStatusPath,
      dataDir: pluginConfig?.dashboardDataDir,
      redactDashboardContent: pluginConfig?.redactDashboardContent,
      redactSessionKeys: pluginConfig?.redactSessionKeys,
      redactPromptMetadata: pluginConfig?.redactPromptMetadata,
      configuredAgents: configuredAgentMeta,
      fsEnabled: Array.isArray(api.config?.tools?.sandbox?.tools?.allow) && api.config.tools.sandbox.tools.allow.includes("group:fs"),
      webEnabled: Boolean(api.config?.tools?.web?.search?.enabled || api.config?.tools?.web?.fetch?.enabled),
      mcpServers: Object.keys(api.config?.mcp?.servers || {})
    });

    function resolveState(ctx) {
      const runId = normalizeString(ctx?.runId) || latestRunByAgent.get(normalizeString(ctx?.agentId)) || "";
      return runId ? runState.get(runId) : null;
    }

    function buildChildOutcomeSummary(state) {
      return normalizeString(state?.lastExternalMessage) ||
        normalizeString(state?.lastBlockReason) ||
        normalizeString(state?.lastToolStatus) ||
        normalizeString(state?.lastEvent) ||
        normalizeString(state?.promptText).slice(0, 140) ||
        "已收到最新进展";
    }

    function buildHostPrereqMessage() {
      return `MISSION DECK requires host support for ${missingHostPrereqs.join(" and ")}. Install or enable OpenClaw with both TaskFlow and agent-to-agent support before enabling this plugin.`;
    }

    function extractDispatchReply(details) {
      return normalizeString(
        details?.reply ||
        details?.message ||
        details?.result?.reply ||
        details?.result?.message
      );
    }

    function hasOpenChildTasks(state) {
      const summary = state?.flowTaskSummary;
      if (summary && Number(summary.active || 0) > 0) return true;
      const childTasks = Array.isArray(state?.childTasks) ? state.childTasks : [];
      return childTasks.some((task) => {
        const phase = normalizeString(task?.phase).toLowerCase();
        return !["reported", "succeeded", "success", "completed", "done", "failed", "blocked", "cancelled", "timed_out", "timeout"].includes(phase);
      });
    }

    function shouldFinishParentFlow(state) {
      const visibleReply = normalizeString(state?.lastExternalMessage);
      if (!visibleReply) return false;
      if (looksLikeAwaitingUserInputReply(visibleReply)) return false;
      if (hasOpenChildTasks(state)) return false;
      if (shouldTreatVisibleReplyAsFinalDelivery(visibleReply)) return true;
      return true;
    }

    function deriveChildOutcomePhase(state) {
      const flowStatus = normalizeString(state?.flowStatus).toLowerCase();
      const visibleReply = normalizeString(state?.lastExternalMessage);
      if (normalizeString(state?.lastBlockReason)) return "blocked";
      if (["failed", "blocked", "cancelled", "timed_out", "timeout"].includes(flowStatus)) return "blocked";
      if (looksLikeAwaitingUserInputReply(visibleReply)) return "blocked";
      if (["succeeded", "completed", "done"].includes(flowStatus)) return "completed";
      if (visibleReply && shouldTreatVisibleReplyAsFinalDelivery(visibleReply)) return "completed";
      if (state?.userVisibleMessageSent || hasAnyInternalExecutionStep(state) || !hasOpenChildTasks(state)) return "completed";
      return "reported";
    }

    function syncFlowState(taskFlow, state) {
      if (!taskFlow || !state?.flowId) return;
      const flow = taskFlow.get(state.flowId);
      const summary = taskFlow.getTaskSummary?.(state.flowId);
      if (flow) {
        state.flowId = normalizeString(flow.flowId || state.flowId);
        state.flowRevision = Number(flow.revision ?? state.flowRevision ?? 0);
        state.flowStatus = normalizeString(flow.status);
        state.flowCurrentStep = normalizeString(flow.currentStep);
        const blocked = flow?.blocked?.summary || flow?.blockedSummary;
        const waitStep = flow?.wait?.summary || flow?.waitJson?.summary;
        state.flowWaitSummary = normalizeString(blocked || waitStep);
        state.taskFlowSeen = true;
      }
      if (summary) state.flowTaskSummary = summary;
    }

    function updateFlow(taskFlow, state, action, payload = {}) {
      if (!taskFlow || !state?.flowId) return null;
      const expectedRevision = Number(state.flowRevision ?? 0);
      const call = taskFlow[action];
      if (typeof call !== "function") return null;
      const result = call({
        flowId: state.flowId,
        expectedRevision,
        ...payload
      });
      const current = result?.current || result?.flow || null;
      if (result?.applied && current) {
        state.flowId = normalizeString(current.flowId || state.flowId);
        state.flowRevision = Number(current.revision ?? state.flowRevision ?? 0);
        state.flowStatus = normalizeString(current.status);
        state.flowCurrentStep = normalizeString(current.currentStep);
        const blocked = current?.blocked?.summary || current?.blockedSummary;
        const waitStep = current?.wait?.summary || current?.waitJson?.summary;
        state.flowWaitSummary = normalizeString(blocked || waitStep);
      } else if (current) {
        state.flowRevision = Number(current.revision ?? state.flowRevision ?? 0);
        state.flowStatus = normalizeString(current.status || state.flowStatus);
        state.flowCurrentStep = normalizeString(current.currentStep || state.flowCurrentStep);
      }
      syncFlowState(taskFlow, state);
      return result;
    }

    function applyChildOutcomeToParentState(parentState, outcome) {
      if (!parentState || !outcome) return false;
      const childTasks = Array.isArray(parentState.childTasks) ? parentState.childTasks : [];
      const matchIndex = childTasks.findIndex((task) =>
        normalizeString(task?.taskId) === normalizeString(outcome.childTaskId) ||
        normalizeString(task?.childSessionKey) === normalizeString(outcome.childSessionKey)
      );
      if (matchIndex < 0) return false;
      const existing = childTasks[matchIndex] || {};
      childTasks[matchIndex] = {
        ...existing,
        phase: normalizeString(outcome.phase) || normalizeString(existing.phase) || "reported",
        progressSummary: normalizeString(outcome.summary) || normalizeString(existing.progressSummary) || "已收到最新进展",
        updatedAt: normalizeString(outcome.updatedAt) || normalizeString(existing.updatedAt) || isoNow(),
        childRunId: normalizeString(outcome.childRunId) || normalizeString(existing.childRunId),
        agentId: normalizeString(outcome.childAgentId) || normalizeString(existing.agentId)
      };
      parentState.childTasks = childTasks;
      if (normalizeString(outcome.phase).toLowerCase() === "blocked") {
        parentState.lastBlockReason = normalizeString(outcome.summary) || "child task blocked";
      }
      return true;
    }

    function upsertChildTaskState(state, taskPatch) {
      if (!state || !taskPatch) return null;
      const childTasks = Array.isArray(state.childTasks) ? state.childTasks : [];
      const patchTaskId = normalizeString(taskPatch.taskId);
      const patchSessionKey = normalizeString(taskPatch.childSessionKey);
      const patchAgentId = normalizeString(taskPatch.agentId);
      const matchIndex = childTasks.findIndex((task) =>
        (patchTaskId && normalizeString(task?.taskId) === patchTaskId) ||
        (patchSessionKey && normalizeString(task?.childSessionKey) === patchSessionKey) ||
        (!patchTaskId && !patchSessionKey && patchAgentId && normalizeString(task?.agentId) === patchAgentId)
      );
      if (matchIndex >= 0) {
        childTasks[matchIndex] = {
          ...childTasks[matchIndex],
          ...taskPatch
        };
        state.childTasks = childTasks;
        return childTasks[matchIndex];
      }
      childTasks.push(taskPatch);
      state.childTasks = childTasks;
      return taskPatch;
    }

    api.on("gateway_start", async () => {
      if (missingHostPrereqs.length > 0) {
        api.logger.warn?.(
          `[mission-deck] host prerequisites missing: ${missingHostPrereqs.join(", ")}. Install OpenClaw with TaskFlow and agentToAgent support before enabling mission-deck.`
        );
      }
      api.logger.info(
        `[mission-deck] loaded enabledAgents=${enabledAgents.join(",") || "(none)"} internalFirst=${pluginConfig?.internalFirst !== false}`
      );
      await dashboard.flush();
      setTimeout(() => {
        dashboard.flush().catch((error) => {
          api.logger.warn?.(`[mission-deck] delayed startup flush failed: ${error?.message || error}`);
        });
      }, 1500);
    });

    api.on("before_prompt_build", async (event, ctx) => {
      const agentId = normalizeString(ctx?.agentId);
      const runId = normalizeString(ctx?.runId);
      if (!agentId) return;
      if (!enabledAgents.includes(agentId)) return;
      if (missingHostPrereqs.length > 0) {
        return {
          appendSystemContext: `MISSION DECK prerequisite failure.\n${buildHostPrereqMessage()}\nDo not attempt orchestration, delegation, or TaskFlow work until the host installation satisfies these prerequisites.`
        };
      }

      let state = null;
      if (runId) {
        state = runState.get(runId) ?? defaultRunState();
        const parentLink =
          childSessionToParent.get(normalizeString(ctx?.sessionKey)) ||
          childRunToParent.get(runId);
        if (parentLink) {
          state.parentRunId = normalizeString(parentLink.parentRunId);
          state.parentChildTaskId = normalizeString(parentLink.childTaskId);
          state.parentChildSessionKey = normalizeString(parentLink.childSessionKey);
          state.parentAgentId = normalizeString(parentLink.parentAgentId);
          state.parentSessionKey = normalizeString(parentLink.parentSessionKey);
        }
        state.engineeringTask = isEngineeringPrompt(event.prompt, pluginConfig);
        state.promptText = normalizeString(event.prompt);
        state.normalizedPromptText = sanitizeTaskPrompt(event.prompt);
        state.suggestedSpawn = buildSpawnSuggestion(api.config, agentId, event.prompt);
        appendTimelineEvent(state, {
          role: "用户发起",
          owner: "用户",
          text: state.normalizedPromptText || state.promptText || "收到新任务"
        });
        const flow = ensureManagedFlowForState(api, ctx, state);
        if (flow) {
          state.flowStatus = normalizeString(flow.status);
          state.flowCurrentStep = normalizeString(flow.currentStep);
        }
        syncFlowState(getRuntimeTaskFlow(api, ctx), state);
        setRunTelemetry(state, "before_prompt_build");
        runState.set(runId, state);
        latestRunByAgent.set(agentId, runId);
        dashboard.trackActiveRun(runId, agentId, state);
        await dashboard.flush();
        api.logger.info(
          `[mission-deck] before_prompt_build agent=${agentId} run=${runId} engineeringTask=${state.engineeringTask} flow=${state.flowId || "(none)"}`
        );
      }

      const appendSystemContext = buildCoordinationGuidance({
        agentId,
        cfg: api.config,
        pluginConfig,
        prompt: event.prompt
      });
      const executionMandate = buildExecutionMandate(
        api.config,
        agentId,
        event.prompt,
        state?.flowId || ""
      );
      return { appendSystemContext: `${appendSystemContext}\n\n${executionMandate}` };
    });

    api.on("before_tool_call", async (event, ctx) => {
      const agentId = normalizeString(ctx?.agentId);
      const runId = normalizeString(ctx?.runId);
      if (!agentId || !runId) return;
      if (!enabledAgents.includes(agentId)) return;
      if (missingHostPrereqs.length > 0) {
        return {
          block: true,
          blockReason: buildHostPrereqMessage()
        };
      }

      const workspaceRoots = resolveWorkspaceRoots(api.config, agentId, pluginConfig);
      const state = runState.get(runId) ?? defaultRunState();
      const normalizedToolName = normalizeString(event.toolName).toLowerCase();
      const taskFlow = getRuntimeTaskFlow(api, ctx);
      syncFlowState(taskFlow, state);

      if (looksLikeWorkspaceDiscoveryTool(event.toolName, event.params, workspaceRoots, pluginConfig)) {
        state.workspaceDiscoverySeen = true;
        setRunTelemetry(state, "workspace_discovery", { toolName: event.toolName });
        appendTimelineEvent(state, {
          role: "资料检查",
          owner: agentId,
          text: "正在检查相关文件、工作区或台账。"
        });
        runState.set(runId, state);
        dashboard.trackActiveRun(runId, agentId, state);
        await dashboard.flush();
        return;
      }

      if (INTERNAL_COORDINATION_TOOL_NAMES.has(normalizedToolName)) {
        state.internalCoordinationSeen = true;
        setRunTelemetry(state, "internal_coordination", { toolName: event.toolName });
        appendTimelineEvent(state, {
          role: "内部查询",
          owner: agentId,
          text: "正在查看现有会话和团队分工情况。"
        });
        runState.set(runId, state);
        dashboard.trackActiveRun(runId, agentId, state);
        await dashboard.flush();
        return;
      }

      if (EXECUTION_LANE_TOOL_NAMES.has(normalizedToolName)) {
        const dispatchTargetAgentId = normalizeString(event.params?.agentId) || normalizeString(event.params?.sessionKey).match(/^agent:([^:]+):/)?.[1] || "";
        if (
          dispatchTargetAgentId &&
          dispatchTargetAgentId !== agentId &&
          !canDelegateToOtherAgents(api.config, agentId)
        ) {
          const nextActionGuidance = buildNextActionGuidance(api.config, agentId, state.promptText);
          setRunTelemetry(state, "blocked_secondary_delegation", {
            toolName: event.toolName,
            blockReason: `secondary delegation is not allowed for ${agentId}`
          });
          updateFlow(taskFlow, state, "setWaiting", {
            currentStep: "awaiting-parent-escalation",
            blockedSummary: `secondary delegation is not allowed for ${agentId}`,
            waitJson: {
              kind: "delegation_policy",
              reason: `secondary delegation is not allowed for ${agentId}`,
              targetAgentId: dispatchTargetAgentId
            }
          });
          runState.set(runId, state);
          dashboard.trackActiveRun(runId, agentId, state);
          await dashboard.pushBlocker({
            timestamp: isoNow(),
            runId,
            agentId,
            reason: `secondary delegation is not allowed for ${agentId}`,
            toolName: normalizedToolName
          });
          await dashboard.flush();
          return {
            block: true,
            blockReason: `This agent is execution-only and cannot delegate onward. Report the blocker or current findings back to the parent instead of creating a second-hop handoff.\n${nextActionGuidance}`
          };
        }
        if (event.toolCallId) {
          state.pendingDispatches.set(event.toolCallId, {
            toolName: normalizedToolName,
            params: event.params
          });
        }
        setRunTelemetry(state, "execution_lane_request", { toolName: event.toolName });
        appendTimelineEvent(state, {
          role: "安排跟进",
          owner: agentId,
          text: "正在建立协作链路。"
        });
        runState.set(runId, state);
        dashboard.trackActiveRun(runId, agentId, state);
        await dashboard.flush();
        if (normalizedToolName === "sessions_spawn") {
          const explicitIsolation = looksLikeExplicitIsolationNeed(event.params, state.promptText);
          if (pluginConfig?.blockPrematureSpawn !== false && !explicitIsolation && !state.internalCoordinationSeen) {
            const nextActionGuidance = buildNextActionGuidance(api.config, agentId, state.promptText);
            setRunTelemetry(state, "blocked_premature_spawn", {
              toolName: event.toolName,
              blockReason: "sessions_spawn before checking for reusable visible session"
            });
            appendTimelineEvent(state, {
              role: "异常摘要",
              owner: agentId,
              text: "未先检查可复用主会话，直接尝试新开隔离执行 lane。",
              tone: "blocked"
            });
            runState.set(runId, state);
            updateFlow(taskFlow, state, "setWaiting", {
              currentStep: "awaiting-visible-session-check",
              blockedSummary: "sessions_spawn before checking for reusable visible session",
              waitJson: {
                kind: "internal_action_required",
                reason: "check visible sessions before opening a new isolated lane"
              }
            });
            dashboard.trackActiveRun(runId, agentId, state);
            await dashboard.pushBlocker({
              timestamp: isoNow(),
              runId,
              agentId,
              reason: "sessions_spawn before checking for reusable visible session",
              toolName: normalizedToolName
            });
            await dashboard.flush();
            return {
              block: true,
              blockReason: `First inspect visible teammate sessions before opening a fresh isolated lane. Prefer sessions_send when a reusable main or persistent session already exists. Use sessions_spawn only for explicit isolation, background/ACP workers, or when no suitable visible session exists.\n${nextActionGuidance}`
            };
          }
          state.internalCoordinationSeen = true;
          state.dispatchAttempted = true;
          runState.set(runId, state);
          return;
        }
      }

      if (normalizedToolName === SESSIONS_SEND_TOOL_NAME) {
        const hasSessionKey = hasNonEmptyString(event.params?.sessionKey);
        const hasLabel = hasNonEmptyString(event.params?.label);
        const hasAgentId = hasNonEmptyString(event.params?.agentId);
        const targetAgentId = normalizeString(event.params?.agentId);

        if (hasSessionKey || hasLabel) {
          if (shouldForceSpawnInsteadOfSend(agentId, event.params)) {
            const nextActionGuidance = buildNextActionGuidance(api.config, agentId, state.promptText);
            api.logger.info(
              `[mission-deck] blocked cross-agent sessions_send label lookup from ${agentId} to ${targetAgentId} run=${runId}`
            );
            setRunTelemetry(state, "blocked_cross_agent_label_send", {
              toolName: event.toolName,
              blockReason: `label-only sessions_send blocked for ${targetAgentId}`
            });
            runState.set(runId, state);
            updateFlow(taskFlow, state, "setWaiting", {
              currentStep: "blocked-invalid-handoff",
              blockedSummary: `label-only sessions_send blocked for ${targetAgentId}`,
              waitJson: {
                kind: "handoff",
                reason: `label-only sessions_send blocked for ${targetAgentId}`
              }
            });
            dashboard.trackActiveRun(runId, agentId, state);
            await dashboard.pushBlocker({
              timestamp: isoNow(),
              runId,
              agentId,
              reason: `label-only sessions_send blocked for ${targetAgentId}`,
              toolName: normalizedToolName
            });
            await dashboard.flush();
            return {
              block: true,
              blockReason: `Cross-agent sessions_send using only label is unreliable under sandboxed label lookup. For agent ${targetAgentId}, create a fresh execution lane with sessions_spawn instead of relying on label resolution.\n${nextActionGuidance}`
            };
          }
          state.internalCoordinationSeen = true;
          state.dispatchAttempted = true;
          state.executionLaneSeen = true;
          runState.set(runId, state);
          return;
        }

        if (pluginConfig?.blockInvalidSessionsSend !== false && hasAgentId) {
          const nextActionGuidance = buildNextActionGuidance(api.config, agentId, state.promptText);
          api.logger.info(
            `[mission-deck] blocked invalid sessions_send without sessionKey/label from ${agentId} run=${runId}`
          );
          setRunTelemetry(state, "blocked_invalid_sessions_send", {
            toolName: event.toolName,
            blockReason: "sessions_send without sessionKey or label"
          });
          updateFlow(taskFlow, state, "setWaiting", {
            currentStep: "blocked-invalid-handoff",
            blockedSummary: "sessions_send without sessionKey or label",
            waitJson: {
              kind: "handoff",
              reason: "sessions_send without sessionKey or label"
            }
          });
          runState.set(runId, state);
          dashboard.trackActiveRun(runId, agentId, state);
          await dashboard.pushBlocker({
            timestamp: isoNow(),
            runId,
            agentId,
            reason: "sessions_send without sessionKey or label",
            toolName: normalizedToolName
          });
          await dashboard.flush();
          return {
            block: true,
            blockReason: `sessions_send cannot target by agentId alone. Reuse a known session via sessionKey/label, or create an execution lane with sessions_spawn first.\n${nextActionGuidance}`
          };
        }
      }

      if (EXECUTION_LANE_TOOL_NAMES.has(normalizedToolName)) {
        state.dispatchAttempted = true;
      }

      if (normalizedToolName !== MESSAGE_TOOL_NAME) return;
      if (pluginConfig?.blockPrematureUserEscalation !== false && looksLikeEntrypointEscalation(event.params, pluginConfig) && !state.workspaceDiscoverySeen) {
        api.logger.info(
          `[mission-deck] blocked premature user escalation from ${agentId} run=${runId}`
        );
        const nextActionGuidance = buildNextActionGuidance(api.config, agentId, state.promptText);
        setRunTelemetry(state, "blocked_premature_user_escalation", {
          toolName: event.toolName,
          blockReason: "premature user escalation"
        });
        updateFlow(taskFlow, state, "setWaiting", {
          currentStep: "awaiting-internal-discovery",
          blockedSummary: "premature user escalation",
          waitJson: {
            kind: "internal_action_required",
            reason: "premature user escalation"
          }
        });
        runState.set(runId, state);
        dashboard.trackActiveRun(runId, agentId, state);
        await dashboard.pushBlocker({
          timestamp: isoNow(),
          runId,
          agentId,
          reason: "premature user escalation",
          toolName: normalizedToolName
        });
        await dashboard.flush();
        return {
          block: true,
          blockReason: `Use internal-first coordination before asking the user for repo paths, project directories, git URLs, or session entrypoints. Query visible sessions, inspect configured workspaces, or create an execution lane first.\n${nextActionGuidance}`
        };
      }
      if (state.engineeringTask && looksLikeDelegationClaim(event.params) && (!state.taskFlowSeen || state.childTaskIds.length === 0)) {
        setRunTelemetry(state, "blocked_delegation_claim_before_link", {
          toolName: event.toolName,
          blockReason: "delegation claim without flow id child-task linkage"
        });
        updateFlow(taskFlow, state, "setWaiting", {
          currentStep: "awaiting-taskflow-link",
          blockedSummary: "delegation claim without flow id child-task linkage",
          waitJson: {
            kind: "traceability",
            reason: "delegation claim without flow id child-task linkage"
          }
        });
        runState.set(runId, state);
        dashboard.trackActiveRun(runId, agentId, state);
        await dashboard.pushBlocker({
          timestamp: isoNow(),
          runId,
          agentId,
          reason: "delegation claim without flow id child-task linkage",
          toolName: normalizedToolName
        });
        await dashboard.flush();
        return {
          block: true,
          blockReason: `Do not report delegation before a real flow id and linked child-task exist. Create or link the execution lane first so the handoff is traceable in TaskFlow.`
        };
      }
      if (state.engineeringTask && !hasAnyInternalExecutionStep(state)) {
        api.logger.info(
          `[mission-deck] blocked external message before internal action agent=${agentId} run=${runId}`
        );
        setRunTelemetry(state, "blocked_external_message_before_internal_action", {
          toolName: event.toolName,
          blockReason: "external message before internal action"
        });
        updateFlow(taskFlow, state, "setWaiting", {
          currentStep: "awaiting-internal-action",
          blockedSummary: "external message before internal action",
          waitJson: {
            kind: "internal_action_required",
            reason: "external message before internal action"
          }
        });
        runState.set(runId, state);
        dashboard.trackActiveRun(runId, agentId, state);
        await dashboard.pushBlocker({
          timestamp: isoNow(),
          runId,
          agentId,
          reason: "external message before internal action",
          toolName: normalizedToolName
        });
        await dashboard.flush();
        return {
          block: true,
          blockReason: `Execution-first rule: do at least one internal action before any external progress message on engineering work. Start with sessions_list/agents_list, inspect configured workspaces, or create an execution lane with sessions_spawn.\n${buildExecutionMandate(api.config, agentId, state.promptText, state.flowId)}`
        };
      }
      state.userVisibleMessageSent = true;
      state.lastBlockReason = "";
      setRunTelemetry(state, "external_message", {
        toolName: event.toolName,
        externalMessage: getMessageText(event.params)
      });
      appendTimelineEvent(state, {
        role: "对外同步",
        owner: agentId,
        text: getMessageText(event.params)
      });
      runState.set(runId, state);
      dashboard.trackActiveRun(runId, agentId, state);
      await dashboard.flush();
      api.logger.info(
        `[mission-deck] before_tool_call message agent=${agentId} run=${runId} state=${JSON.stringify(state)}`
      );
    });

    api.on("after_tool_call", async (event, ctx) => {
      const agentId = normalizeString(ctx?.agentId);
      const runId = normalizeString(ctx?.runId);
      if (!agentId || !runId) return;
      if (!enabledAgents.includes(agentId)) return;

      const state = runState.get(runId);
      if (!state) return;
      const taskFlow = getRuntimeTaskFlow(api, ctx);
      syncFlowState(taskFlow, state);

      const normalizedToolName = normalizeString(event.toolName).toLowerCase();
      if (!EXECUTION_LANE_TOOL_NAMES.has(normalizedToolName)) return;

      const pendingDispatch = event.toolCallId ? state.pendingDispatches.get(event.toolCallId) : null;
      if (event.toolCallId) state.pendingDispatches.delete(event.toolCallId);

      const details = readToolResultDetails(event);
      const dispatchParams = event.params ?? pendingDispatch?.params ?? {};
      const dispatch = extractDispatchTarget(normalizedToolName, dispatchParams, details);
      const classification = classifyDispatchResult(normalizedToolName, details, dispatch);
      const dispatchReply = extractDispatchReply(details);
      state.lastBlockReason = "";
      setRunTelemetry(state, "dispatch_result", {
        toolName: event.toolName,
        toolStatus: classification.phase
      });
      if (!classification.track) {
        if (classification.failed) {
          const failureReason = normalizeString(classification.reason) || `${normalizedToolName} ${classification.phase}`;
          state.lastBlockReason = failureReason;
          appendTimelineEvent(state, {
            role: "异常摘要",
            owner: agentId,
            text: failureReason,
            tone: "blocked"
          });
          updateFlow(taskFlow, state, "setWaiting", {
            currentStep: `dispatch-${classification.phase}`,
            blockedSummary: failureReason,
            waitJson: {
              kind: "dispatch_failure",
              toolName: normalizedToolName,
              phase: classification.phase,
              reason: failureReason,
              targetAgentId: dispatch?.agentId || null
            }
          });
          await dashboard.pushBlocker({
            timestamp: isoNow(),
            runId,
            agentId,
            reason: failureReason,
            toolName: normalizedToolName
          });
        }
        runState.set(runId, state);
        dashboard.trackActiveRun(runId, agentId, state);
        await dashboard.pushDispatch({
          timestamp: isoNow(),
          runId,
          agentId,
          toolName: normalizedToolName,
          status: classification.phase,
          target: dispatch
        });
        await dashboard.flush();
        return;
      }

      if (!taskFlow) {
        api.logger.warn?.(
          `[mission-deck] taskflow runtime unavailable for ${normalizedToolName} agent=${agentId} run=${runId}`
        );
        runState.set(runId, state);
        return;
      }

      if (!dispatch?.task) {
        runState.set(runId, state);
        dashboard.trackActiveRun(runId, agentId, state);
        await dashboard.flush();
        return;
      }

      const childTaskDraft = upsertChildTaskState(state, {
        taskId: "",
        agentId: dispatch.agentId,
        childSessionKey: dispatch.childSessionKey,
        label: dispatch.label,
        phase: dispatchReply ? "completed" : classification.phase,
        progressSummary: dispatchReply || `Delegated via ${normalizedToolName} to ${dispatch.targetKind || "session"}`,
        updatedAt: isoNow()
      });
      state.executionLaneSeen = true;
      appendTimelineEvent(state, {
        role: "安排跟进",
        owner: agentId,
        text: dispatch?.agentId
          ? `已交给 ${dispatch.agentId} 继续处理。`
          : "已建立新的协作链路。"
      });
      if (dispatchReply) {
        appendTimelineEvent(state, {
          role: "协同反馈",
          owner: dispatch.agentId || agentId,
          text: dispatchReply
        });
      }

      let flow = state.flowId ? taskFlow.get(state.flowId) : undefined;
      if (!flow) {
        flow = taskFlow.createManaged({
          controllerId: "mission-deck",
          goal: state.promptText || dispatch.task,
          status: "running",
          currentStep: `delegating:${dispatch.agentId || "peer"}`
        });
        state.flowId = normalizeString(flow?.flowId);
        state.flowRevision = Number(flow?.revision ?? 0);
      }

      const created = taskFlow.runTask({
        flowId: state.flowId,
        runtime: inferTaskRuntime(normalizedToolName),
        childSessionKey: dispatch.childSessionKey || undefined,
        agentId: dispatch.agentId || undefined,
        runId: dispatch.runId || undefined,
        label: dispatch.label || undefined,
        task: dispatch.task,
        status: "running",
        progressSummary: `Delegated via ${normalizedToolName}`
      });
      if (!created.created) {
        api.logger.warn?.(
          `[mission-deck] failed to register child task agent=${agentId} run=${runId} reason=${created.reason}`
        );
        runState.set(runId, state);
        dashboard.trackActiveRun(runId, agentId, state);
        await dashboard.pushBlocker({
          timestamp: isoNow(),
          runId,
          agentId,
          reason: `taskflow child-task registration failed: ${created.reason}`,
          toolName: normalizedToolName
        });
        await dashboard.flush();
        return;
      }

      state.taskFlowSeen = true;
      state.executionLaneSeen = true;
      state.flowId = normalizeString(created.flow?.flowId || state.flowId);
      state.flowRevision = Number(created.flow?.revision ?? state.flowRevision);
      state.childTaskIds.push(created.task.taskId);
      upsertChildTaskState(state, {
        ...childTaskDraft,
        taskId: created.task.taskId
      });
      const childLink = {
        parentRunId: runId,
        parentAgentId: agentId,
        parentSessionKey: normalizeString(ctx?.sessionKey),
        childTaskId: created.task.taskId,
        childSessionKey: normalizeString(dispatch.childSessionKey),
        childAgentId: normalizeString(dispatch.agentId)
      };
      if (childLink.childSessionKey) childSessionToParent.set(childLink.childSessionKey, childLink);
      if (normalizeString(dispatch.runId)) childRunToParent.set(normalizeString(dispatch.runId), childLink);
      updateFlow(taskFlow, state, "resume", {
        status: "running",
        currentStep: `delegated:${dispatch.agentId || "peer"}`,
        stateJson: {
          phase: "delegated",
          delegatedTo: dispatch.agentId || null,
          routeType: dispatch.routeType || null,
          childTaskId: created.task.taskId
        }
      });
      runState.set(runId, state);
      dashboard.trackActiveRun(runId, agentId, state);
      await dashboard.pushDispatch({
        timestamp: isoNow(),
        runId,
        agentId,
        toolName: normalizedToolName,
        status: classification.phase,
        target: dispatch,
        taskflow: {
          flowId: state.flowId,
          childTaskId: created.task.taskId
        }
      });
      await dashboard.flush();
      api.logger.info(
        `[mission-deck] tracked ${normalizedToolName} in taskflow agent=${agentId} run=${runId} flow=${state.flowId} childTask=${created.task.taskId}`
      );
    });

    api.on("before_agent_reply", async (event, ctx) => {
      const agentId = normalizeString(ctx?.agentId);
      if (!agentId || !enabledAgents.includes(agentId)) return;
      const state = resolveState(ctx);
      if (!state?.engineeringTask) return;
      if (!isSilentReply(event?.cleanedBody)) return;
      if (hasAnyInternalExecutionStep(state)) return;
      return {
        handled: true,
        reply: {
          text: "This run will not end silently. No internal execution step has happened yet; inspect sessions, inspect workspaces, or open an execution lane first."
        }
      };
    });

    api.on("before_message_write", (event, ctx) => {
      const agentId = normalizeString(ctx?.agentId);
      if (!agentId || !enabledAgents.includes(agentId)) return;
      const state = resolveState(ctx);
      if (!state?.engineeringTask) return;
      const assistantText = extractAssistantText(event?.message);
      if (assistantText && !isSilentReply(assistantText)) {
        state.userVisibleMessageSent = true;
        state.lastBlockReason = "";
        setRunTelemetry(state, "external_message", {
          toolName: "assistant_reply",
          externalMessage: assistantText
        });
        appendTimelineEvent(state, {
          role: "最终回复",
          owner: agentId,
          text: assistantText
        });
        runState.set(normalizeString(ctx?.runId), state);
        dashboard.trackActiveRun(normalizeString(ctx?.runId), agentId, state);
      }
      if (!isSilentReply(assistantText)) return;
      if (hasAnyInternalExecutionStep(state)) return;
      return {
        message: rewriteAssistantTextMessage(
          event.message,
          "The run is still in internal progress and no valid internal action has completed yet. It will not end silently; the next step is to establish a traceable execution path."
        )
      };
    });

    api.on("agent_end", async (_event, ctx) => {
      const agentId = normalizeString(ctx?.agentId);
      const runId = normalizeString(ctx?.runId);
      if (!runId) return;
      const state = runState.get(runId);
      if (state) {
        const taskFlow = getRuntimeTaskFlow(api, ctx);
        syncFlowState(taskFlow, state);
        setRunTelemetry(state, "agent_end");
        if (taskFlow && state.flowId) {
          if (state.lastBlockReason) {
            updateFlow(taskFlow, state, "fail", {
              blockedSummary: state.lastBlockReason,
              stateJson: {
                outcome: "failed",
                reason: state.lastBlockReason
              },
              endedAt: Date.now(),
              updatedAt: Date.now()
            });
          } else if (state.executionLaneSeen && state.childTaskIds.length > 0 && !state.lastExternalMessage) {
            updateFlow(taskFlow, state, "setWaiting", {
              currentStep: "awaiting-child-update",
              waitJson: {
                kind: "child_progress",
                childTaskIds: state.childTaskIds.slice(-8)
              }
            });
          } else if (hasOpenChildTasks(state) && !shouldFinishParentFlow(state)) {
            updateFlow(taskFlow, state, "setWaiting", {
              currentStep: "awaiting-child-close",
              waitJson: {
                kind: "child_progress",
                childTaskIds: state.childTaskIds.slice(-8)
              }
            });
          } else if (!state.userVisibleMessageSent && !state.lastExternalMessage) {
            updateFlow(taskFlow, state, "setWaiting", {
              currentStep: "awaiting-visible-update",
              waitJson: {
                kind: "response_pending",
                reason: "no user-visible update recorded"
              }
            });
          } else {
            updateFlow(taskFlow, state, "finish", {
              currentStep: "completed",
              stateJson: {
                outcome: "succeeded",
                summary: buildChildOutcomeSummary(state)
              },
              endedAt: Date.now(),
              updatedAt: Date.now()
            });
          }
        }
        await dashboard.archiveRun(runId, agentId, state);
        if (state.parentRunId && (state.parentChildTaskId || state.parentChildSessionKey)) {
          const childOutcomePhase = deriveChildOutcomePhase(state);
          const childOutcomeSummary = buildChildOutcomeSummary(state);
          const childOutcome = {
            parentRunId: state.parentRunId,
            childTaskId: state.parentChildTaskId,
            childSessionKey: state.parentChildSessionKey,
            childRunId: runId,
            childAgentId: agentId,
            phase: childOutcomePhase,
            summary: childOutcomeSummary,
            updatedAt: isoNow()
          };
          const parentState = runState.get(state.parentRunId);
          if (applyChildOutcomeToParentState(parentState, childOutcome)) {
            appendTimelineEvent(parentState, {
              role: "协同反馈",
              owner: agentId,
              text: childOutcomeSummary
            });
            const parentTaskFlow = getRuntimeTaskFlow(api, { ...ctx, sessionKey: state.parentSessionKey });
            syncFlowState(parentTaskFlow, parentState);
            if (childOutcomePhase === "blocked") {
              updateFlow(parentTaskFlow, parentState, "setWaiting", {
                currentStep: `child-blocked:${agentId}`,
                blockedSummary: childOutcomeSummary,
                waitJson: {
                  kind: "child_blocked",
                  reason: childOutcomeSummary,
                  childAgentId: agentId,
                  childTaskId: state.parentChildTaskId
                }
              });
            } else {
              updateFlow(parentTaskFlow, parentState, "resume", {
                status: "running",
                currentStep: `child-${childOutcomePhase}:${agentId}`,
                stateJson: {
                  phase: `child_${childOutcomePhase}`,
                  childAgentId: agentId,
                  childTaskId: state.parentChildTaskId
                }
              });
            }
            runState.set(state.parentRunId, parentState);
            if (state.parentAgentId) dashboard.trackActiveRun(state.parentRunId, state.parentAgentId, parentState);
          }
          await dashboard.attachChildOutcome(childOutcome);
        }
      }
      runState.delete(runId);
      childRunToParent.delete(runId);
      if (state?.parentChildSessionKey) childSessionToParent.delete(state.parentChildSessionKey);
      if (latestRunByAgent.get(agentId) === runId) latestRunByAgent.delete(agentId);
      await dashboard.flush();
    });
  }
};

export default plugin;
export const __test__ = {
  DEFAULT_ENGINEERING_KEYWORDS,
  DEFAULT_ENTRYPOINT_PATTERNS,
  DEFAULT_DISCOVERY_TOOL_NAMES,
  normalizeString,
  hasNonEmptyString,
  pluginLikeWorkspaceRoots,
  resolveWorkspaceRoots,
  isEngineeringPrompt,
  looksLikeEntrypointEscalation,
  looksLikeWorkspaceDiscoveryTool,
  buildSpawnSuggestion,
  buildCoordinationGuidance,
  extractDispatchTarget,
  extractAssistantText,
  readToolResultDetails,
  rewriteAssistantTextMessage,
  isSilentReply,
  defaultRunState
};
