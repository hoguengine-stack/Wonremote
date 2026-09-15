import { describe, expect, it } from "vitest";
import { isRemoteInputAvailable, sessionConnectionStatus } from "./sessionConnectionStatus";

describe("visible remote connection status", () => {
  const state = { restarting: false, reconnecting: false, disconnected: false, transportReady: false, picturePresented: false };
  it("does not call an open channel a displayed picture", () => {
    expect(sessionConnectionStatus(state)).toBe("연결 중");
    expect(sessionConnectionStatus({ ...state, transportReady: true })).toBe("화면 수신 대기");
    expect(sessionConnectionStatus({ ...state, transportReady: true, picturePresented: true })).toBe("화면 수신 중");
  });
  it("does not treat a retained picture as a live connection", () => {
    expect(sessionConnectionStatus({...state,transportReady:true,picturePresented:true,pictureError:true})).toBe("화면 표시 오류");
    expect(sessionConnectionStatus({...state,transportReady:true,pictureError:true,disconnected:true})).toBe("연결 끊김");
    expect(sessionConnectionStatus({ ...state, picturePresented: true })).toBe("연결 중");
    expect(sessionConnectionStatus({ ...state, picturePresented: true, transportReady: true, disconnected: true })).toBe("연결 끊김");
    expect(sessionConnectionStatus({ ...state, reconnecting: true })).toBe("다시 연결 중");
    expect(sessionConnectionStatus({ ...state, restarting: true, disconnected: true })).toBe("재부팅 시작");
  });
});

describe("remote input availability", () => {
  const ready = {
    active: true,
    visible: true,
    sessionConnected: true,
    disconnected: false,
    firebaseEnabled: true,
    transportReady: true,
  };

  it("allows input only while the selected Firebase transport is live", () => {
    expect(isRemoteInputAvailable(ready)).toBe(true);
    expect(isRemoteInputAvailable({ ...ready, transportReady: false })).toBe(false);
    expect(isRemoteInputAvailable({ ...ready, disconnected: true })).toBe(false);
    expect(isRemoteInputAvailable({ ...ready, active: false })).toBe(false);
    expect(isRemoteInputAvailable({ ...ready, visible: false })).toBe(false);
    expect(isRemoteInputAvailable({ ...ready, sessionConnected: false })).toBe(false);
  });

  it("retains the local non-Firebase input path without requiring WebRTC", () => {
    expect(isRemoteInputAvailable({ ...ready, firebaseEnabled: false, transportReady: false })).toBe(true);
    expect(isRemoteInputAvailable({ ...ready, firebaseEnabled: false, disconnected: true })).toBe(false);
  });
});
