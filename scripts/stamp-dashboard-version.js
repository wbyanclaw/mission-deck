#!/usr/bin/env node

import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DEFAULT_PACKAGE_ROOT = path.resolve(__dirname, "..");
const DASHBOARD_FILES = [
  "app.js",
  "app-dom.js",
  "app-graph-models.js",
  "app-renderers.js",
  "app-task-core.js",
  "app-timeline-models.js",
  "app-utils.js"
];

function pad(value) {
  return String(value).padStart(2, "0");
}

function buildStamp(date = new Date()) {
  const timestamp = [
    date.getFullYear(),
    pad(date.getMonth() + 1),
    pad(date.getDate()),
    pad(date.getHours()),
    pad(date.getMinutes()),
    pad(date.getSeconds())
  ].join("");
  const random = Math.random().toString(36).slice(2, 8);
  return `dashboard-live-${timestamp}-${random}`;
}

async function readPackageVersion(packageRoot) {
  const raw = await readFile(path.join(packageRoot, "package.json"), "utf8");
  return JSON.parse(raw).version || "0.0.0";
}

async function replaceInFile(filePath, replacer) {
  const before = await readFile(filePath, "utf8");
  const after = replacer(before);
  if (after !== before) await writeFile(filePath, after, "utf8");
}

function parseArgs(argv) {
  const out = {
    root: DEFAULT_PACKAGE_ROOT
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--root") out.root = path.resolve(argv[++i] || "");
    else if (arg === "--help" || arg === "-h") out.help = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return out;
}

async function stampDashboardVersion(packageRoot = DEFAULT_PACKAGE_ROOT) {
  const dashboardDir = path.join(packageRoot, "dashboard");
  const appJs = path.join(dashboardDir, "app.js");
  const indexHtml = path.join(dashboardDir, "index.html");
  const pkgVersion = await readPackageVersion(packageRoot);
  const stamp = buildStamp();
  const dashboardVersion = `v${pkgVersion}+${stamp}`;

  for (const filePath of DASHBOARD_FILES.map((name) => path.join(dashboardDir, name))) {
    await replaceInFile(filePath, (source) => source.replaceAll(/dashboard-live-[a-z0-9-]+/g, stamp));
  }

  await replaceInFile(appJs, (source) =>
    source.replace(/const DASHBOARD_VERSION = ".*?";/, `const DASHBOARD_VERSION = "${dashboardVersion}";`)
  );

  await replaceInFile(indexHtml, (source) =>
    source.replaceAll(/dashboard-live-[a-z0-9-]+/g, stamp)
  );

  return dashboardVersion;
}

const isDirectRun = process.argv[1] && path.resolve(process.argv[1]) === __filename;

export {
  stampDashboardVersion
};

if (isDirectRun) {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    process.stdout.write("stamp-dashboard-version [--root <plugin-dir>]\n");
  } else {
    const dashboardVersion = await stampDashboardVersion(args.root);
    process.stdout.write(`${dashboardVersion}\n`);
  }
}
