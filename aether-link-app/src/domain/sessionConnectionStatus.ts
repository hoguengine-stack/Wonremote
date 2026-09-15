export function sessionConnectionStatus(state: {
  restarting: boolean;
  reconnecting: boolean;
  disconnected: boolean;
  transportReady: boolean;
  picturePresented: boolean;
  pictureError?: boolean;
  receiveError?: boolean;
}): string {
  if (state.restarting) return "재부팅 시작";
  if (state.disconnected) return "연결 끊김";
  if (state.reconnecting) return "다시 연결 중";
  if (!state.transportReady) return "연결 중";
  if (state.receiveError) return "화면 수신 오류";
  if (state.pictureError) return "화면 표시 오류";
  return state.picturePresented ? "화면 수신 중" : "화면 수신 대기";
}

export function isRemoteInputAvailable(state: {
  active: boolean;
  visible: boolean;
  sessionConnected: boolean;
  disconnected: boolean;
  firebaseEnabled: boolean;
  transportReady: boolean;
}): boolean {
  return state.active
    && state.visible
    && state.sessionConnected
    && !state.disconnected
    && (!state.firebaseEnabled || state.transportReady);
}
