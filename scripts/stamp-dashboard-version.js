#!/usr/bin/env node

import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PACKAGE_ROOT = path.resolve(__dirname, "..");
const DASHBOARD_DIR = path.join(PACKAGE_ROOT, "dashboard");
const APP_JS = path.join(DASHBOARD_DIR, "app.js");
const INDEX_HTML = path.join(DASHBOARD_DIR, "index.html");
const JS_FILES = [
  "app.js",
  "app-graph-models.js",
  "app-renderers.js",
  "app-task-core.js",
  "app-timeline-models.js"
].map((name) => path.join(DASHBOARD_DIR, name));

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

async function readPackageVersion() {
  const raw = await readFile(path.join(PACKAGE_ROOT, "package.json"), "utf8");
  return JSON.parse(raw).version || "0.0.0";
}

async function replaceInFile(filePath, replacer) {
  const before = await readFile(filePath, "utf8");
  const after = replacer(before);
  if (after !== before) await writeFile(filePath, after, "utf8");
}

const pkgVersion = await readPackageVersion();
const stamp = buildStamp();
const dashboardVersion = `v${pkgVersion}+${stamp}`;

for (const filePath of JS_FILES) {
  await replaceInFile(filePath, (source) => source.replaceAll(/dashboard-live-[a-z0-9-]+/g, stamp));
}

await replaceInFile(APP_JS, (source) =>
  source.replace(/const DASHBOARD_VERSION = ".*?";/, `const DASHBOARD_VERSION = "${dashboardVersion}";`)
);

await replaceInFile(INDEX_HTML, (source) =>
  source.replaceAll(/dashboard-live-[a-z0-9-]+/g, stamp)
);

process.stdout.write(`${dashboardVersion}\n`);
