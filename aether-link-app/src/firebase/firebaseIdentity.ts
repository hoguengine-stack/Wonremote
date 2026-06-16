export function normalizeBusinessDigits(value: string): string {
  const digits = value.replace(/\D/g, "");
  if (digits.length !== 10) {
    throw new Error("사업자등록번호는 숫자 10자리여야 합니다.");
  }
  return digits;
}

export function formatBusinessNumber(value: string): string {
  const digits = normalizeBusinessDigits(value);
  return `${digits.slice(0, 3)}-${digits.slice(3, 5)}-${digits.slice(5)}`;
}

export function buildAgentAuthEmail(businessNumber: string): string {
  return `${normalizeBusinessDigits(businessNumber)}@agents.wonremote.app`;
}

export function buildAgentAuthPassword(businessNumber: string, password: string): string {
  if (password !== "1234") {
    throw new Error("Agent password is invalid.");
  }
  return `wonremote-${normalizeBusinessDigits(businessNumber)}-${password}`;
}

export function buildViewerAuthCredentials(username: string, password: string): { email: string; password: string } {
  const normalizedUsername = username.trim();
  const normalizedPassword = password.trim();
  if (/^\d{3}-?\d{2}-?\d{5}$/.test(normalizedUsername)) {
    return {
      email: buildAgentAuthEmail(normalizedUsername),
      password: buildAgentAuthPassword(normalizedUsername, normalizedPassword),
    };
  }
  return {
    email: normalizedUsername,
    password: normalizedPassword,
  };
}

export function buildAgentDeviceNumber(installId: string): string {
  const suffix = installId
    .trim()
    .replace(/^agent[-_]?/i, "")
    .replace(/[^a-zA-Z0-9-]/g, "")
    .toUpperCase()
    .slice(0, 16);
  if (!suffix) {
    throw new Error("Agent 설치 식별자를 확인할 수 없습니다.");
  }
  return `AGENT-${suffix}`;
}

export function buildFirebaseDeviceId(businessNumber: string, installId: string): string {
  return `${formatBusinessNumber(businessNumber)}:${buildAgentDeviceNumber(installId)}`;
}

export function buildDesktopName(businessNumber: string, installId: string): string {
  const formattedBusinessNumber = formatBusinessNumber(businessNumber);
  return `DESKTOP-${formattedBusinessNumber.slice(-5)}-${buildAgentDeviceNumber(installId)}`;
}
