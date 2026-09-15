import { verify } from "node:crypto";
import { parseProductionUpdateManifest, type ProductionUpdateMetadata } from "../domain/updateManifest";
import { resolveProductionUpdatePublicKey } from "../domain/updateTrust";

export const SELECTED_VIEWER_POLICY_URL = "https://wonremote-a7fd3.web.app/updates/viewer-selected.json";
export function selectedViewerPolicyPayload(payload: unknown): string { return JSON.stringify(payload); }

export async function loadSelectedViewerUpdate(
  env: NodeJS.ProcessEnv = process.env,
  fetchImpl: typeof fetch = fetch,
  now = Date.now(),
): Promise<ProductionUpdateMetadata | null> {
  const identity = env.WONREMOTE_VIEWER_INSTALL_ID?.trim().toUpperCase();
  if (!identity || !/^[A-F0-9]{8}$/.test(identity) || env.WONREMOTE_UPDATE_PRODUCT !== "viewer") return null;
  const response = await fetchImpl(SELECTED_VIEWER_POLICY_URL, { signal: AbortSignal.timeout(10_000), cache: "no-store" });
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`Selected Viewer policy unavailable: ${response.status}`);
  if (!response.body) throw new Error("Selected Viewer policy is empty");
  const reader = response.body.getReader();
  const bytes = new Uint8Array(65536);
  let size = 0;
  let finished = false;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) { finished = true; break; }
      if (value.byteLength > bytes.length - size) throw new Error("Selected Viewer policy is too large");
      bytes.set(value, size);
      size += value.byteLength;
    }
  } finally {
    if (!finished) await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
  const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, size));
  const envelope = JSON.parse(text);
  const key = resolveProductionUpdatePublicKey(env);
  if (!envelope.payload || typeof envelope.signature !== "string" || !verify(null, Buffer.from(selectedViewerPolicyPayload(envelope.payload)), key, Buffer.from(envelope.signature, "base64"))) throw new Error("Selected Viewer policy signature invalid");
  const policy = envelope.payload;
  if (policy.product !== "viewer" || policy.enabled !== true) return null;
  const expires = Date.parse(policy.expiresAt);
  if (!Number.isFinite(expires) || expires <= now || expires > now + 7 * 86400000) throw new Error("Selected Viewer policy expired or invalid");
  if (!Array.isArray(policy.targetInstallIds) || policy.targetInstallIds.length > 100 || policy.targetInstallIds.some((id: unknown) => typeof id !== "string" || !/^[A-F0-9]{8}$/.test(id))) throw new Error("Invalid Viewer targets");
  if (!policy.targetInstallIds.includes(identity)) return null;
  const metadata = parseProductionUpdateManifest(policy.manifest, { product: "viewer", arch: "x86", assetKind: "installer", publicKeyPem: key });
  const expected = `https://github.com/hoguengine-stack/Wonremote/releases/download/v${metadata.latestVersion}/WonRemote-Viewer-Setup.exe`;
  if (!/^\d+\.\d+\.\d+$/.test(metadata.latestVersion) || metadata.downloadUrl !== expected || metadata.assetName !== "WonRemote-Viewer-Setup.exe") throw new Error("Selected Viewer requires version-pinned official installer");
  return { ...metadata, forceUpdate: false };
}
