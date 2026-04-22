import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { executeInstall } from "../bin/mission-deck-install.js";

async function makeOpenClawHome(configObject) {
  const root = await mkdtemp(join(tmpdir(), "mission-deck-install-test-"));
  const openclawHome = join(root, ".openclaw");
  await mkdir(openclawHome, { recursive: true });
  await writeFile(
    join(openclawHome, "openclaw.json"),
    `${JSON.stringify(configObject, null, 2)}\n`,
    "utf8"
  );
  return openclawHome;
}

async function runInstaller(args, runtime = {}) {
  const result = await executeInstall(args, runtime);
  return {
    status: result?.ok === false ? 1 : 0,
    stdoutJson: result
  };
}

test("installer dry-run reports pending work and keeps target untouched", async () => {
  const home = await makeOpenClawHome({
    agents: { list: [{ id: "main" }] },
    tools: { agentToAgent: { enabled: true } }
  });

  const result = await runInstaller(["--json", "--openclaw-home", home]);
  assert.equal(result.status, 0);
  assert.equal(result.stdoutJson.ok, true);
  assert.equal(result.stdoutJson.dryRun, true);
  assert.equal(result.stdoutJson.pluginInstalled, false);
  assert.equal(result.stdoutJson.configUpdated, false);

  const configAfter = JSON.parse(await readFile(join(home, "openclaw.json"), "utf8"));
  assert.equal(configAfter.plugins, undefined);
});

test("installer apply with verify copies plugin tree and writes config entry", async () => {
  const home = await makeOpenClawHome({
    agents: { list: [{ id: "main" }] },
    tools: { agentToAgent: { enabled: true } }
  });

  const result = await runInstaller(["--apply", "--verify", "--json", "--openclaw-home", home]);
  assert.equal(result.status, 0);
  assert.equal(result.stdoutJson.ok, true);
  assert.equal(result.stdoutJson.pluginInstalled, true);
  assert.equal(result.stdoutJson.configUpdated, true);
  assert.equal(result.stdoutJson.verification?.ok, true);

  const configAfter = JSON.parse(await readFile(join(home, "openclaw.json"), "utf8"));
  const pluginEntry = configAfter?.plugins?.entries?.["mission-deck"];
  assert.equal(pluginEntry.enabled, true);
  assert.deepEqual(pluginEntry.config, {});
  assert.equal(
    configAfter?.plugins?.load?.paths?.some((entry) => resolve(entry) === resolve(join(home, "extensions", "mission-deck"))),
    true
  );
});

test("installer excludes release tarballs from local checkout copies", async () => {
  const home = await makeOpenClawHome({
    agents: { list: [{ id: "dispatcher" }] },
    tools: { agentToAgent: { enabled: true } }
  });

  const result = await runInstaller(["--apply", "--json", "--openclaw-home", home]);
  assert.equal(result.status, 0);

  const installedFiles = await readdir(join(home, "extensions", "mission-deck"));
  assert.equal(installedFiles.some((name) => name.endsWith(".tgz")), false);
});

test("installer verify on dry-run reports missing install artifacts when target is not yet installed", async () => {
  const home = await makeOpenClawHome({
    agents: { list: [{ id: "main" }] },
    tools: { agentToAgent: { enabled: true } }
  });

  const result = await runInstaller(["--verify", "--json", "--openclaw-home", home]);
  assert.equal(result.status, 0);
  assert.equal(result.stdoutJson.dryRun, true);
  assert.equal(result.stdoutJson.verification?.ok, false);
  assert.equal(result.stdoutJson.verification?.checks?.pluginDirExists, false);
  assert.match(result.stdoutJson.notes.join("\n"), /Verification ran against the current target state/);
});
