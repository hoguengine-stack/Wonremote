export type IosProbeStatus = "pass" | "limited" | "fail" | "pending";

export type IosProbeCheckId =
  | "ios-device"
  | "secure-context"
  | "webrtc"
  | "pointer-events"
  | "clipboard-text"
  | "clipboard-image"
  | "file-access"
  | "fullscreen"
  | "home-screen"
  | "service-worker"
  | "ime"
  | "background-resume"
  | "agent-session"
  | "first-frame"
  | "remote-pointer"
  | "remote-clipboard-image"
  | "remote-file";

export interface IosProbeCheck {
  id: IosProbeCheckId;
  label: string;
  status: IosProbeStatus;
  detail: string;
}

export interface IosProbeSnapshot {
  isIosDevice: boolean;
  isSecureContext: boolean;
  hasWebRtc: boolean;
  hasPointerEvents: boolean;
  hasClipboardText: boolean;
  hasClipboardImage: boolean;
  hasFileAccess: boolean;
  hasFullscreen: boolean;
  isStandalone: boolean;
  hasServiceWorker: boolean;
}

export function isIosLike(userAgent: string, platform: string, maxTouchPoints: number): boolean {
  return /iPad|iPhone|iPod/i.test(userAgent)
    || (platform === "MacIntel" && maxTouchPoints > 1);
}

export function createIosProbeChecks(snapshot: IosProbeSnapshot): IosProbeCheck[] {
  const interactive = (id: IosProbeCheckId, label: string, detail: string): IosProbeCheck => ({
    id,
    label,
    status: "pending",
    detail,
  });

  return [
    {
      id: "ios-device",
      label: "iOS/iPadOS 환경",
      status: snapshot.isIosDevice ? "pass" : "limited",
      detail: snapshot.isIosDevice ? "Apple 모바일 환경 감지" : "현재 기기는 Apple 모바일 환경이 아님",
    },
    {
      id: "secure-context",
      label: "HTTPS 보안 컨텍스트",
      status: snapshot.isSecureContext ? "pass" : "fail",
      detail: snapshot.isSecureContext ? "보안 API 사용 가능" : "HTTPS 주소에서 다시 검사 필요",
    },
    {
      id: "webrtc",
      label: "WebRTC/DataChannel",
      status: snapshot.hasWebRtc ? "pass" : "fail",
      detail: snapshot.hasWebRtc ? "브라우저 API 사용 가능" : "RTCPeerConnection 또는 DataChannel 미지원",
    },
    {
      id: "pointer-events",
      label: "터치·포인터 이벤트",
      status: snapshot.hasPointerEvents ? "pass" : "fail",
      detail: snapshot.hasPointerEvents ? "Pointer Events 사용 가능" : "Pointer Events 미지원",
    },
    snapshot.hasClipboardText
      ? interactive("clipboard-text", "텍스트 클립보드", "사용자 조작으로 읽기·쓰기 검사 필요")
      : { id: "clipboard-text", label: "텍스트 클립보드", status: "fail", detail: "Clipboard API 미지원" },
    snapshot.hasClipboardImage
      ? interactive("clipboard-image", "이미지 클립보드", "PNG 선택 후 쓰기 검사 필요")
      : { id: "clipboard-image", label: "이미지 클립보드", status: "limited", detail: "ClipboardItem 이미지 API 미지원" },
    snapshot.hasFileAccess
      ? interactive("file-access", "파일 선택", "파일 선택기로 실제 접근 검사 필요")
      : { id: "file-access", label: "파일 선택", status: "fail", detail: "File API 미지원" },
    snapshot.hasFullscreen || snapshot.isStandalone
      ? interactive("fullscreen", "전체화면", "전체화면 전환 검사 필요")
      : { id: "fullscreen", label: "전체화면", status: "limited", detail: "Fullscreen API 미지원, 홈 화면 앱으로 대체 필요" },
    {
      id: "home-screen",
      label: "홈 화면 앱",
      status: snapshot.isStandalone ? "pass" : "pending",
      detail: snapshot.isStandalone ? "standalone 모드 실행 중" : "홈 화면에서 실행 후 재검사 필요",
    },
    snapshot.hasServiceWorker && snapshot.isSecureContext
      ? interactive("service-worker", "Service Worker", "등록 결과 확인 중")
      : { id: "service-worker", label: "Service Worker", status: "fail", detail: "HTTPS 또는 Service Worker 지원 필요" },
    interactive("ime", "한글 IME 조합", "아래 입력란에서 한글 조합 검사 필요"),
    interactive("background-resume", "백그라운드 복귀", "앱 전환 후 연결 유지 여부 검사 필요"),
    interactive("agent-session", "Agent WebRTC 연결", "온라인 Agent 연결 필요"),
    interactive("first-frame", "원격 첫 화면", "Agent 연결 후 첫 프레임 대기"),
    interactive("remote-pointer", "원격 터치 입력", "원격 화면 터치 후 확인 필요"),
    interactive("remote-clipboard-image", "원격 이미지 클립보드", "Agent 연결 후 PNG 전송 필요"),
    interactive("remote-file", "WebRTC 파일 전송", "Agent 연결 후 파일 전송 필요"),
  ];
}

export function updateIosProbeCheck(
  checks: readonly IosProbeCheck[],
  id: IosProbeCheckId,
  status: IosProbeStatus,
  detail: string,
): IosProbeCheck[] {
  return checks.map((check) => check.id === id ? { ...check, status, detail } : check);
}

export function summarizeIosProbeChecks(checks: readonly IosProbeCheck[]) {
  return checks.reduce(
    (summary, check) => ({ ...summary, [check.status]: summary[check.status] + 1 }),
    { pass: 0, limited: 0, fail: 0, pending: 0 } as Record<IosProbeStatus, number>,
  );
}
