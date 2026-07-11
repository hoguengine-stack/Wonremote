import { spawn } from "node:child_process";
import path from "node:path";
import { WONREMOTE_APP_VERSION } from "../domain/appVersion";
import { isHigherVersion } from "../domain/versioning";
import {
  downloadInstallerUpdate,
  prepareInstallerHandoff,
  type InstallerDownloadResult,
  type InstallerHandoffResult,
  type InstallerRestartMode,
} from "./productionInstallerUpdate";
import { loadProductionInstallerUpdateMetadata } from "./productionUpdateMetadata";

export const UPDATE_ONCE_EXIT = {
  success: 0,
  invalidArguments: 2,
  metadataUnavailable: 3,
  updateFailed: 4,
} as const;

export interface UpdateOnceOptions {
  baseDir: string;
  restartMode: InstallerRestartMode;
}

export interface UpdateOnceResult {
  latestVersion: string;
  status: "handoff-started" | "up-to-date";
}

interface UpdateOnceDeps {
  currentVersion: string;
  downloadInstaller: typeof downloadInstallerUpdate;
  launchHandoff: (handoff: InstallerHandoffResult) => void;
  loadMetadata: typeof loadProductionInstallerUpdateMetadata;
  prepareHandoff: (
    download: InstallerDownloadResult,
    options: { baseDir: string; restartMode: InstallerRestartMode },
  ) => Promise<InstallerHandoffResult>;
}

const defaultDeps: UpdateOnceDeps = {
  currentVersion: WONREMOTE_APP_VERSION,
  downloadInstaller: downloadInstallerUpdate,
  launchHandoff: launchInstallerHandoff,
  loadMetadata: loadProductionInstallerUpdateMetadata,
  prepareHandoff: prepareInstallerHandoff,
};

export class UpdateOnceError extends Error {
  constructor(
    message: string,
    readonly exitCode: number,
  ) {
    super(message);
  }
}

export function parseUpdateOnceOptions(
  argv: string[],
  env: Partial<Record<"APPDATA", string>> = process.env,
): UpdateOnceOptions {
  let restartMode: InstallerRestartMode | undefined;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--update-once") {
      continue;
    }
    if (arg === "--restart-mode") {
      restartMode = parseRestartMode(argv[index + 1]);
      index += 1;
      continue;
    }
    if (arg.startsWith("--restart-mode=")) {
      restartMode = parseRestartMode(arg.slice("--restart-mode=".length));
      continue;
    }
    throw new UpdateOnceError(`Unknown update option: ${arg}`, UPDATE_ONCE_EXIT.invalidArguments);
  }
  if (!restartMode) {
    throw new UpdateOnceError(
      "--restart-mode viewer|agent is required with --update-once.",
      UPDATE_ONCE_EXIT.invalidArguments,
    );
  }
  return {
    baseDir: path.resolve(env.APPDATA?.trim() || process.cwd()),
    restartMode,
  };
}

export async function runUpdateOnce(
  options: UpdateOnceOptions,
  deps: UpdateOnceDeps = defaultDeps,
): Promise<UpdateOnceResult> {
  const metadata = await deps.loadMetadata(process.env);
  if (!metadata) {
    throw new UpdateOnceError(
      "Production update metadata is unavailable.",
      UPDATE_ONCE_EXIT.metadataUnavailable,
    );
  }
  if (!metadata.forceUpdate && !isHigherVersion(metadata.latestVersion, deps.currentVersion)) {
    return {
      latestVersion: metadata.latestVersion,
      status: "up-to-date",
    };
  }

  try {
    const download = await deps.downloadInstaller(metadata, { baseDir: options.baseDir });
    const handoff = await deps.prepareHandoff(download, {
      baseDir: options.baseDir,
      restartMode: options.restartMode,
    });
    deps.launchHandoff(handoff);
    return {
      latestVersion: metadata.latestVersion,
      status: "handoff-started",
    };
  } catch (error) {
    throw new UpdateOnceError(
      `Verified installer update failed: ${error instanceof Error ? error.message : String(error)}`,
      UPDATE_ONCE_EXIT.updateFailed,
    );
  }
}

export async function handleUpdateOnceCli(
  argv: string[] = process.argv.slice(2),
  env: Partial<Record<"APPDATA", string>> = process.env,
): Promise<number> {
  try {
    const options = parseUpdateOnceOptions(argv, env);
    const result = await runUpdateOnce(options);
    console.log(
      result.status === "handoff-started"
        ? `[WonRemote Updater] Installer handoff started for ${result.latestVersion}; restart mode: ${options.restartMode}.`
        : `[WonRemote Updater] Already up to date at ${result.latestVersion}.`,
    );
    return UPDATE_ONCE_EXIT.success;
  } catch (error) {
    const updateError = error instanceof UpdateOnceError
      ? error
      : new UpdateOnceError(
          error instanceof Error ? error.message : String(error),
          UPDATE_ONCE_EXIT.updateFailed,
        );
    console.error(`[WonRemote Updater] ${updateError.message}`);
    return updateError.exitCode;
  }
}

function parseRestartMode(value: string | undefined): InstallerRestartMode {
  if (value === "viewer" || value === "agent") {
    return value;
  }
  throw new UpdateOnceError(
    "--restart-mode must be viewer or agent.",
    UPDATE_ONCE_EXIT.invalidArguments,
  );
}

function launchInstallerHandoff(handoff: InstallerHandoffResult): void {
  const child = spawn(handoff.command, handoff.args, {
    detached: true,
    stdio: "ignore",
    windowsHide: true,
    creationFlags: handoff.creationFlags,
  } as any);
  child.unref();
}
