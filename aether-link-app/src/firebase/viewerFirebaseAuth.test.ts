import { beforeEach, describe, expect, it, vi } from "vitest";
import { getIdTokenResult, onAuthStateChanged, sendPasswordResetEmail, signInWithEmailAndPassword, signOut } from "firebase/auth";
import { loginViewerWithFirebase, requestViewerPasswordReset, subscribeViewerAuthState } from "./viewerFirebase";

const CENTRAL_VIEWER_UID = "Xjjdvk0Nx1eqCvND4yIOHbM53tl1";

const mockState = vi.hoisted(() => ({
  services: {
    auth: { app: "auth", currentUser: null as { uid: string; email: string } | null },
    db: {},
    functions: {},
  },
}));

vi.mock("./firebaseConfig", () => ({
  resolveFirebaseConfig: vi.fn(() => ({
    apiKey: "api-key",
    appId: "app-id",
    authDomain: "wonremote.test",
    projectId: "wonremote-test",
  })),
}));

vi.mock("./firebaseServices", () => ({
  getWonRemoteFirebaseServices: vi.fn(() => mockState.services),
}));

vi.mock("firebase/auth", () => ({
  browserLocalPersistence: "local",
  createUserWithEmailAndPassword: vi.fn(),
  getIdTokenResult: vi.fn(async () => ({ claims: {} })),
  onAuthStateChanged: vi.fn(),
  sendPasswordResetEmail: vi.fn(async () => undefined),
  setPersistence: vi.fn(async () => undefined),
  signInWithEmailAndPassword: vi.fn(async () => ({ user: { uid: CENTRAL_VIEWER_UID } })),
  signOut: vi.fn(async () => undefined),
}));

describe("Viewer Firebase authentication", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockState.services.auth.currentUser = null;
  });

  it("rejects business-number login because Agent accounts are not central Viewer accounts", async () => {
    await expect(loginViewerWithFirebase("123-45-67890", "1234")).rejects.toThrow(
      "사업자번호 Agent 계정은 Viewer로 로그인할 수 없습니다.",
    );
    expect(signInWithEmailAndPassword).not.toHaveBeenCalled();
  });

  it("keeps email login available for explicit Firebase accounts", async () => {
    await loginViewerWithFirebase("owner@example.com", "secret123");

    expect(signInWithEmailAndPassword).toHaveBeenCalledWith(
      mockState.services.auth,
      "owner@example.com",
      "secret123",
    );
  });

  it("signs out an authenticated email account that is not a registered central Viewer", async () => {
    vi.mocked(signInWithEmailAndPassword).mockResolvedValueOnce({
      user: { uid: "unregistered-viewer-uid" },
    } as any);

    await expect(loginViewerWithFirebase("other@example.com", "secret123")).rejects.toThrow(
      "등록된 중앙 Viewer 관리자 계정이 아닙니다.",
    );
    expect(signOut).toHaveBeenCalledWith(mockState.services.auth);
  });

  it("returns a translated rate limit after one attempt without retrying or resetting the account", async () => {
    vi.mocked(signInWithEmailAndPassword).mockRejectedValueOnce({code:"auth/too-many-requests"});
    await expect(loginViewerWithFirebase("owner@example.com", "secret123")).rejects.toMatchObject({
      code:"auth/too-many-requests",message:expect.stringContaining("정확한 대기 시간을 표시할 수 없습니다"),
    });
    expect(signInWithEmailAndPassword).toHaveBeenCalledTimes(1);
    expect(sendPasswordResetEmail).not.toHaveBeenCalled();
  });

  it("rejects a persisted Agent account instead of opening the central Viewer", async () => {
    vi.mocked(onAuthStateChanged).mockImplementationOnce(((_auth: unknown, onNext: (user: unknown) => void) => {
      onNext(mockState.services.auth.currentUser = { uid: "agent-uid", email: "1234567890@agents.wonremote.app" });
      return vi.fn();
    }) as any);
    const onAuthenticated = vi.fn();
    const onError = vi.fn();

    subscribeViewerAuthState(onAuthenticated, onError);

    await vi.waitFor(() => expect(onAuthenticated).toHaveBeenCalledWith(false));
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({
      message: expect.stringContaining("Viewer 이메일 계정"),
    }));
    expect(signOut).toHaveBeenCalledWith(mockState.services.auth);
  });

  it("accepts a persisted central Viewer account", async () => {
    vi.mocked(onAuthStateChanged).mockImplementationOnce(((_auth: unknown, onNext: (user: unknown) => void) => {
      onNext(mockState.services.auth.currentUser = { uid: CENTRAL_VIEWER_UID, email: "owner@example.com" });
      return vi.fn();
    }) as any);
    const onAuthenticated = vi.fn();
    const onError = vi.fn();

    subscribeViewerAuthState(onAuthenticated, onError);

    await vi.waitFor(() => expect(onAuthenticated).toHaveBeenCalledWith(true, CENTRAL_VIEWER_UID));
    expect(onError).not.toHaveBeenCalled();
  });

  it("clears the previous Viewer immediately and ignores stale authorization after an account switch", async () => {
    let emit!: (user: typeof mockState.services.auth.currentUser) => void;
    vi.mocked(onAuthStateChanged).mockImplementationOnce(((_auth: unknown, onNext: typeof emit) => {
      emit = user => onNext(mockState.services.auth.currentUser = user);
      return vi.fn();
    }) as any);
    const onAuthenticated = vi.fn();
    const onError = vi.fn();
    subscribeViewerAuthState(onAuthenticated, onError);
    const owner = { uid: CENTRAL_VIEWER_UID, email: "owner@example.com" };
    emit(owner);
    await vi.waitFor(() => expect(onAuthenticated).toHaveBeenLastCalledWith(true, CENTRAL_VIEWER_UID));
    let resolve!: (value: any) => void;
    vi.mocked(getIdTokenResult).mockImplementationOnce(() => new Promise(done => { resolve = done; }));
    emit({uid:"second-viewer", email:"other@example.com"});
    expect(onAuthenticated).toHaveBeenLastCalledWith(false);
    emit(owner);
    await vi.waitFor(() => expect(onAuthenticated).toHaveBeenLastCalledWith(true, CENTRAL_VIEWER_UID));
    resolve({claims:{wonremoteViewer:true}});
    await new Promise(done => setTimeout(done, 0));
    expect(onAuthenticated.mock.calls).toEqual([[true,CENTRAL_VIEWER_UID], [false], [true,CENTRAL_VIEWER_UID]]);
    expect(onError).not.toHaveBeenCalled();
    expect(signOut).not.toHaveBeenCalled();
  });

  it("accepts a Viewer account carrying the wonremoteViewer claim", async () => {
    vi.mocked(signInWithEmailAndPassword).mockResolvedValueOnce({
      user: { uid: "viewer-user", email: "staff@example.com" },
    } as any);
    vi.mocked(getIdTokenResult).mockResolvedValueOnce({ claims: { wonremoteViewer: true } } as any);

    await loginViewerWithFirebase("staff@example.com", "secret123");

    expect(signOut).not.toHaveBeenCalled();
  });

  it("sends a password reset email for a Viewer email account", async () => {
    await requestViewerPasswordReset(" Owner@Example.com ");

    expect(sendPasswordResetEmail).toHaveBeenCalledWith(mockState.services.auth, "owner@example.com");
  });

  it("does not send Viewer password resets to Agent identities", async () => {
    await expect(requestViewerPasswordReset("123-45-67890")).rejects.toThrow("Agent 계정");
    expect(sendPasswordResetEmail).not.toHaveBeenCalled();
  });

  it("does not reveal whether a Viewer email exists", async () => {
    vi.mocked(sendPasswordResetEmail).mockRejectedValueOnce({ code: "auth/user-not-found" });

    await expect(requestViewerPasswordReset("unknown@example.com")).resolves.toBeUndefined();
  });
});
