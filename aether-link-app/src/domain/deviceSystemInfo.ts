export interface DeviceSystemInfo {
  cpuModel: string;
  memoryBytes: number;
  osVersion: string;
}

const MAX_TEXT_LENGTH = 120;
const GIB = 1024 ** 3;

export function sanitizeDeviceSystemInfo(value: unknown): DeviceSystemInfo | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }

  const record = value as Record<string, unknown>;
  const cpuModel = sanitizeText(record.cpuModel);
  const osVersion = sanitizeText(record.osVersion);
  const memoryBytes = record.memoryBytes;
  if (
    !cpuModel
    || !osVersion
    || typeof memoryBytes !== "number"
    || !Number.isSafeInteger(memoryBytes)
    || memoryBytes <= 0
  ) {
    return undefined;
  }

  return { cpuModel, memoryBytes, osVersion };
}

export function formatDeviceSystemInfo(info: unknown): string {
  const sanitized = sanitizeDeviceSystemInfo(info);
  if (!sanitized) {
    return "정보 없음";
  }

  return `${compactCpuModel(sanitized.cpuModel)} · ${formatMemory(sanitized.memoryBytes)} · ${sanitized.osVersion}`;
}

function sanitizeText(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const normalized = value.trim().replace(/\s+/gu, " ");
  return normalized ? normalized.slice(0, MAX_TEXT_LENGTH) : undefined;
}

function compactCpuModel(model: string): string {
  const normalized = model
    .replace(/\((?:R|TM)\)/giu, "")
    .replace(/\s+@\s+[\d.]+\s*GHz.*$/iu, "")
    .replace(/\s+with Radeon Graphics$/iu, "")
    .replace(/\s+/gu, " ")
    .trim();

  const compactIntel = normalized.match(/\b(?:N\d{2,4}|J\d{4})\b/iu)?.[0];
  if (compactIntel) {
    return compactIntel.toUpperCase();
  }

  const intelCore = normalized.match(/\bi[3579]-?\d{3,5}[A-Z]{0,2}\b/iu)?.[0];
  if (intelCore) {
    return intelCore;
  }

  const ryzen = normalized.match(/\bRyzen\s+\d(?:\s+PRO)?\s+\d{4}[A-Z]{0,3}\b/iu)?.[0];
  if (ryzen) {
    return ryzen;
  }

  const fallback = normalized.replace(/\s+(?:CPU|Processor)\b/giu, "").trim();
  return fallback.length <= 32 ? fallback : `${fallback.slice(0, 31).trimEnd()}…`;
}

function formatMemory(memoryBytes: number): string {
  return `${Math.max(1, Math.round(memoryBytes / GIB))}GB`;
}
