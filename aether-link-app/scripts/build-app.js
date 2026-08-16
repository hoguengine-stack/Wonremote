import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const supportedStages = new Set(["full", "frontend-only", "backend-only", "reuse"]);

export const requiredReuseArtifacts = [
  "dist/index.html",
  "dist-server/index.mjs",
  "dist-agent/index.mjs",
  "dist-runtime/node.exe",
  "dist-native/node-datachannel",
  "dist-poc/wonremote-poc.exe",
  "dist-poc/vcruntime140.dll",
  "dist-agent-pkg/node.exe",
  "dist-agent-pkg/agent.mjs",
  "dist-agent-pkg/bin/wonremote-poc.exe",
  "dist-agent-pkg/bin/vcruntime140.dll",
  "dist-agent-pkg/node_modules/node-datachannel",
  "dist-agent-pkg/wonremote-agent.bat",
];

export function resolveBuildStage(value) {
  const stage = value?.trim().toLowerCase() || "full";
  if (!supportedStages.has(stage)) {
    throw new Error(
      `Unsupported WONREMOTE_BUILD_STAGE: ${value}. Expected full, frontend-only, backend-only, or reuse.`,
    );
  }
  return stage;
}

export function resolvePackageExecutable(command, platform = process.platform) {
  return platform === "win32" ? `${command}.cmd` : command;
}

export function createBuildCommands({
  stage,
  platform = process.platform,
  nodeExecutable = process.execPath,
} = {}) {
  const resolvedStage = resolveBuildStage(stage);
  const frontendCommands = [
    { command: resolvePackageExecutable("npx", platform), args: ["tsc"] },
    { command: resolvePackageExecutable("npx", platform), args: ["vite", "build"] },
  ];
  const backendCommands = [
    { command: nodeExecutable, args: ["scripts/build-backend.js"] },
    {
      command: resolvePackageExecutable("npm", platform),
      args: ["run", "agent:package"],
    },
  ];

  if (resolvedStage === "frontend-only") return frontendCommands;
  if (resolvedStage === "backend-only") return backendCommands;
  if (resolvedStage === "reuse") return [];
  return [...frontendCommands, ...backendCommands];
}

export function validateReuseArtifacts({
  rootDir = appRoot,
  exists = fs.existsSync,
} = {}) {
  const missing = requiredReuseArtifacts
    .map((relativePath) => path.join(rootDir, ...relativePath.split("/")))
    .filter((artifactPath) => !exists(artifactPath));

  if (missing.length > 0) {
    throw new Error(`Reuse build artifacts are missing:\n${missing.map((item) => `- ${item}`).join("\n")}`);
  }
}

export function createSpawnInvocation(
  commandSpec,
  {
    platform = process.platform,
    comSpec = process.env.ComSpec || "cmd.exe",
  } = {},
) {
  if (platform === "win32" && commandSpec.command.toLowerCase().endsWith(".cmd")) {
    return {
      command: comSpec,
      args: ["/d", "/s", "/c", commandSpec.command, ...commandSpec.args],
    };
  }
  return commandSpec;
}

export function runCommand(
  commandSpec,
  {
    cwd = appRoot,
    env = process.env,
    platform = process.platform,
    comSpec = env.ComSpec || "cmd.exe",
    spawn = spawnSync,
  } = {},
) {
  const { command, args } = createSpawnInvocation(commandSpec, { platform, comSpec });
  const result = spawn(command, args, {
    cwd,
    env,
    shell: false,
    stdio: "inherit",
    windowsHide: true,
  });

  if (result.error) {
    throw new Error(`Failed to start ${command}: ${result.error.message}`, { cause: result.error });
  }
  if (result.status !== 0) {
    const outcome = result.signal ? `signal ${result.signal}` : `exit code ${result.status}`;
    throw new Error(`${command} ${args.join(" ")} failed with ${outcome}.`);
  }
}

export function runBuild({
  env = process.env,
  rootDir = appRoot,
  platform = process.platform,
  nodeExecutable = process.execPath,
  spawn = spawnSync,
  exists = fs.existsSync,
} = {}) {
  const stage = resolveBuildStage(env.WONREMOTE_BUILD_STAGE);
  if (stage === "reuse") {
    validateReuseArtifacts({ rootDir, exists });
    return;
  }

  for (const command of createBuildCommands({ stage, platform, nodeExecutable })) {
    runCommand(command, { cwd: rootDir, env, platform, spawn });
  }
}

const isDirectExecution = process.argv[1]
  && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isDirectExecution) {
  try {
    runBuild();
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}
