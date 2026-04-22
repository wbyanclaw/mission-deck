#!/usr/bin/env node

import { cp, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PACKAGE_ROOT = path.resolve(__dirname, "..");
const DEFAULT_OPENCLAW_HOME = path.join(os.homedir(), ".openclaw");
const PLUGIN_ID = "mission-deck";

function parseArgs(argv) {
  const out = {
    apply: false,
    json: false,
    restart: false,
    verify: false,
    openclawHome: process.env.OPENCLAW_HOME || DEFAULT_OPENCLAW_HOME,
    pluginDir: "",
    configPath: "",
    service: process.env.OPENCLAW_SERVICE || "openclaw-gateway"
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--apply") out.apply = true;
    else if (arg === "--json") out.json = true;
    else if (arg === "--restart") out.restart = true;
    else if (arg === "--verify") out.verify = true;
    else if (arg === "--openclaw-home") out.openclawHome = path.resolve(argv[++i] || "");
    else if (arg === "--plugin-dir") out.pluginDir = path.resolve(argv[++i] || "");
    else if (arg === "--config") out.configPath = path.resolve(argv[++i] || "");
    else if (arg === "--service") out.service = String(argv[++i] || "").trim();
    else if (arg === "--help" || arg === "-h") out.help = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return out;
}

function usage() {
  return [
    "mission-deck-install [--apply] [--verify] [--restart] [--json] [--openclaw-home <dir>] [--plugin-dir <dir>] [--config <file>] [--service <name>]",
    "",
    "Agent-first installer for the mission-deck OpenClaw plugin.",
    "",
    "Flags:",
    "  --apply        Perform the install and config write. Without this flag, print a dry-run plan.",
    "  --verify       Verify plugin files and config after planning or applying.",
    "  --restart      Restart the target service with systemctl after applying.",
    "  --json         Emit structured JSON only.",
    "  --openclaw-home <dir>  Override the target OpenClaw home. Default: ~/.openclaw",
    "  --plugin-dir <dir>     Override the plugin destination directory.",
    "  --config <file>        Override the target openclaw.json path.",
    "  --service <name>       systemd service name for --restart. Default: openclaw-gateway"
  ].join("\n");
}

function stableJson(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

async function exists(targetPath) {
  try {
    await stat(targetPath);
    return true;
  } catch {
    return false;
  }
}

async function readJson(filePath) {
  const raw = await readFile(filePath, "utf8");
  return JSON.parse(raw);
}

function restartService(serviceName) {
  const result = spawnSync("systemctl", ["restart", serviceName], {
    encoding: "utf8"
  });
  return {
    ok: result.status === 0,
    code: result.status ?? 1,
    stdout: result.stdout || "",
    stderr: result.stderr || ""
  };
}

async function verifyInstall(pluginDir, configPath) {
  const pluginManifestPath = path.join(pluginDir, "openclaw.plugin.json");
  const config = await readJson(configPath);
  const pluginEntry = config?.plugins?.entries?.[PLUGIN_ID];
  const loadPaths = Array.isArray(config?.plugins?.load?.paths) ? config.plugins.load.paths : [];
  const checks = {
    pluginDirExists: await exists(pluginDir),
    pluginManifestExists: await exists(pluginManifestPath),
    configEntryPresent: Boolean(pluginEntry && typeof pluginEntry === "object"),
    pluginEnabled: pluginEntry?.enabled === true,
    pluginLoadPathPresent: loadPaths.some((entry) => path.resolve(String(entry || "")) === path.resolve(pluginDir))
  };
  return {
    ok: Object.values(checks).every(Boolean),
    checks
  };
}

function ensurePluginEntry(config, pluginDir) {
  config.plugins ??= {};
  config.plugins.entries ??= {};
  const existing = config.plugins.entries[PLUGIN_ID];
  const next = {
    enabled: true,
    config: {}
  };
  if (existing && typeof existing === "object") {
    next.enabled = existing.enabled !== false;
    next.config = existing.config && typeof existing.config === "object" ? { ...existing.config } : {};
  }
  config.plugins.entries[PLUGIN_ID] = next;
}

function ensurePluginLoadPath(config, pluginDir) {
  config.plugins ??= {};
  config.plugins.load ??= {};
  const paths = Array.isArray(config.plugins.load.paths) ? config.plugins.load.paths.slice() : [];
  const hasPluginPath = paths.some((entry) => path.resolve(String(entry || "")) === path.resolve(pluginDir));
  if (!hasPluginPath) paths.push(pluginDir);
  config.plugins.load.paths = paths;
}

function collectWarnings(config) {
  const warnings = [];
  if (config?.tools?.agentToAgent?.enabled !== true) {
    warnings.push("tools.agentToAgent.enabled is not true; mission-deck requires agent-to-agent support.");
  }
  const agents = Array.isArray(config?.agents?.list) ? config.agents.list : [];
  if (agents.length === 0) {
    warnings.push("agents.list is empty or missing; mission-deck works best when agents are explicitly configured.");
  }
  return warnings;
}

async function installPluginTree(pluginDir) {
  await mkdir(path.dirname(pluginDir), { recursive: true });
  await cp(PACKAGE_ROOT, pluginDir, {
    recursive: true,
    force: true,
    filter(source) {
      const relative = path.relative(PACKAGE_ROOT, source);
      if (!relative) return true;
      if (relative === "dashboard/status.json") return false;
      if (relative.startsWith(`dashboard${path.sep}data${path.sep}`)) return false;
      if (relative.endsWith(".tgz")) return false;
      if (relative === "node_modules") return false;
      if (relative.startsWith(`node_modules${path.sep}`)) return false;
      if (relative === ".git") return false;
      if (relative.startsWith(`.git${path.sep}`)) return false;
      return true;
    }
  });
}

async function executeInstall(argv, runtime = {}) {
  const args = parseArgs(argv);
  if (args.help) {
    return { help: usage() };
  }

  const pluginDir = args.pluginDir || path.join(args.openclawHome, "extensions", PLUGIN_ID);
  const configPath = args.configPath || path.join(args.openclawHome, "openclaw.json");
  const configExists = await exists(configPath);

  const result = {
    ok: true,
    dryRun: !args.apply,
    pluginId: PLUGIN_ID,
    pluginSource: PACKAGE_ROOT,
    pluginInstalled: false,
    configUpdated: false,
    restartRequired: false,
    pluginDir,
    configPath,
    service: args.service || "",
    warnings: [],
    notes: [],
    verification: null,
    restart: null
  };

  if (!configExists) {
    result.ok = false;
    result.warnings.push(`Config file not found: ${configPath}`);
    result.notes.push("Create or point to an existing openclaw.json before applying the install.");
    return result;
  }

  const config = await readJson(configPath);
  result.warnings.push(...collectWarnings(config));
  result.notes.push("Static config alone cannot prove TaskFlow runtime support; verify after restart on the target host.");

  if (!args.apply) {
    if (args.verify && configExists) {
      result.verification = await verifyInstall(pluginDir, configPath);
      if (!result.verification.ok) {
        result.notes.push("Verification ran against the current target state and found missing install artifacts or config.");
      }
    }
    result.notes.push("Dry run only. Re-run with --apply to copy the plugin and update openclaw.json.");
    return result;
  }

  await installPluginTree(pluginDir);
  result.pluginInstalled = true;

  ensurePluginEntry(config, pluginDir);
  ensurePluginLoadPath(config, pluginDir);
  await writeFile(configPath, stableJson(config), "utf8");
  result.configUpdated = true;
  result.restartRequired = true;
  if (args.verify) {
    result.verification = await verifyInstall(pluginDir, configPath);
    if (!result.verification.ok) {
      result.ok = false;
      result.warnings.push("Verification failed after apply.");
    }
  }
  if (args.restart) {
    result.restart = (runtime.restartService || restartService)(args.service);
    if (!result.restart.ok) {
      result.ok = false;
      result.warnings.push(`Failed to restart service: ${args.service}`);
    }
  }

  return result;
}

function emitResult(result, jsonOnly) {
  if (jsonOnly) {
    process.stdout.write(stableJson(result));
    return;
  }
  process.stdout.write(stableJson(result));
}

export {
  executeInstall,
  parseArgs
};

const isDirectRun = process.argv[1] && path.resolve(process.argv[1]) === __filename;

if (isDirectRun) {
  await executeInstall(process.argv.slice(2)).then((result) => {
    if (result?.help) {
      process.stdout.write(`${result.help}\n`);
      return;
    }
    emitResult(result, result?.dryRun === undefined ? false : parseArgs(process.argv.slice(2)).json);
    if (result?.ok === false) process.exitCode = 1;
  }).catch((error) => {
    const failure = {
      ok: false,
      error: error?.message || String(error)
    };
    process.stdout.write(stableJson(failure));
    process.exitCode = 1;
  });
}
