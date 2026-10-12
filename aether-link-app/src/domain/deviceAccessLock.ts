export type DeviceAccessOperation = "connect" | "set" | "disable" | "reset";
export interface DeviceAccessState {
  enabled: boolean;
  version: string;
  publicKey: string;
}
export interface DeviceAccessRequest {
  id: string;
  deviceId: string;
  ownerUid: string;
  operation: DeviceAccessOperation;
  sessionId: string;
  lockVersion: string;
  key: string;
  iv: string;
  ciphertext: string;
}
export interface DeviceAccessCredentials { password: string; newPassword?: string }
export const DEVICE_ACCESS_TTL_MS = 120_000;

export function accessRequestAad(request: Pick<DeviceAccessRequest, "id" | "deviceId" | "ownerUid" | "operation" | "sessionId" | "lockVersion">): string {
  return JSON.stringify([request.id, request.deviceId, request.ownerUid, request.operation, request.sessionId, request.lockVersion]);
}

function toBase64(value: ArrayBuffer): string {
  return btoa(String.fromCharCode(...new Uint8Array(value)));
}
function fromBase64(value: string): Uint8Array<ArrayBuffer> {
  return Uint8Array.from(atob(value), character => character.charCodeAt(0));
}

export async function encryptDeviceAccessRequest(
  input: Omit<DeviceAccessRequest, "key" | "iv" | "ciphertext">,
  publicKey: string,
  credentials: DeviceAccessCredentials,
): Promise<DeviceAccessRequest> {
  const rsa = await crypto.subtle.importKey("spki", fromBase64(publicKey), {name:"RSA-OAEP", hash:"SHA-256"}, false, ["encrypt"]);
  const key = await crypto.subtle.generateKey({name:"AES-GCM", length:256}, true, ["encrypt"]);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt({name:"AES-GCM", iv, additionalData:new TextEncoder().encode(accessRequestAad(input))}, key, new TextEncoder().encode(JSON.stringify(credentials)));
  const wrapped = await crypto.subtle.encrypt({name:"RSA-OAEP"}, rsa, await crypto.subtle.exportKey("raw", key));
  return {...input, key:toBase64(wrapped), iv:toBase64(iv.buffer), ciphertext:toBase64(ciphertext)};
}
