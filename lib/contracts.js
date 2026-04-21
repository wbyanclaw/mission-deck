export const DEFAULT_ENGINEERING_KEYWORDS = [];

export const DEFAULT_ENTRYPOINT_PATTERNS = [
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

export const DEFAULT_DISCOVERY_TOOL_NAMES = [
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

export const INTERNAL_COORDINATION_TOOL_NAMES = new Set([
  "sessions_list",
  "sessions_history",
  "agents_list",
  "subagents"
]);

export const EXECUTION_LANE_TOOL_NAMES = new Set([
  "sessions_spawn",
  "sessions_send"
]);

export const MESSAGE_TOOL_NAME = "message";
export const SESSIONS_SEND_TOOL_NAME = "sessions_send";
export const SILENT_REPLY_TOKEN = "NO_REPLY";
export const MAX_LABEL_LENGTH = 48;

export const EVENT_TYPES = Object.freeze({
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

export const FLOW_STATES = Object.freeze({
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

export const FINAL_DELIVERY_PATTERNS = [
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

export const UNVERIFIED_EXECUTION_PATTERNS = [
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

export const FOLLOWUP_SUMMARY_PATTERNS = [
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

export const AWAITING_USER_INPUT_PATTERNS = [
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
