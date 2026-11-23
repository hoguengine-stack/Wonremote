import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { copyFile, lstat, mkdir, readFile, realpath, rm } from "node:fs/promises";
import path from "node:path";
import { WONREMOTE_APP_VERSION } from "../domain/appVersion";
import { parseProductionUpdateManifest } from "../domain/updateManifest";
import { BUNDLED_UPDATE_MANIFEST_PUBLIC_KEY } from "../domain/updateTrust";
import { isHigherVersion } from "../domain/versioning";
import { formatPreparedUpdateHandoff, INSTALLER_UPDATE_HANDOFF_BROKER_PREFIX } from "./agentUpdateHandoffBroker";
import { prepareInstallerHandoff } from "./productionInstallerUpdate";

const baselineVersion = "0.1.120";
const bridgeReleaseTag = "internal-wonremote-agent120-bridge123-20261123";
const assetName = "WonRemote-Agent-Update.exe";
const stableVersion = /^(0|[1-9]\d{0,5})\.(0|[1-9]\d{0,5})\.(0|[1-9]\d{0,5})$/;

function localPath(value: string | undefined): string {
  if (!value || !path.isAbsolute(value) || /^[\\/]{2}/.test(value)
      || (process.platform === "win32" && (!/^[a-z]:[\\/]/i.test(value) || value.slice(2).includes(":")))) {
    throw new Error("First hop requires local absolute paths.");
  }
  return path.normalize(value);
}

async function verifyLocalPath(value: string, directory: boolean) {
  const details = await lstat(value);
  if (!(directory ? details.isDirectory() : details.isFile()) || path.relative(value, localPath(await realpath(value))) !== "") {
    throw new Error("First hop refuses a redirected file or directory.");
  }
  return details;
}

async function ensureLocalDirectory(parent: string, name: string): Promise<string> {
  const directory = path.join(parent, name);
  try {
    await mkdir(directory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  await verifyLocalPath(directory, true);
  return directory;
}

function readFirstHopMetadata(manifest: unknown) {
  if (!manifest || typeof manifest !== "object" || !("agentFileUpdates" in manifest)
      || !manifest.agentFileUpdates || typeof manifest.agentFileUpdates !== "object"
      || !("x86" in manifest.agentFileUpdates)) {
    throw new Error("A signed agentFileUpdates.x86 asset is required.");
  }
  const asset = manifest.agentFileUpdates.x86;
  if (!asset || typeof asset !== "object" || !("name" in asset) || asset.name !== assetName) {
    throw new Error("First hop requires the exact x86 Agent File Update asset.");
  }
  const version = "version" in manifest ? manifest.version : undefined;
  if (typeof version !== "string" || !stableVersion.test(version) || version !== WONREMOTE_APP_VERSION
      || !isHigherVersion(version, baselineVersion)) {
    throw new Error("The File Update version must match this newer bundled release.");
  }
  const metadata = parseProductionUpdateManifest({
    version,
    forceUpdate: "forceUpdate" in manifest ? manifest.forceUpdate : undefined,
    agentWindows: { x86: asset },
  }, { arch: "x86", product: "agent", assetKind: "installer", publicKeyPem: BUNDLED_UPDATE_MANIFEST_PUBLIC_KEY });
  const expectedUrl = "https://github.com/hoguengine-stack/Wonremote/releases/download/" + bridgeReleaseTag + "/" + assetName;
  if (metadata.forceUpdate || metadata.downloadUrl !== expectedUrl) {
    throw new Error("First hop requires the signed version-pinned Agent File Update.");
  }
  return metadata;
}

export async function prepareLegacyAgentFirstHop(
  argv: string[],
  env: NodeJS.ProcessEnv = process.env,
): Promise<string> {
  if (argv.length !== 4 || argv[0] !== "--legacy-agent-first-hop") throw new Error("Invalid first-hop arguments.");
  if (env.WONREMOTE_TAURI_UPDATE_BROKER !== "1") throw new Error("First hop requires the protected update broker.");
  const manifestPath = localPath(argv[1]);
  const sourceUpdate = localPath(argv[2]);
  const restartExecutablePath = localPath(argv[3]);
  const appData = localPath(env.APPDATA);
  if (path.extname(sourceUpdate).toLowerCase() !== ".exe"
      || path.basename(restartExecutablePath).toLowerCase() !== "wonremote-viewer.exe") {
    throw new Error("First hop requires an EXE asset and the registered Agent host.");
  }

  const [manifestInfo] = await Promise.all([
    verifyLocalPath(manifestPath, false),
    verifyLocalPath(sourceUpdate, false),
    verifyLocalPath(restartExecutablePath, false),
    verifyLocalPath(appData, true),
  ]);
  if (manifestInfo.size <= 0 || manifestInfo.size > 1024 * 1024) throw new Error("Invalid first-hop manifest size.");
  const metadata = readFirstHopMetadata(JSON.parse(await readFile(manifestPath, "utf8")));
  const wonRemote = await ensureLocalDirectory(appData, "WonRemote");
  const updates = await ensureLocalDirectory(wonRemote, "updates");
  const stagedUpdate = path.join(updates, "legacy-first-hop-" + randomUUID() + ".exe");
  await copyFile(sourceUpdate, stagedUpdate, constants.COPYFILE_EXCL);
  try {
    const handoff = await prepareInstallerHandoff(
      { installerPath: stagedUpdate, installerSha256: metadata.checksum, installerArgs: metadata.installerArgs ?? ["/S"] },
      { baseDir: appData, restartExecutablePath, restartMode: "agent", targetVersion: metadata.latestVersion, legacyFirstHop: true },
    );
    const response = formatPreparedUpdateHandoff(handoff);
    if (!response.startsWith(INSTALLER_UPDATE_HANDOFF_BROKER_PREFIX)) {
      throw new Error("First hop did not prepare a protected installer request.");
    }
    return response;
  } catch (error) {
    await rm(stagedUpdate, { force: true });
    throw error;
  }
}
