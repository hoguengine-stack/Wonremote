import {
  CircleDot,
  Keyboard,
  LogIn,
  LogOut,
  Monitor,
  MousePointerClick,
  PlugZap,
  Search,
  ShieldCheck,
  MessageSquare,
  Clipboard,
  FileUp,
  Video,
  Volume2,
  ZoomIn,
  ZoomOut,
  Maximize2,
  Minimize2,
  RotateCcw,
  Power,
  Trash2,
} from "lucide-react";
import React, { FormEvent, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import {
  closeSession,
  fetchDevices,
  loginAdmin,
  logoutAdmin,
  openSession,
  recordInput,
  registerFirstRunAgent,
  fetchSessionStatus,
  sendChatMessage,
  fetchChatMessages,
  sendClipboardText,
  fetchClipboardText,
  fetchFileTransferReceipts,
  uploadFileChunk,
  uploadFileToStorage,
  fetchFiles,
  fetchConnectionHistory,
  fetchTiles,
  updateDeviceMetadata,
  wakeRemoteDevice,
  requestSecureSession,
  connectSecureSession,
  deleteUploadedFileFromStorage,
  deleteRemoteDevice,
} from "./api/viewerApi";
import { fetchViewerUpdateMetadata } from "./api/viewerUpdate";
import {
  isViewerFirebaseEnabled,
  startFirebaseViewerWebRtcTransport,
  subscribeFirebaseDevices,
  subscribeViewerAuthState,
  type ViewerWebRtcTransport,
} from "./firebase/viewerFirebase";
import { groupDevicesByStore, resolveDeviceStatuses } from "./domain/agentRegistry";
import { resolveViewerOfflineAfterMs } from "./domain/viewerDeviceList";
import {
  scheduleVisualPingPresentedMeasurement,
} from "./domain/visualPing";
import {
  shouldWarnAboutControlLimit,
} from "./domain/sessionDiagnostics";
import { getViewerVersion } from "./domain/versioning";
import {
  resolveViewerUpdateIntervalMs,
  shouldNotifyUpdate,
  shouldReloadViewerForUpdate,
} from "./domain/updatePolicy";
import { shouldPollViewerTileFallback } from "./domain/realtimeTransportPolicy";
import {
  buildSetStreamModeCommand,
  normalizeStreamPerformanceMode,
  type StreamPerformanceMode,
} from "./domain/streamPerformanceMode";
import {
  ACTIVE_SESSION_STORAGE_KEY,
  parseActiveSession,
  serializeActiveSession,
} from "./domain/sessionPersistence";
import { sha256BlobHex } from "./domain/blobHash";
import {
  STORAGE_TRANSFER_CLEANUP_KEY,
  parseStorageTransferCleanup,
  serializeStorageTransferCleanup,
} from "./domain/storageTransferCleanup";
import { webRtcReconnectDelayMs } from "./domain/webrtcStability";
import {
  buildKeyboardCommand,
  buildMouseCommand,
  buildPasteTextCommand,
  buildSwitchMonitorCommand,
  buildSystemCommand,
  buildUnicodeTextCommand,
  formatTransferStats,
  mapCanvasPointToVirtualDesktopAbsolute,
  type MouseButtonCode,
} from "./domain/remoteControlCommands";
import {
  REMOTE_FILE_CHUNK_BYTES,
  canUseFirestoreDirectFileTransfer,
  canTransferRemoteFile,
  remoteFileLimitLabel,
} from "./domain/fileTransferPolicy";
import type {
  ManagedDevice,
  RemoteSession,
  ChatMessage,
  ClipboardData,
  TransferredFile,
  ConnectionHistoryEntry,
  DeviceMetadataUpdateInput,
} from "./domain/types";

type DeviceEditTarget =
  | { mode: "device"; devices: [ManagedDevice] }
  | { mode: "group"; devices: ManagedDevice[] };

type SecureConnectState = {
  challengeId: string;
  code: string;
  device: ManagedDevice;
  expiresAt: string;
  isSubmitting: boolean;
};

function playBeepSound() {
  try {
    const audioCtx = new (window.AudioContext || (window as any).webkitAudioContext)();
    const oscillator = audioCtx.createOscillator();
    const gainNode = audioCtx.createGain();
    
    oscillator.connect(gainNode);
    gainNode.connect(audioCtx.destination);
    
    oscillator.type = "sine";
    oscillator.frequency.value = 440;
    gainNode.gain.setValueAtTime(0.1, audioCtx.currentTime);
    
    oscillator.start();
    oscillator.stop(audioCtx.currentTime + 0.15);
  } catch (e) {
    console.error("오디오 재생 실패:", e);
  }
}

async function readClipboardPngBlob(): Promise<Blob | null> {
  const clipboard = navigator.clipboard as Clipboard & {
    read?: () => Promise<Array<{ types: readonly string[]; getType: (type: string) => Promise<Blob> }>>;
  };
  if (typeof clipboard.read !== "function") {
    return null;
  }
  try {
    const items = await clipboard.read();
    for (const item of items) {
      if (item.types.includes("image/png")) {
        return item.getType("image/png");
      }
    }
  } catch {
    return null;
  }
  return null;
}

export function App() {
  const [appMode, setAppMode] = useState<"viewer" | "agent" | null>(null);

  useEffect(() => {
    if ((window as any).__TAURI_INTERNALS__) {
      invoke<string>("get_app_mode")
        .then((mode: string) => {
          setAppMode(mode as "viewer" | "agent");
        })
        .catch(() => {
          setAppMode("viewer");
        });
    } else {
      const modeParam = new URLSearchParams(window.location.search).get("mode");
      setAppMode(modeParam === "agent" ? "agent" : "viewer");
    }
  }, []);

  if (appMode === null) {
    return <div style={{ background: "#0f0f1a", minHeight: "100vh" }}></div>;
  }

  return appMode === "agent" ? <AgentFirstRunApp /> : <ViewerApp />;
}

function ViewerApp() {
  const [isAuthenticated, setIsAuthenticated] = useState(false);
  const [isCheckingAutoLogin, setIsCheckingAutoLogin] = useState(() => isViewerFirebaseEnabled());
  const [loginError, setLoginError] = useState("");
  const [devices, setDevices] = useState<ManagedDevice[]>([]);
  const [session, setSession] = useState<RemoteSession | null>(null);
  const [apiError, setApiError] = useState("");
  const [query, setQuery] = useState("");
  const [selectedStore, setSelectedStore] = useState("전체");
  const [updateAlert, setUpdateAlert] = useState<string | null>(null);
  const sessionRestoreAttemptedRef = useRef(false);
  const [editTarget, setEditTarget] = useState<DeviceEditTarget | null>(null);
  const [secureConnect, setSecureConnect] = useState<SecureConnectState | null>(null);

  useEffect(() => {
    if (!isViewerFirebaseEnabled()) {
      setIsCheckingAutoLogin(false);
      return;
    }

    let cancelled = false;
    const unsubscribe = subscribeViewerAuthState(
      (hasSession) => {
        if (cancelled) {
          return;
        }
        setIsAuthenticated(hasSession);
        if (hasSession) {
          setLoginError("");
          setApiError("");
        }
        setIsCheckingAutoLogin(false);
      },
      (error) => {
        if (cancelled) {
          return;
        }
        setLoginError(error.message);
        setIsCheckingAutoLogin(false);
      },
    );

    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, []);

  // Native Viewer shell owns installed-app updates so WebView CORS cannot block them.
  useEffect(() => {
    if ((window as any).__TAURI_INTERNALS__) {
      return;
    }

    const currentViewerVersion = getViewerVersion(import.meta.env);
    let active = true;
    let reloadTimer: ReturnType<typeof setTimeout> | undefined;

    const checkViewerUpdate = async () => {
      try {
        const data = await fetchViewerUpdateMetadata(import.meta.env);
        if (!data) return;

        const latestVersion = data.latestVersion;
        if (active && typeof latestVersion === "string" && shouldNotifyUpdate(data, currentViewerVersion)) {
          setUpdateAlert(latestVersion);
          if (shouldReloadViewerForUpdate(data, currentViewerVersion) && !reloadTimer) {
            reloadTimer = setTimeout(() => {
              window.location.reload();
            }, 1500);
          }
        }
      } catch (e) {
        // ignore
      }
    };

    void checkViewerUpdate();
    const interval = setInterval(
      () => void checkViewerUpdate(),
      resolveViewerUpdateIntervalMs(import.meta.env),
    );
    return () => {
      active = false;
      clearInterval(interval);
      if (reloadTimer) {
        clearTimeout(reloadTimer);
      }
    };
  }, []);


  const groups = useMemo(() => groupDevicesByStore(devices), [devices]);
  const filteredDevices = useMemo(() => {
    return devices.filter((device) => {
      const matchesStore = selectedStore === "전체" || device.storeName === selectedStore;
      const term = query.trim().toLowerCase();
      const matchesQuery =
        term.length === 0 ||
        [
          device.businessNumber,
          device.storeName,
          device.deviceNumber,
          device.deviceName,
          device.desktopName,
        ]
          .join(" ")
          .toLowerCase()
          .includes(term);
      return matchesStore && matchesQuery;
    });
  }, [devices, query, selectedStore]);

  const activeDevice = session
    ? devices.find((device) => device.id === session.deviceId) ?? null
    : null;
  const isRemoteFocusMode = Boolean(session);

  useEffect(() => {
    if (!isAuthenticated || !isViewerFirebaseEnabled() || sessionRestoreAttemptedRef.current) {
      return;
    }
    sessionRestoreAttemptedRef.current = true;
    const storedSession = parseActiveSession(window.localStorage.getItem(ACTIVE_SESSION_STORAGE_KEY));
    if (!storedSession) {
      window.localStorage.removeItem(ACTIVE_SESSION_STORAGE_KEY);
      return;
    }
    let active = true;
    void fetchSessionStatus(storedSession.id)
      .then((state) => {
        if (!active || (state !== "connected" && state !== "pending")) return;
        setSession({ ...storedSession, state });
      })
      .catch(() => window.localStorage.removeItem(ACTIVE_SESSION_STORAGE_KEY));
    return () => {
      active = false;
    };
  }, [isAuthenticated]);

  useEffect(() => {
    if (session) {
      window.localStorage.setItem(ACTIVE_SESSION_STORAGE_KEY, serializeActiveSession(session));
    }
  }, [session]);

  useEffect(() => {
    if (!(window as any).__TAURI_INTERNALS__) {
      return;
    }

    const appWindow = getCurrentWindow();
    void appWindow.setFullscreen(isRemoteFocusMode).catch(() => {
      // Browser/dev mode and some restricted shells can reject fullscreen changes.
    });

    return () => {
      if (isRemoteFocusMode) {
        void appWindow.setFullscreen(false).catch(() => {});
      }
    };
  }, [isRemoteFocusMode]);

  useEffect(() => {
    if (!isAuthenticated) {
      return;
    }

    if (isViewerFirebaseEnabled()) {
      const unsubscribe = subscribeFirebaseDevices(
        (nextDevices) => {
          setDevices(nextDevices);
          setApiError("");
        },
        (error) => {
          setApiError(error.message);
        },
      );
      return () => unsubscribe();
    }

    let cancelled = false;
    const refreshDevices = async () => {
      try {
        const nextDevices = await fetchDevices();
        if (!cancelled) {
          setDevices(nextDevices);
          setApiError("");
        }
      } catch (error) {
        if (!cancelled) {
          setApiError(error instanceof Error ? error.message : "장비 목록 갱신 실패");
        }
      }
    };

    const intervalId = window.setInterval(() => void refreshDevices(), 2000);
    return () => {
      cancelled = true;
      window.clearInterval(intervalId);
    };
  }, [isAuthenticated]);

  useEffect(() => {
    if (!isAuthenticated || !isViewerFirebaseEnabled()) {
      return;
    }
    const offlineAfterMs = resolveViewerOfflineAfterMs(import.meta.env);
    const refreshStatuses = () => {
      setDevices((current) => resolveDeviceStatuses(current, new Date().toISOString(), offlineAfterMs));
    };
    const interval = window.setInterval(refreshStatuses, 5_000);
    return () => window.clearInterval(interval);
  }, [isAuthenticated]);

  useEffect(() => {
    if (!session || session.state !== "pending") {
      return;
    }

    let active = true;
    const checkStatus = async () => {
      try {
        const nextState = await fetchSessionStatus(session.id);
        if (!active) return;
        if (nextState === "connected") {
          setSession({ ...session, state: "connected" });
        }
      } catch (error) {
        if (active) {
          setSession(null);
          window.localStorage.removeItem(ACTIVE_SESSION_STORAGE_KEY);
        }
      }
    };

    const statusIntervalId = window.setInterval(() => void checkStatus(), 1000);
    return () => {
      active = false;
      window.clearInterval(statusIntervalId);
    };
  }, [session]);

  async function handleLogin(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const username = String(data.get("username") ?? "");
    const password = String(data.get("password") ?? "");

    try {
      await loginAdmin(username, password);
      if (isViewerFirebaseEnabled()) {
        setDevices([]);
      } else {
        setDevices(await fetchDevices());
      }
      setLoginError("");
      setApiError("");
      setIsAuthenticated(true);
    } catch (error) {
      setLoginError(error instanceof Error ? error.message : "관리자 로그인을 완료할 수 없습니다.");
    }
  }

  async function handleLogout() {
    try {
      await logoutAdmin();
    } finally {
      setIsAuthenticated(false);
      setSession(null);
      window.localStorage.removeItem(ACTIVE_SESSION_STORAGE_KEY);
      setDevices([]);
      setApiError("");
    }
  }

  async function markInput(action: string, options: { localOnly?: boolean } = {}) {
    if (!session) {
      return;
    }
    if (options.localOnly) {
      setApiError("");
      return;
    }
    try {
      await recordInput(session.id, action);
      setApiError("");
    } catch (error) {
      setApiError(error instanceof Error ? error.message : "입력 이벤트 전송 실패");
    }
  }

  async function handleCloseSession() {
    if (!session) {
      return;
    }
    try {
      await closeSession(session.id);
      setSession(null);
      window.localStorage.removeItem(ACTIVE_SESSION_STORAGE_KEY);
      setApiError("");
    } catch (error) {
      setApiError(error instanceof Error ? error.message : "세션 종료 실패");
    }
  }

  async function handleConnectDevice(device: ManagedDevice) {
    if (device.status !== "online") {
      setApiError("온라인 상태의 Agent만 접속할 수 있습니다.");
      return;
    }
    try {
      const result = await openSession(device.id);
      setSession(result.session);
      setApiError("");
    } catch (error) {
      setApiError(error instanceof Error ? error.message : "세션 연결 실패");
    }
  }

  async function handleSecureConnectRequest(device: ManagedDevice) {
    if (device.status !== "online") {
      setApiError("온라인 상태의 Agent만 보안접속을 요청할 수 있습니다.");
      return;
    }
    try {
      const challenge = await requestSecureSession(device.id);
      setSecureConnect({
        challengeId: challenge.challengeId,
        code: "",
        device,
        expiresAt: challenge.expiresAt,
        isSubmitting: false,
      });
      setApiError("");
    } catch (error) {
      setApiError(error instanceof Error ? error.message : "보안접속 코드 요청 실패");
    }
  }

  async function handleSecureConnectSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!secureConnect) {
      return;
    }
    setSecureConnect({ ...secureConnect, isSubmitting: true });
    try {
      const result = await connectSecureSession({
        challengeId: secureConnect.challengeId,
        code: secureConnect.code,
        deviceId: secureConnect.device.id,
      });
      setSession(result.session);
      setSecureConnect(null);
      setApiError("");
    } catch (error) {
      setSecureConnect({ ...secureConnect, isSubmitting: false });
      setApiError(error instanceof Error ? error.message : "보안접속 실패");
    }
  }

  async function handleWakeDevice(device: ManagedDevice) {
    const macAddress = device.macAddresses?.[0];
    if (!macAddress) {
      setApiError("Wake-on-LAN을 보낼 MAC 주소가 아직 없습니다. Agent가 한 번 이상 온라인 heartbeat를 보내야 합니다.");
      return;
    }
    try {
      if (isViewerFirebaseEnabled()) {
        const result = await wakeRemoteDevice(device.id, macAddress);
        setApiError(`Wake-on-LAN 원격 전송 완료: ${result.targetMac} (릴레이 ${result.relayDeviceId})`);
        return;
      }
    } catch (remoteError) {
      if (!(window as any).__TAURI_INTERNALS__) {
        setApiError(remoteError instanceof Error ? remoteError.message : "원격 Wake-on-LAN 전송 실패");
        return;
      }
    }

    if (!(window as any).__TAURI_INTERNALS__) {
      setApiError("Wake-on-LAN은 온라인 릴레이 Agent 또는 설치형 Viewer가 필요합니다.");
      return;
    }
    try {
      await invoke("wake_device", { macAddress, broadcast: "255.255.255.255", port: 9 });
      setApiError(`Wake-on-LAN 로컬 전송 완료: ${macAddress}`);
    } catch (localError) {
      setApiError(localError instanceof Error ? localError.message : "Wake-on-LAN 전송 실패");
    }
  }

  async function handleSaveDeviceMetadata(input: Omit<DeviceMetadataUpdateInput, "deviceId">) {
    if (!editTarget || editTarget.devices.length === 0) {
      return;
    }

    const previousStore = editTarget.devices[0].storeName;
    const nextDeviceState = [...devices];
    const updatedDevices: ManagedDevice[] = [];

    try {
      for (const device of editTarget.devices) {
        const updateInput =
          editTarget.mode === "group"
            ? {
                storeName: input.storeName,
              }
            : {
                desktopName: input.desktopName,
                deviceName: input.deviceName,
                storeName: input.storeName,
              };
        const updated = await updateDeviceMetadata(device.id, updateInput);
        updatedDevices.push(updated);
        const index = nextDeviceState.findIndex((item) => item.id === updated.id);
        if (index === -1) {
          nextDeviceState.push(updated);
        } else {
          nextDeviceState[index] = updated;
        }
      }

      setDevices(nextDeviceState);
      const firstUpdated = updatedDevices[0];
      if (firstUpdated && selectedStore === previousStore) {
        setSelectedStore(firstUpdated.storeName);
      }
      setEditTarget(null);
      setApiError("");
    } catch (error) {
      setApiError(error instanceof Error ? error.message : "장비 정보 수정 실패");
    }
  }

  async function handleDeleteDevice() {
    if (!editTarget || editTarget.mode !== "device") {
      return;
    }

    const device = editTarget.devices[0];
    try {
      if (session?.deviceId === device.id) {
        await closeSession(session.id);
        setSession(null);
        window.localStorage.removeItem(ACTIVE_SESSION_STORAGE_KEY);
      }
      await deleteRemoteDevice(device.id);
      const remainingDevices = devices.filter((item) => item.id !== device.id);
      setDevices(remainingDevices);
      if (
        selectedStore === device.storeName
        && !remainingDevices.some((item) => item.storeName === selectedStore)
      ) {
        setSelectedStore("전체");
      }
      if (secureConnect?.device.id === device.id) {
        setSecureConnect(null);
      }
      setEditTarget(null);
      setApiError("");
    } catch (error) {
      setApiError(error instanceof Error ? error.message : "장비 삭제 실패");
      throw error;
    }
  }

  if (isCheckingAutoLogin) {
    return <AutoLoginScreen />;
  }

  if (!isAuthenticated) {
    return <LoginScreen error={loginError} onSubmit={handleLogin} />;
  }

  return (
    <div className={`app-shell${isRemoteFocusMode ? " remote-focus-mode" : ""}`}>
      {updateAlert && (
        <div style={{
          position: "fixed",
          top: "16px",
          left: "50%",
          transform: "translateX(-50%)",
          background: "#4f46e5",
          color: "#fff",
          padding: "12px 24px",
          borderRadius: "8px",
          boxShadow: "0 10px 15px -3px rgba(0, 0, 0, 0.3)",
          zIndex: 9999,
          fontWeight: "bold",
          fontSize: "14px"
        }}>
          새로운 뷰어 업데이트가 존재합니다. {updateAlert} 버전으로 갱신하는 중...
        </div>
      )}
      <aside className="sidebar">
        <div className="brand-row">
          <div className="brand-mark">W</div>
          <div>
            <strong>WonRemote</strong>
            <span>Viewer Console</span>
          </div>
        </div>

        <button
          className={`group-button ${selectedStore === "전체" ? "active" : ""}`}
          type="button"
          onClick={() => setSelectedStore("전체")}
        >
          <Monitor size={17} />
          <span>전체 장비</span>
          <b>{devices.length}</b>
        </button>

        <div className="group-list">
          {groups.map((group) => (
            <button
              className={`group-button ${selectedStore === group.storeName ? "active" : ""}`}
              key={group.storeName}
              type="button"
              onClick={() => setSelectedStore(group.storeName)}
              onContextMenu={(event) => {
                event.preventDefault();
                if (group.devices.length > 0) {
                  setEditTarget({ mode: "group", devices: group.devices });
                }
              }}
            >
              <CircleDot size={16} />
              <span className="group-label">
                <strong>{group.storeName}</strong>
                <small>{formatGroupBusinessNumber(group.devices)}</small>
              </span>
              <b>{group.devices.length}</b>
            </button>
          ))}
        </div>

        <button className="logout-button" type="button" onClick={handleLogout}>
          <LogOut size={17} />
          <span>로그아웃</span>
        </button>
      </aside>

      <main className="workspace">
        <header className="topbar">
          <div>
            <h1>원격 장비 관리</h1>
            <p>{devices.length}대 등록 · {session ? "세션 연결됨" : "대기"}</p>
            {apiError && <p className="topbar-error">{apiError}</p>}
          </div>
          <label className="search-box">
            <Search size={17} />
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="업장, 장비명, 사업자번호 검색"
            />
          </label>
        </header>

        <section className="content-grid">
          <section className="control-panel">
            <DeviceTable
              devices={filteredDevices}
              activeDeviceId={session?.deviceId ?? ""}
              onConnect={handleConnectDevice}
              onEdit={(device) => setEditTarget({ mode: "device", devices: [device] })}
              onSecureConnect={handleSecureConnectRequest}
              onWake={handleWakeDevice}
            />
            <ConnectionHistorySection />
          </section>

          <RemoteSessionPanel
            device={activeDevice}
            sessionId={session?.id ?? ""}
            session={session}
            onInputEvent={(action, options) => markInput(action, options)}
            onCloseSession={handleCloseSession}
          />
        </section>
      </main>
      {editTarget && (
        <DeviceEditDialog
          target={editTarget}
          onClose={() => setEditTarget(null)}
          onDelete={handleDeleteDevice}
          onSave={handleSaveDeviceMetadata}
        />
      )}
      {secureConnect && (
        <SecureConnectDialog
          state={secureConnect}
          onCancel={() => setSecureConnect(null)}
          onCodeChange={(code) => setSecureConnect({ ...secureConnect, code })}
          onSubmit={handleSecureConnectSubmit}
        />
      )}
    </div>
  );
}

function formatGroupBusinessNumber(devices: ManagedDevice[]): string {
  const businessNumbers = [...new Set(devices.map((device) => device.businessNumber).filter(Boolean))];
  if (businessNumbers.length === 0) {
    return "사업자번호 없음";
  }
  if (businessNumbers.length === 1) {
    return businessNumbers[0];
  }
  return `${businessNumbers[0]} 외 ${businessNumbers.length - 1}개`;
}

function formatSecurityCodeInput(value: string): string {
  const digits = value.replace(/\D/g, "").slice(0, 6);
  if (digits.length <= 3) {
    return digits;
  }
  return `${digits.slice(0, 3)} ${digits.slice(3)}`;
}

function DeviceEditDialog({
  onClose,
  onDelete,
  onSave,
  target,
}: {
  onClose: () => void;
  onDelete: () => Promise<void>;
  onSave: (input: Omit<DeviceMetadataUpdateInput, "deviceId">) => Promise<void>;
  target: DeviceEditTarget;
}) {
  const primaryDevice = target.devices[0];
  const isGroupEdit = target.mode === "group";
  const [form, setForm] = useState({
    businessNumber: primaryDevice.businessNumber,
    desktopName: primaryDevice.desktopName,
    deviceName: primaryDevice.deviceName,
    storeName: primaryDevice.storeName,
  });
  const [isSaving, setIsSaving] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);
  const [isDeleteArmed, setIsDeleteArmed] = useState(false);

  useEffect(() => {
    setForm({
      businessNumber: primaryDevice.businessNumber,
      desktopName: primaryDevice.desktopName,
      deviceName: primaryDevice.deviceName,
      storeName: primaryDevice.storeName,
    });
    setIsDeleteArmed(false);
  }, [primaryDevice.id]);

  async function saveCurrentForm() {
    if (isSaving) {
      return;
    }
    setIsSaving(true);
    try {
      await onSave(form);
    } finally {
      setIsSaving(false);
    }
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    await saveCurrentForm();
  }

  async function deleteCurrentDevice() {
    if (isSaving || isDeleting || isGroupEdit) {
      return;
    }
    if (!isDeleteArmed) {
      setIsDeleteArmed(true);
      return;
    }

    setIsDeleting(true);
    try {
      await onDelete();
    } catch {
      setIsDeleteArmed(false);
    } finally {
      setIsDeleting(false);
    }
  }

  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={onClose}>
      <form className="modal-panel" onMouseDown={(event) => event.stopPropagation()} onSubmit={handleSubmit}>
        <div className="section-heading">
          <h2>{isGroupEdit ? "장비 그룹 수정" : "등록 장비 수정"}</h2>
          <span>{isGroupEdit ? `${target.devices.length}대 적용` : primaryDevice.deviceNumber}</span>
        </div>
        <div className="form-grid">
          <label>
            가맹점 상호명
            <input
              value={form.storeName}
              onChange={(event) => setForm((prev) => ({ ...prev, storeName: event.target.value }))}
              placeholder="가맹점 상호명"
            />
          </label>
          <label>
            사업자번호
            <input
              readOnly
              value={form.businessNumber}
              placeholder="123-45-67890"
            />
          </label>
          {!isGroupEdit && (
            <>
              <label>
                장비명
                <input
                  value={form.deviceName}
                  onChange={(event) => setForm((prev) => ({ ...prev, deviceName: event.target.value }))}
                  placeholder="장비명"
                />
              </label>
              <label>
                데스크탑명
                <input
                  value={form.desktopName}
                  onChange={(event) => setForm((prev) => ({ ...prev, desktopName: event.target.value }))}
                  placeholder="데스크탑명"
                />
              </label>
            </>
          )}
        </div>
        {!isGroupEdit && (
          <p className="modal-help">
            삭제하면 이 Agent의 등록이 해제됩니다. 같은 PC에서 다시 등록하면 장비가 다시 생성됩니다.
          </p>
        )}
        <div className="modal-actions">
          {!isGroupEdit && (
            <button
              className={`danger-button${isDeleteArmed ? " armed" : ""}`}
              disabled={isSaving || isDeleting}
              type="button"
              onClick={() => void deleteCurrentDevice()}
            >
              <Trash2 size={15} />
              {isDeleting ? "삭제 중..." : isDeleteArmed ? "한 번 더 눌러 삭제" : "장비 삭제"}
            </button>
          )}
          <button className="secondary-button" type="button" onClick={onClose}>
            취소
          </button>
          <button
            className="primary-button compact"
            disabled={isSaving || isDeleting}
            type="button"
            onClick={() => void saveCurrentForm()}
            onMouseDown={(event) => {
              event.preventDefault();
              void saveCurrentForm();
            }}
          >
            저장
          </button>
        </div>
      </form>
    </div>
  );
}

function SecureConnectDialog({
  onCancel,
  onCodeChange,
  onSubmit,
  state,
}: {
  onCancel: () => void;
  onCodeChange: (code: string) => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
  state: SecureConnectState;
}) {
  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={onCancel}>
      <form className="modal-panel compact-modal" onMouseDown={(event) => event.stopPropagation()} onSubmit={onSubmit}>
        <div className="section-heading">
          <h2>보안접속</h2>
          <span>{state.device.desktopName}</span>
        </div>
        <p className="modal-help">
          Agent PC 화면에 표시된 6자리 코드를 입력하면 원격 세션이 시작됩니다.
        </p>
        <label>
          보안 코드
          <input
            autoFocus
            inputMode="numeric"
            maxLength={7}
            value={state.code}
            onChange={(event) => onCodeChange(formatSecurityCodeInput(event.target.value))}
            placeholder="000 000"
          />
        </label>
        <small className="modal-help">만료 시각: {new Date(state.expiresAt).toLocaleTimeString()}</small>
        <div className="modal-actions">
          <button className="secondary-button" type="button" onClick={onCancel}>
            취소
          </button>
          <button className="primary-button compact" disabled={state.isSubmitting || state.code.replace(/\D/g, "").length !== 6} type="submit">
            접속
          </button>
        </div>
      </form>
    </div>
  );
}

function ConnectionHistorySection() {
  const [history, setHistory] = useState<ConnectionHistoryEntry[]>([]);

  const loadHistory = async () => {
    try {
      const data = await fetchConnectionHistory();
      setHistory(data);
    } catch (e) {
      // ignore
    }
  };

  useEffect(() => {
    void loadHistory();
    const interval = setInterval(() => void loadHistory(), 3000);
    return () => clearInterval(interval);
  }, []);

  return (
    <section className="device-section" style={{ marginTop: "24px" }}>
      <div className="section-heading">
        <h2>과거 연결 이력</h2>
        <span>{history.length}건</span>
      </div>
      <div className="device-table" style={{ maxHeight: "250px", overflowY: "auto" }}>
        <div className="table-row table-head" style={{ gridTemplateColumns: "1.2fr 2fr 2fr 3fr 1.5fr" }}>
          <span>상태</span>
          <span>업장명</span>
          <span>장비</span>
          <span>시작 시각</span>
          <span>소요시간</span>
        </div>
        {history.map((entry) => {
          const start = new Date(entry.startedAt);
          const end = entry.endedAt ? new Date(entry.endedAt) : null;
          const duration = end ? `${Math.round((end.getTime() - start.getTime()) / 1000)}초` : "-";
          
          let statusColor = "#10b981";
          if (entry.status === "rejected") statusColor = "#ef4444";
          if (entry.status === "closed") statusColor = "#64748b";

          return (
            <div className="table-row" key={entry.id} style={{ gridTemplateColumns: "1.2fr 2fr 2fr 3fr 1.5fr" }}>
              <span className="status-pill" style={{ background: statusColor + "20", color: statusColor }}>
                {entry.status}
              </span>
              <span>{entry.storeName}</span>
              <span>{entry.deviceName}</span>
              <span style={{ fontSize: "11px" }}>{start.toLocaleTimeString()}</span>
              <span>{duration}</span>
            </div>
          );
        })}
        {history.length === 0 && <div className="empty-row">연결 이력이 없습니다.</div>}
      </div>
    </section>
  );
}

function AgentFirstRunApp() {
  const firebaseMode = isViewerFirebaseEnabled();
  const [businessNumber, setBusinessNumber] = useState("");
  const [password, setPassword] = useState("");
  const [apiUrl, setApiUrl] = useState("http://127.0.0.1:8787");
  const [installId, setInstallId] = useState(getOrCreateAgentInstallId);
  const [isInstallIdentityReady, setIsInstallIdentityReady] = useState(
    () => !(window as any).__TAURI_INTERNALS__,
  );
  const [registeredDevice, setRegisteredDevice] = useState<ManagedDevice | null>(null);
  const [registeredConfig, setRegisteredConfig] = useState<any | null>(null);
  const [error, setError] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);

  useEffect(() => {
    if (!(window as any).__TAURI_INTERNALS__) {
      return;
    }

    let cancelled = false;
    void (async () => {
      try {
        const config = await invoke<any>("get_agent_config");
        if (!cancelled && config?.registeredDeviceId) {
          setRegisteredConfig(config);
        }
        const persistentInstallId = await invoke<string>("get_or_create_agent_install_id", {
          legacyInstallId: installId,
        });
        if (cancelled) {
          return;
        }
        setInstallId(persistentInstallId);
        window.localStorage.setItem("wonremote-agent-install-id", persistentInstallId);
      } catch (identityError) {
        if (!cancelled) {
          setError(identityError instanceof Error ? identityError.message : "Agent install identity initialization failed.");
        }
      } finally {
        if (!cancelled) {
          setIsInstallIdentityReady(true);
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  async function handleFirstRun(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (password.trim() !== "1234") {
      setError("Agent 비밀번호가 올바르지 않습니다.");
      return;
    }
    setIsSubmitting(true);
    try {
      const result = await registerFirstRunAgent({
        businessNumber,
        password,
        installId,
        version: getViewerVersion(import.meta.env),
        apiUrl: firebaseMode ? undefined : apiUrl,
      });
      setRegisteredDevice(result.device);
      setError("");

      const configData = {
        businessNumber: result.device.businessNumber,
        installId,
        registeredDeviceId: result.device.id,
        version: getViewerVersion(import.meta.env),
        apiUrl: firebaseMode ? "" : apiUrl,
      };

      if ((window as any).__TAURI_INTERNALS__) {
        try {
          await invoke("save_agent_config", {
            config: configData
          });
        } catch (saveError) {
          const persistedConfig = await invoke<any>("get_agent_config").catch(() => null);
          if (persistedConfig?.registeredDeviceId === configData.registeredDeviceId) {
            setError("장비 등록은 완료됐지만 Agent 자동 시작에 실패했습니다. 아래 버튼으로 다시 시작해 주세요.");
            setRegisteredConfig(persistedConfig);
            return;
          }
          throw saveError;
        }
      }
      setRegisteredConfig(configData);
    } catch (submissionError) {
      setError(submissionError instanceof Error ? submissionError.message : "Agent 등록 실패");
    } finally {
      setIsSubmitting(false);
    }
  }

  if (registeredConfig) {
    return (
      <main className="login-screen agent-screen">
        <div className="login-panel agent-panel active-agent-panel">
          <div className="login-badge active-agent-badge">
            <Monitor size={20} />
            <span>Active Agent</span>
          </div>
          <h1>Agent 가동 중</h1>
          {error && <p className="error-text">{error}</p>}
          <div className="agent-result active-agent-result">
            <div style={{ display: firebaseMode ? "none" : undefined }}>
              <span>서버 주소:</span>
              <strong>{registeredConfig.apiUrl}</strong>
            </div>
            <div>
              <span>등록 장비 ID:</span>
              <strong>{registeredConfig.registeredDeviceId}</strong>
            </div>
            <div>
              <span>사업자번호:</span>
              <strong>{registeredConfig.businessNumber}</strong>
            </div>
            <div>
              <span>설치 식별자:</span>
              <code>{registeredConfig.installId}</code>
            </div>
          </div>
          <p className="agent-status-copy">
            본 프로그램은 백그라운드에서 원격 제어 대기 상태를 유지합니다. 트레이 아이콘을 통해 관리할 수 있습니다.
          </p>
          <button
            className="primary-button"
            onClick={() => {
              if ((window as any).__TAURI_INTERNALS__) {
                invoke("restart_agent_process").then(() => {
                  alert("에이전트 프로세스가 재시작되었습니다.");
                });
              } else {
                alert("브라우저 환경 - 재시작 시뮬레이션 완료");
              }
            }}
          >
            <span>에이전트 재시작</span>
          </button>
        </div>
      </main>
    );
  }

  return (
    <main className="login-screen agent-screen">
      <form className={`login-panel agent-panel ${firebaseMode ? "firebase-agent-panel" : ""}`} onSubmit={handleFirstRun}>
        <div className="login-badge">
          <Monitor size={20} />
          <span>Agent</span>
        </div>
        <h1>Agent 최초 실행</h1>
        {!firebaseMode && (
          <label>
            서버 주소
            <input
              onChange={(event) => setApiUrl(event.target.value)}
              placeholder="http://127.0.0.1:8787"
              value={apiUrl}
            />
          </label>
        )}
        <label>
          아이디 <input
            autoComplete="username"
            onChange={(event) => setBusinessNumber(event.target.value)}
            placeholder="사업자번호"
            value={businessNumber}
          />
        </label>
        <label>
          비밀번호
          <input
            autoComplete="current-password"
            onChange={(event) => setPassword(event.target.value)}
            type="password"
            value={password}
          />
        </label>
        {error && <p className="error-text">{error}</p>}
        {registeredDevice && (
          <div className="agent-result">
            <strong>{registeredDevice.deviceName}</strong>
            <span>{registeredDevice.desktopName}</span>
            <small>{registeredDevice.businessNumber}</small>
            {registeredDevice.connectionCode && (
              <div style={{ marginTop: "12px", padding: "10px", background: "rgba(99, 102, 241, 0.15)", borderRadius: "6px", color: "#818cf8", fontSize: "18px", fontWeight: "bold", textAlign: "center" }}>
                접속 코드: {registeredDevice.connectionCode}
              </div>
            )}
          </div>
        )}
        <button className="primary-button" disabled={isSubmitting || !isInstallIdentityReady} type="submit">
          <PlugZap size={17} />
          <span>{isSubmitting ? "등록 중" : "등록"}</span>
        </button>
      </form>
    </main>
  );
}

function LoginScreen({
  error,
  onSubmit,
}: {
  error: string;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
}) {
  return (
    <main className="login-screen">
      <form className="login-panel" onSubmit={onSubmit}>
        <div className="login-badge">
          <ShieldCheck size={20} />
          <span>Viewer</span>
        </div>
        <h1>관리자 로그인</h1>
        <label>
          아이디 <input autoComplete="username" name="username" />
        </label>
        <label>
          비밀번호
          <input autoComplete="current-password" name="password" type="password" />
        </label>
        {error && <p className="error-text">{error}</p>}
        <button className="primary-button" type="submit">
          <LogIn size={17} />
          <span>진입</span>
        </button>
      </form>
    </main>
  );
}

function AutoLoginScreen() {
  return (
    <main className="login-screen">
      <div className="login-panel">
        <div className="login-badge">
          <ShieldCheck size={20} />
          <span>Viewer</span>
        </div>
        <h1>Auto login</h1>
        <p>Checking saved Viewer session...</p>
      </div>
    </main>
  );
}

function getOrCreateAgentInstallId(): string {
  const existing = window.localStorage.getItem("wonremote-agent-install-id");
  if (existing) {
    return existing;
  }

  const randomPart =
    "randomUUID" in window.crypto
      ? window.crypto.randomUUID().slice(0, 8)
      : Math.random().toString(36).slice(2, 10);
  const installId = `agent-${randomPart}`;
  window.localStorage.setItem("wonremote-agent-install-id", installId);
  return installId;
}

export function sortDevicesForDisplay(devices: ManagedDevice[]): ManagedDevice[] {
  const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });
  return [...devices].sort((left, right) => {
    const statusOrder = Number(right.status === "online") - Number(left.status === "online");
    if (statusOrder !== 0) {
      return statusOrder;
    }
    return collator.compare(left.desktopName ?? "", right.desktopName ?? "");
  });
}

function DeviceTable({
  activeDeviceId,
  devices,
  onConnect,
  onEdit,
  onSecureConnect,
  onWake,
}: {
  activeDeviceId: string;
  devices: ManagedDevice[];
  onConnect: (device: ManagedDevice) => void | Promise<void>;
  onEdit: (device: ManagedDevice) => void;
  onSecureConnect: (device: ManagedDevice) => void | Promise<void>;
  onWake: (device: ManagedDevice) => void | Promise<void>;
}) {
  return (
    <section className="device-section">
      <div className="section-heading">
        <h2>장비 리스트</h2>
        <span>{devices.length}대</span>
      </div>
      <div className="device-table">
        <div className="table-row table-head">
          <span>상태</span>
          <span>업장</span>
          <span>장비</span>
          <span>데스크탑</span>
          <span>접속</span>
        </div>
        {sortDevicesForDisplay(devices).map((device) => {
          const isOnline = device.status === "online";
          return (
            <div
              className="table-row"
              key={device.id}
              onContextMenu={(event) => {
                event.preventDefault();
                onEdit(device);
              }}
              onDoubleClick={() => {
                if (isOnline) {
                  void onConnect(device);
                }
              }}
              title={isOnline ? "더블클릭하면 바로 접속합니다." : "오프라인 장비입니다."}
            >
              <span className={`status-pill ${isOnline ? "online" : "offline"}`}>{device.status}</span>
              <span className="store-cell">
                <b>{device.storeName}</b>
                <small>{device.businessNumber}</small>
              </span>
              <span>
                <b>{device.deviceNumber}</b>
                <small>{device.deviceName}</small>
              </span>
              <span>
                <b>{device.desktopName}</b>
                {device.controlDiagnostics && (
                  <small>
                    {device.controlDiagnostics.elevated ? "Admin" : "User"} · {device.controlDiagnostics.integrityLevel ?? "Unknown"}
                  </small>
                )}
              </span>
              <span className="device-actions">
                <button
                  className={activeDeviceId === device.id ? "connect-button active" : "connect-button"}
                  disabled={!isOnline}
                  type="button"
                  title={isOnline ? "접속" : "오프라인"}
                  onClick={() => onConnect(device)}
                >
                  <PlugZap size={16} />
                  <span>접속</span>
                </button>
                <button
                  className="connect-button secure"
                  disabled={!isOnline}
                  type="button"
                  title={isOnline ? "보안접속" : "오프라인"}
                  onClick={() => onSecureConnect(device)}
                >
                  <ShieldCheck size={16} />
                  <span>보안</span>
                </button>
                <button
                  className="connect-button edit"
                  type="button"
                  title="장비 정보 수정"
                  onClick={() => onEdit(device)}
                >
                  수정
                </button>
                <button
                  className="connect-button wake"
                  disabled={isOnline || !device.macAddresses?.length}
                  type="button"
                  title={
                    device.macAddresses?.length
                      ? "Wake-on-LAN"
                      : "Agent heartbeat에 MAC 주소가 아직 없습니다"
                  }
                  onClick={() => onWake(device)}
                >
                  <Power size={16} />
                  <span>Wake</span>
                </button>
              </span>
            </div>
          );
        })}
        {devices.length === 0 && <div className="empty-row">등록된 장비가 없습니다.</div>}
      </div>
    </section>
  );
}

const DANGEROUS_SYSTEM_COMMANDS = new Set(["logoff", "restart", "shutdown"]);

function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) {
    return false;
  }
  const tagName = target.tagName.toLowerCase();
  return tagName === "input" || tagName === "textarea" || target.isContentEditable;
}

function mapMouseButton(button: number): MouseButtonCode {
  if (button === 1) {
    return 1;
  }
  if (button === 2) {
    return 2;
  }
  return 0;
}

function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    const chunk = bytes.subarray(offset, offset + 0x8000);
    binary += String.fromCharCode(...chunk);
  }
  return btoa(binary);
}

async function sha256Hex(buffer: ArrayBuffer): Promise<string | undefined> {
  if (!window.crypto?.subtle) {
    return undefined;
  }
  const digest = await window.crypto.subtle.digest("SHA-256", buffer);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function RemoteSessionPanel({
  device,
  sessionId,
  session,
  onInputEvent: sendInputEvent,
  onCloseSession,
}: {
  device: ManagedDevice | null;
  sessionId: string;
  session: RemoteSession | null;
  onInputEvent: (action: string, options?: { localOnly?: boolean }) => void | Promise<void>;
  onCloseSession: () => void;
}) {
  const panelRef = React.useRef<HTMLElement | null>(null);
  const remotePreviewRef = React.useRef<HTMLDivElement | null>(null);
  const canvasRef = React.useRef<HTMLCanvasElement | null>(null);
  const pressedKeysRef = React.useRef<Set<string>>(new Set());
  const suppressedKeyUpsRef = React.useRef<Set<string>>(new Set());
  const pressedButtonsRef = React.useRef<Set<MouseButtonCode>>(new Set());
  const moveFrameRef = React.useRef<number | null>(null);
  const pendingMoveRef = React.useRef<{ dx: number; dy: number } | null>(null);
  const lastClipboardTextRef = React.useRef<string>("");
  const lastClipboardImageHashRef = React.useRef<string>("");
  const pingStateRef = React.useRef<{ start: number } | null>(null);
  const activeTransferIdRef = React.useRef<string>("");
  const storageTransfersRef = React.useRef(
    parseStorageTransferCleanup(window.localStorage.getItem(STORAGE_TRANSFER_CLEANUP_KEY)),
  );
  const tileSequenceRef = React.useRef<Map<string, number>>(new Map());
  const receivedFrameSequenceRef = React.useRef(0);
  const webRtcTransportRef = React.useRef<ViewerWebRtcTransport | null>(null);
  const activeSessionIdRef = React.useRef(sessionId);
  React.useEffect(() => {
    activeSessionIdRef.current = sessionId;
  }, [sessionId]);
  const onInputEvent = React.useCallback((action: string) => {
    const sentOverWebRtc = webRtcTransportRef.current?.sendControl(action) ?? false;
    return sendInputEvent(action, { localOnly: sentOverWebRtc });
  }, [sendInputEvent]);
  const dangerConfirmUntilRef = React.useRef<Record<string, number>>({});
  const [latencyReport, setLatencyReport] = useState<string>("");
  const [pingState, setPingState] = useState<{ start: number } | null>(null);
  const [zoom, setZoom] = useState(1);
  const [streamTransportState, setStreamTransportState] = useState("idle");
  const [isSessionFullscreen, setIsSessionFullscreen] = useState(false);
  const [streamPerformanceMode, setStreamPerformanceMode] = useState<StreamPerformanceMode>(() =>
    normalizeStreamPerformanceMode(window.localStorage.getItem("wonremote-stream-performance-mode")),
  );
  const [selectedDisplayIndex, setSelectedDisplayIndex] = useState(0);
  const [transferProgress, setTransferProgress] = useState<{
    fileName: string;
    progress: number;
    speed: string;
    timeLeft: string;
  } | null>(null);

  // Phase 3 states
  const mediaRecorderRef = React.useRef<MediaRecorder | null>(null);
  const recordedChunksRef = React.useRef<Blob[]>([]);
  const [isRecording, setIsRecording] = useState(false);
  const [chatMessages, setChatMessages] = useState<ChatMessage[]>([]);
  const [chatInput, setChatInput] = useState("");
  const [isClipboardSyncOn, setIsClipboardSyncOn] = useState(false);
  const [isChatOpen, setIsChatOpen] = useState(false);

  useEffect(() => {
    if ((window as any).__TAURI_INTERNALS__) {
      void getCurrentWindow().isFullscreen().then(setIsSessionFullscreen).catch(() => {});
      return;
    }

    const syncBrowserFullscreen = () => setIsSessionFullscreen(Boolean(document.fullscreenElement));
    syncBrowserFullscreen();
    document.addEventListener("fullscreenchange", syncBrowserFullscreen);
    return () => document.removeEventListener("fullscreenchange", syncBrowserFullscreen);
  }, [sessionId]);

  async function toggleSessionFullscreen() {
    try {
      if ((window as any).__TAURI_INTERNALS__) {
        const appWindow = getCurrentWindow();
        const nextFullscreen = !(await appWindow.isFullscreen());
        await appWindow.setFullscreen(nextFullscreen);
        setIsSessionFullscreen(nextFullscreen);
        return;
      }

      if (document.fullscreenElement) {
        await document.exitFullscreen();
      } else {
        await panelRef.current?.requestFullscreen();
      }
    } catch {
      // Fullscreen can be denied by browser policy or a restricted desktop shell.
    }
  }

  const sendClipboardImage = React.useCallback(async (image: Blob, knownSha256?: string) => {
    if (!sessionId) {
      throw new Error("원격 세션이 연결되지 않았습니다.");
    }
    const transport = webRtcTransportRef.current;
    if (!transport) {
      throw new Error("클립보드 이미지는 WebRTC 연결이 완료된 뒤 전송할 수 있습니다.");
    }
    const fileSha256 = knownSha256 ?? await sha256BlobHex(image);
    if (!fileSha256) {
      throw new Error("클립보드 이미지 체크섬을 계산할 수 없습니다.");
    }
    const sent = await transport.sendFile({
      file: image,
      filename: "wonremote-clipboard.png",
      fileSha256,
      transferId: `clipboard-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      purpose: "clipboard-image",
      mimeType: "image/png",
    });
    if (!sent) {
      throw new Error("WebRTC 파일 채널이 아직 준비되지 않았습니다.");
    }
    lastClipboardImageHashRef.current = fileSha256;
  }, [sessionId]);

  const mapRemotePoint = (clientX: number, clientY: number, rect: DOMRect) =>
    mapCanvasPointToVirtualDesktopAbsolute(
      clientX,
      clientY,
      rect,
      device?.displays?.find((display) => display.index === selectedDisplayIndex),
      device?.displays,
    );
  const fileInputRef = React.useRef<HTMLInputElement | null>(null);
  const folderInputRef = React.useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (!device?.displays?.length) {
      setSelectedDisplayIndex(device?.activeDisplayIndex ?? 0);
      return;
    }
    const activeDisplay =
      device.displays.find((display) => display.index === device.activeDisplayIndex) ??
      device.displays.find((display) => display.primary) ??
      device.displays[0];
    setSelectedDisplayIndex(activeDisplay.index);
  }, [device?.id, device?.activeDisplayIndex, device?.displays]);

  useEffect(() => {
    if (session?.state === "connected") {
      panelRef.current?.focus();
    }
  }, [session?.id, session?.state]);

  useEffect(() => {
    if (!sessionId || session?.state !== "connected") {
      return;
    }
    void onInputEvent(buildSetStreamModeCommand(streamPerformanceMode));
  }, [sessionId, session?.state, streamPerformanceMode]);

  useEffect(() => {
    pingStateRef.current = pingState;
  }, [pingState]);

  // Chat/Clipboard/Files polling
  useEffect(() => {
    if (!device || !sessionId || !session || session.state !== "connected") {
      return;
    }

    let active = true;
    const pollData = async () => {
      try {
        // 1. Chat
        const chats = await fetchChatMessages(sessionId);
        if (active && chats.length > 0) {
          const processed = chats.map((c) => {
            if (c.message === "__AUDIO_BEEP_SIGNAL__") {
              playBeepSound();
            }
            return c;
          });
          setChatMessages((prev) => [...prev, ...processed]);
        }

        // 2. Clipboard
        const clips = await fetchClipboardText(sessionId);
        if (active && clips.length > 0) {
          for (const clip of clips) {
            if (clip.sender === "agent") {
              console.log("[Clipboard Sync Received]:", clip.text);
              if (isClipboardSyncOn) {
                await navigator.clipboard.writeText(clip.text).catch(() => {});
              }
            }
          }
        }

        // 3. Files
        const files = await fetchFiles(sessionId);
        if (active && files.length > 0) {
          for (const file of files) {
            const binaryString = atob(file.fileData);
            const bytes = new Uint8Array(binaryString.length);
            for (let i = 0; i < binaryString.length; i++) {
              bytes[i] = binaryString.charCodeAt(i);
            }
            const blob = new Blob([bytes]);
            const url = URL.createObjectURL(blob);
            const a = document.createElement("a");
            a.href = url;
            a.download = file.filename;
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            URL.revokeObjectURL(url);
            console.log(`[File Auto Download]: ${file.filename}`);
          }
        }

        const receipts = await fetchFileTransferReceipts(sessionId);
        for (const completedReceipt of receipts) {
          if (completedReceipt.status !== "received") continue;
          const transfer = storageTransfersRef.current.get(completedReceipt.transferId);
          if (!transfer) continue;
          storageTransfersRef.current.set(completedReceipt.transferId, { ...transfer, received: true });
        }
        window.localStorage.setItem(
          STORAGE_TRANSFER_CLEANUP_KEY,
          serializeStorageTransferCleanup(storageTransfersRef.current),
        );
        for (const [transferId, transfer] of storageTransfersRef.current) {
          if (!transfer.received) continue;
          try {
            await deleteUploadedFileFromStorage(transfer.path);
            storageTransfersRef.current.delete(transferId);
            window.localStorage.setItem(
              STORAGE_TRANSFER_CLEANUP_KEY,
              serializeStorageTransferCleanup(storageTransfersRef.current),
            );
          } catch (error) {
            console.warn("Firebase Storage 전송 원본 정리 재시도 예정:", error);
          }
        }
        if (active && activeTransferIdRef.current && receipts.length > 0) {
          const receipt = receipts.find((item) => item.transferId === activeTransferIdRef.current);
          if (receipt?.status === "received") {
            setTransferProgress({
              fileName: receipt.filename,
              progress: 100,
              speed: "저장 완료",
              timeLeft: "0s",
            });
            activeTransferIdRef.current = "";
            window.setTimeout(() => setTransferProgress(null), 2500);
          } else if (receipt?.status === "failed") {
            activeTransferIdRef.current = "";
            setTransferProgress(null);
            alert(`File transfer failed on agent: ${receipt.error ?? "unknown error"}`);
          } else if (receipt?.status === "partial") {
            setTransferProgress((previous) => previous && {
              ...previous,
              progress: Math.max(previous.progress, Math.round((receipt.receivedChunks / Math.max(1, receipt.totalChunks)) * 100)),
            });
          }
        }
      } catch (e) {
        // ignore
      }
    };

    const intervalId = setInterval(() => void pollData(), 1500);
    return () => {
      active = false;
      clearInterval(intervalId);
    };
  }, [device?.id, sessionId, session?.id, session?.state, isClipboardSyncOn]);

  useEffect(() => {
    if (!isClipboardSyncOn || !sessionId || !session || session.state !== "connected") {
      return;
    }

    let active = true;
    const syncClipboard = async () => {
      try {
        const image = await readClipboardPngBlob();
        if (image) {
          const imageSha256 = await sha256BlobHex(image);
          if (active && imageSha256 && imageSha256 !== lastClipboardImageHashRef.current) {
            await sendClipboardImage(image, imageSha256);
          }
          return;
        }
        const text = await navigator.clipboard.readText();
        if (!active || !text || text === lastClipboardTextRef.current) {
          return;
        }
        lastClipboardTextRef.current = text;
        await sendClipboardText(sessionId, text, "viewer");
      } catch {
        // Clipboard permission can be unavailable outside the packaged app.
      }
    };

    void syncClipboard();
    const intervalId = window.setInterval(() => void syncClipboard(), 1500);
    return () => {
      active = false;
      window.clearInterval(intervalId);
    };
  }, [isClipboardSyncOn, sessionId, session, sendClipboardImage]);

  // Stream Frame drawing
  useEffect(() => {
    if (!device || !sessionId || !session || session.state !== "connected") {
      return;
    }

    setStreamTransportState("starting");
    tileSequenceRef.current.clear();
    receivedFrameSequenceRef.current = 0;
    let active = true;
    let webRtcTransport: ViewerWebRtcTransport | null = null;
    let webRtcReconnectTimer: number | null = null;
    let webRtcReconnectAttempt = 0;
    let webRtcStartInFlight = false;
    type TileFrame = { tiles?: any[]; width?: number; height?: number; sequence?: number; keyframe?: boolean };
    let keyframeRenderPending = false;
    const queuedDuringKeyframe: TileFrame[] = [];

    const resolveFrameSequence = (data: TileFrame) => Number.isFinite(data.sequence)
      ? Number(data.sequence)
      : ++receivedFrameSequenceRef.current;

    const loadTileImage = (tile: any) => new Promise<HTMLImageElement | null>((resolve) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => resolve(null);
      img.src = `data:image/jpeg;base64,${tile.data}`;
    });

    const drawTileCells = (
      ctx: CanvasRenderingContext2D,
      img: CanvasImageSource,
      tile: any,
      frameSequence: number,
      enforceSequence: boolean,
    ) => {
      const tileX = Number(tile.x) * 32;
      const tileY = Number(tile.y) * 32;
      const tileWidth = Number(tile.w);
      const tileHeight = Number(tile.h);
      for (let offsetY = 0; offsetY < tileHeight; offsetY += 32) {
        for (let offsetX = 0; offsetX < tileWidth; offsetX += 32) {
          const cellWidth = Math.min(32, tileWidth - offsetX);
          const cellHeight = Math.min(32, tileHeight - offsetY);
          const cellKey = `${Math.floor((tileX + offsetX) / 32)}:${Math.floor((tileY + offsetY) / 32)}`;
          const previousSequence = tileSequenceRef.current.get(cellKey) ?? -1;
          if (enforceSequence && frameSequence < previousSequence) {
            continue;
          }
          ctx.drawImage(
            img,
            offsetX,
            offsetY,
            cellWidth,
            cellHeight,
            tileX + offsetX,
            tileY + offsetY,
            cellWidth,
            cellHeight,
          );
          if (enforceSequence) {
            tileSequenceRef.current.set(cellKey, frameSequence);
          }
        }
      }
    };

    const measurePresentedPing = (ctx: CanvasRenderingContext2D) => {
      const activePingState = pingStateRef.current;
      if (!activePingState) {
        return;
      }
      scheduleVisualPingPresentedMeasurement({
        requestAnimationFrame: (callback) => requestAnimationFrame(() => active && callback()),
        startedAtMs: activePingState.start,
        readPixel: () => {
          const imgData = ctx.getImageData(5, 5, 1, 1).data;
          return { r: imgData[0], g: imgData[1], b: imgData[2] };
        },
        nowMs: () => performance.now(),
        onPresented: ({ latencyMs }) => {
          if (!active) return;
          setLatencyReport(`E2E Latency: ${latencyMs.toFixed(1)}ms`);
          setPingState(null);
        },
      });
    };

    const renderDeltaFrame = (data: TileFrame) => {
      if (!active) return;

      const canvas = canvasRef.current;
      if (!canvas) return;
      const ctx = canvas.getContext("2d", { willReadFrequently: true });
      if (!ctx) return;

      if (data.width && data.height) {
        if (canvas.width !== data.width || canvas.height !== data.height) {
          canvas.width = data.width;
          canvas.height = data.height;
          ctx.fillStyle = "#1e1e2e";
          ctx.fillRect(0, 0, data.width, data.height);
        }
      }

      if (data.tiles && data.tiles.length > 0) {
        const frameSequence = resolveFrameSequence(data);
        let loadedCount = 0;
        for (const tile of data.tiles) {
          const img = new Image();
          img.onload = () => {
            if (active) {
              drawTileCells(ctx, img, tile, frameSequence, true);
            }
            loadedCount++;
            if (loadedCount === data.tiles!.length) {
              measurePresentedPing(ctx);
            }
          };
          img.src = `data:image/jpeg;base64,${tile.data}`;
        }
      }
    };

    const renderKeyframeAtomically = async (data: TileFrame) => {
      const canvas = canvasRef.current;
      const width = Number(data.width ?? 0);
      const height = Number(data.height ?? 0);
      const tiles = data.tiles ?? [];
      if (!active || !canvas || width <= 0 || height <= 0 || tiles.length === 0) {
        return;
      }
      const frameSequence = resolveFrameSequence(data);
      const staging = document.createElement("canvas");
      staging.width = width;
      staging.height = height;
      const stagingContext = staging.getContext("2d");
      if (!stagingContext) {
        return;
      }
      stagingContext.fillStyle = "#1e1e2e";
      stagingContext.fillRect(0, 0, width, height);
      const decodedTiles = await Promise.all(tiles.map(async (tile) => ({ tile, img: await loadTileImage(tile) })));
      if (!active) {
        return;
      }
      for (const { tile, img } of decodedTiles) {
        if (img) {
          drawTileCells(stagingContext, img, tile, frameSequence, false);
        }
      }
      await new Promise<void>((resolve) => requestAnimationFrame(() => {
        if (active) {
          canvas.width = width;
          canvas.height = height;
          const visibleContext = canvas.getContext("2d", { willReadFrequently: true });
          visibleContext?.drawImage(staging, 0, 0);
          tileSequenceRef.current.clear();
          for (const { tile } of decodedTiles) {
            const tileX = Number(tile.x) * 32;
            const tileY = Number(tile.y) * 32;
            for (let y = 0; y < Number(tile.h); y += 32) {
              for (let x = 0; x < Number(tile.w); x += 32) {
                tileSequenceRef.current.set(`${(tileX + x) / 32}:${(tileY + y) / 32}`, frameSequence);
              }
            }
          }
          if (visibleContext) {
            measurePresentedPing(visibleContext);
          }
        }
        resolve();
      }));
    };

    const drawTileFrame = (data: TileFrame) => {
      if (!active) return;
      if (keyframeRenderPending) {
        queuedDuringKeyframe.push(data);
        return;
      }
      if (data.keyframe) {
        keyframeRenderPending = true;
        void renderKeyframeAtomically(data).finally(() => {
          keyframeRenderPending = false;
          const queued = queuedDuringKeyframe.splice(0);
          for (const frame of queued) {
            drawTileFrame(frame);
          }
        });
        return;
      }
      renderDeltaFrame(data);
    };

    const firebaseEnabled = isViewerFirebaseEnabled();
    if (firebaseEnabled) {
      const scheduleWebRtcReconnect = (reason: string) => {
        if (!active || webRtcReconnectTimer !== null) {
          return;
        }
        const delayMs = webRtcReconnectDelayMs(webRtcReconnectAttempt);
        webRtcReconnectAttempt += 1;
        setStreamTransportState(`webrtc-retrying in ${Math.ceil(delayMs / 1000)}s: ${reason}`);
        webRtcReconnectTimer = window.setTimeout(() => {
          webRtcReconnectTimer = null;
          void startWebRtc();
        }, delayMs);
      };

      const startWebRtc = async () => {
        if (!active || webRtcStartInFlight) {
          return;
        }
        webRtcStartInFlight = true;
        webRtcTransport?.close();
        webRtcTransport = null;
        webRtcTransportRef.current = null;
        setStreamTransportState(webRtcReconnectAttempt > 0 ? "webrtc-reconnecting" : "webrtc-starting");
        try {
          const transport = await startFirebaseViewerWebRtcTransport(sessionId, {
            onFrame: drawTileFrame,
            onState: (state) => {
              if (!active) return;
              setStreamTransportState(state);
              if (state === "webrtc-open") {
                webRtcReconnectAttempt = 0;
              }
            },
            onError: (error) => {
              if (!active) return;
              console.warn("[WebRTC Viewer]", error.message);
              scheduleWebRtcReconnect(error.message);
            },
          });
          if (!active) {
            transport.close();
            return;
          }
          webRtcTransport = transport;
          webRtcTransportRef.current = transport;
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          console.warn("[WebRTC Viewer] transport unavailable:", message);
          scheduleWebRtcReconnect(message);
        } finally {
          webRtcStartInFlight = false;
        }
      };

      void startWebRtc();
    }

    const shouldPollTiles = shouldPollViewerTileFallback({
      firebaseEnabled,
      env: import.meta.env,
    });

    const pollTiles = async () => {
      if (!shouldPollTiles) {
        return;
      }
      try {
        const tileData = await fetchTiles(sessionId);
        if (tileData.tiles?.length) {
          setStreamTransportState((state) =>
            state.startsWith("webrtc-connected") ? state : "diagnostic-fallback-polling",
          );
        }
        drawTileFrame(tileData);
      } catch {
        // Diagnostic fallback retries on the next interval.
      }
    };

    if (shouldPollTiles) {
      void pollTiles();
    }

    const intervalId = shouldPollTiles
      ? setInterval(() => {
          void pollTiles();
        }, 100)
      : null;

    return () => {
      active = false;
      if (webRtcReconnectTimer !== null) {
        window.clearTimeout(webRtcReconnectTimer);
      }
      webRtcTransport?.close();
      if (webRtcTransportRef.current === webRtcTransport) {
        webRtcTransportRef.current = null;
      }
      if (intervalId) {
        clearInterval(intervalId);
      }
    };
  }, [device?.id, sessionId, session?.id, session?.state]);

  const releaseAllInputs = () => {
    suppressedKeyUpsRef.current.clear();
    if (pressedKeysRef.current.size > 0) {
      pressedKeysRef.current.clear();
      onInputEvent("key-release-all");
    }
    if (pressedButtonsRef.current.size > 0) {
      const canvas = canvasRef.current;
      const rect = canvas?.getBoundingClientRect();
      const point = rect
        ? mapRemotePoint(rect.left + rect.width / 2, rect.top + rect.height / 2, rect)
        : { dx: 32768, dy: 32768 };
      for (const button of pressedButtonsRef.current) {
        onInputEvent(buildMouseCommand("up", point.dx, point.dy, button));
      }
      pressedButtonsRef.current.clear();
    }
  };

  const handlePanelBlur = (event: React.FocusEvent<HTMLElement>) => {
    const nextTarget = event.relatedTarget;
    if (nextTarget instanceof Node && event.currentTarget.contains(nextTarget)) {
      return;
    }
    releaseAllInputs();
  };

  const handleCanvasMouseDown = (e: React.MouseEvent<HTMLCanvasElement>) => {
    e.preventDefault();
    const canvas = canvasRef.current;
    if (!canvas) return;

    const rect = canvas.getBoundingClientRect();
    const { dx, dy } = mapRemotePoint(e.clientX, e.clientY, rect);
    const button = mapMouseButton(e.button);
    pressedButtonsRef.current.add(button);
    panelRef.current?.focus();
    onInputEvent(buildMouseCommand("down", dx, dy, button));
  };

  const handleCanvasMouseUp = (e: React.MouseEvent<HTMLCanvasElement>) => {
    e.preventDefault();
    const canvas = canvasRef.current;
    if (!canvas) return;

    const rect = canvas.getBoundingClientRect();
    const { dx, dy } = mapRemotePoint(e.clientX, e.clientY, rect);
    const button = mapMouseButton(e.button);
    pressedButtonsRef.current.delete(button);
    onInputEvent(buildMouseCommand("up", dx, dy, button));
  };

  const handleCanvasMouseMove = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const rect = canvas.getBoundingClientRect();
    pendingMoveRef.current = mapRemotePoint(e.clientX, e.clientY, rect);
    if (moveFrameRef.current !== null) {
      return;
    }
    moveFrameRef.current = window.requestAnimationFrame(() => {
      moveFrameRef.current = null;
      const point = pendingMoveRef.current;
      if (point) {
        onInputEvent(buildMouseCommand("move", point.dx, point.dy));
      }
    });
  };

  const handleCanvasWheel = (e: React.WheelEvent<HTMLCanvasElement>) => {
    e.preventDefault();
    const canvas = canvasRef.current;
    if (!canvas) return;

    const rect = canvas.getBoundingClientRect();
    const { dx, dy } = mapRemotePoint(e.clientX, e.clientY, rect);
    onInputEvent(buildMouseCommand("wheel", dx, dy, 0, e.deltaY > 0 ? -120 : 120));
  };

  const handleKeyDown = async (event: React.KeyboardEvent<HTMLElement>) => {
    if (isEditableTarget(event.target)) {
      return;
    }
    if (event.repeat) {
      event.preventDefault();
      return;
    }

    if (event.ctrlKey && event.key === "Escape") {
      event.preventDefault();
      if (pressedKeysRef.current.delete("Ctrl")) {
        onInputEvent("key-up Ctrl");
      }
      suppressedKeyUpsRef.current.add(event.key);
      onInputEvent("keypress Win");
      return;
    }

    if (event.ctrlKey && event.key.toLowerCase() === "v") {
      event.preventDefault();
      suppressedKeyUpsRef.current.add(event.key);
      const image = await readClipboardPngBlob();
      if (image) {
        const targetSessionId = sessionId;
        const targetTransport = webRtcTransportRef.current;
        if (pressedKeysRef.current.delete("Ctrl")) {
          onInputEvent("key-up Ctrl");
        }
        if (!targetSessionId || !targetTransport || activeSessionIdRef.current !== targetSessionId) {
          return;
        }
        try {
          await sendClipboardImage(image);
          if (
            activeSessionIdRef.current === targetSessionId &&
            webRtcTransportRef.current === targetTransport
          ) {
            onInputEvent("paste");
          }
        } catch (error) {
          console.error("클립보드 이미지 붙여넣기 실패:", error);
        }
        return;
      }
      try {
        const text = await navigator.clipboard.readText();
        if (text) {
          onInputEvent(buildPasteTextCommand(text));
        } else {
          onInputEvent("paste");
        }
      } catch {
        onInputEvent("paste");
      }
      return;
    }

    if (!event.ctrlKey && !event.altKey && !event.metaKey && Array.from(event.key).length === 1) {
      event.preventDefault();
      suppressedKeyUpsRef.current.add(event.key);
      onInputEvent(buildUnicodeTextCommand(event.key));
      return;
    }

    event.preventDefault();
    const command = buildKeyboardCommand("keydown", event.key, event.code);
    pressedKeysRef.current.add(command.slice("key-down ".length));
    onInputEvent(command);
  };

  const handleKeyUp = (event: React.KeyboardEvent<HTMLElement>) => {
    if (isEditableTarget(event.target)) {
      return;
    }
    event.preventDefault();
    if (suppressedKeyUpsRef.current.delete(event.key)) {
      return;
    }
    const command = buildKeyboardCommand("keyup", event.key, event.code);
    pressedKeysRef.current.delete(command.slice("key-up ".length));
    onInputEvent(command);
  };

  useEffect(() => {
    const handleWindowMouseUp = () => {
      if (pressedButtonsRef.current.size === 0) {
        return;
      }
      const canvas = canvasRef.current;
      const rect = canvas?.getBoundingClientRect();
      const point = rect
        ? mapRemotePoint(rect.left + rect.width / 2, rect.top + rect.height / 2, rect)
        : { dx: 32768, dy: 32768 };
      for (const button of pressedButtonsRef.current) {
        onInputEvent(buildMouseCommand("up", point.dx, point.dy, button));
      }
      pressedButtonsRef.current.clear();
    };
    const handleWindowBlur = () => releaseAllInputs();
    const handleVisibilityChange = () => {
      if (document.visibilityState === "hidden") {
        releaseAllInputs();
      }
    };

    window.addEventListener("mouseup", handleWindowMouseUp);
    window.addEventListener("blur", handleWindowBlur);
    document.addEventListener("visibilitychange", handleVisibilityChange);
    return () => {
      window.removeEventListener("mouseup", handleWindowMouseUp);
      window.removeEventListener("blur", handleWindowBlur);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
      if (moveFrameRef.current !== null) {
        window.cancelAnimationFrame(moveFrameRef.current);
        moveFrameRef.current = null;
      }
      releaseAllInputs();
    };
  }, [sessionId]);

  const startVisualPing = () => {
    setPingState({ start: performance.now() });
    onInputEvent("ping-color-change");
  };

  const selectStreamPerformanceMode = (mode: StreamPerformanceMode) => {
    setStreamPerformanceMode(mode);
    window.localStorage.setItem("wonremote-stream-performance-mode", mode);
  };

  // Recording
  const startRecording = () => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    try {
      const stream = (canvas as any).captureStream ? (canvas as any).captureStream(15) : null;
      if (!stream) {
        alert("브라우저가 Canvas 녹화 기능을 지원하지 않습니다.");
        return;
      }
      recordedChunksRef.current = [];
      const mediaRecorder = new MediaRecorder(stream, { mimeType: "video/webm" });
      mediaRecorderRef.current = mediaRecorder;
      mediaRecorder.ondataavailable = (e) => {
        if (e.data && e.data.size > 0) {
          recordedChunksRef.current.push(e.data);
        }
      };
      mediaRecorder.onstop = () => {
        const blob = new Blob(recordedChunksRef.current, { type: "video/webm" });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = `remote-session-record-${Date.now()}.webm`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
      };
      mediaRecorder.start();
      setIsRecording(true);
    } catch (e) {
      console.error("녹화 시작 실패:", e);
    }
  };

  const stopRecording = () => {
    if (mediaRecorderRef.current && isRecording) {
      mediaRecorderRef.current.stop();
      setIsRecording(false);
    }
  };

  // Chat
  const handleSendChat = async (e: React.FormEvent) => {
    e.preventDefault();
    const msg = chatInput.trim();
    if (!msg || !sessionId) return;
    try {
      await sendChatMessage(sessionId, msg, "viewer");
      setChatMessages((prev) => [
        ...prev,
        {
          id: `chat-v-${Date.now()}`,
          message: msg,
          sender: "viewer",
          createdAt: new Date().toISOString(),
        },
      ]);
      setChatInput("");
    } catch (err) {
      console.error("채팅 전송 실패:", err);
    }
  };

  // Clipboard
  const handleSendClipboard = async () => {
    try {
      const image = await readClipboardPngBlob().catch(() => null);
      if (image) {
        await sendClipboardImage(image);
        alert("클립보드 이미지를 원격 장비로 전송했습니다.");
        return;
      }
      const text = await navigator.clipboard.readText();
      if (text && sessionId) {
        await sendClipboardText(sessionId, text, "viewer");
        alert("클립보드 텍스트가 에이전트로 전송되었습니다.");
      }
    } catch (err) {
      if (err instanceof Error) {
        alert(err.message);
        return;
      }
      alert("클립보드 권한이 없거나 데이터가 비어있습니다.");
    }
  };

  const handleFetchClipboard = async () => {
    try {
      await Promise.resolve(onInputEvent("clipboard-request"));
      await new Promise((resolve) => window.setTimeout(resolve, 600));
      const clips = await fetchClipboardText(sessionId);
      const agentClips = clips.filter((clip) => clip.sender === "agent");
      if (agentClips.length > 0) {
        const lastClip = agentClips[agentClips.length - 1];
        await navigator.clipboard.writeText(lastClip.text);
        alert(`클립보드 수신 완료: "${lastClip.text}"`);
      } else {
        alert("대기 중인 클립보드 텍스트가 없습니다.");
      }
    } catch (err) {
      console.error("클립보드 수집 실패:", err);
    }
  };

  // Files
  const transferSingleFile = async (file: File) => {
    if (!sessionId) return;
    const relativePath = (file as File & { webkitRelativePath?: string }).webkitRelativePath?.trim();
    const remoteFilename = relativePath || file.name;
    if (!canTransferRemoteFile(file.size)) {
      throw new Error(`${remoteFilename}: file transfer limit is ${remoteFileLimitLabel()}.`);
    }

    const transferId = `transfer-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    activeTransferIdRef.current = transferId;
    const startedAtMs = performance.now();
    const fileSha256 = await sha256BlobHex(file);
    if (!fileSha256) {
      throw new Error("File checksum is unavailable in this runtime.");
    }

    if (isViewerFirebaseEnabled()) {
      const realtimeTransport = webRtcTransportRef.current;
      if (realtimeTransport) {
        try {
          const sentOverWebRtc = await realtimeTransport.sendFile({
            file,
            filename: remoteFilename,
            fileSha256,
            transferId,
            onProgress: (receivedBytes, totalBytes) => {
              setTransferProgress({
                fileName: remoteFilename,
                ...formatTransferStats(receivedBytes, totalBytes, startedAtMs, performance.now()),
              });
            },
          });
          if (sentOverWebRtc) {
            setTransferProgress({
              fileName: remoteFilename,
              ...formatTransferStats(file.size, file.size, startedAtMs, performance.now()),
            });
            window.setTimeout(() => setTransferProgress(null), 2500);
            return;
          }
        } catch (error) {
          console.warn("WebRTC file transfer failed; trying the signed Firebase fallback.", error);
        }
      }

      try {
        const upload = await uploadFileToStorage(sessionId, {
          file,
          fileSha256,
          filename: remoteFilename,
          onProgress: (sentBytes, totalBytes) => {
            setTransferProgress({
              fileName: remoteFilename,
              ...formatTransferStats(sentBytes, totalBytes, startedAtMs, performance.now()),
            });
          },
          totalBytes: file.size,
          transferId,
        });
        storageTransfersRef.current.set(transferId, { path: upload.storagePath, received: false });
        window.localStorage.setItem(
          STORAGE_TRANSFER_CLEANUP_KEY,
          serializeStorageTransferCleanup(storageTransfersRef.current),
        );
        setTransferProgress({
          fileName: remoteFilename,
          ...formatTransferStats(file.size, file.size, startedAtMs, performance.now()),
        });
        window.setTimeout(() => setTransferProgress(null), 2500);
        return;
      } catch (err) {
        setTransferProgress(null);
        if (!canUseFirestoreDirectFileTransfer(file.size)) {
          throw new Error(
            `WebRTC and Firebase Storage are unavailable. Files over 5MB require an open WebRTC file channel or an initialized Firebase Storage bucket. ${err instanceof Error ? err.message : err}`,
          );
        }
        console.warn("Firebase Storage unavailable; using the bounded Firestore file fallback.", err);
      }
    }

    const totalChunks = Math.max(1, Math.ceil(file.size / REMOTE_FILE_CHUNK_BYTES));
    let sentBytes = 0;

    try {
      for (let chunkIndex = 0; chunkIndex < totalChunks; chunkIndex += 1) {
        const start = chunkIndex * REMOTE_FILE_CHUNK_BYTES;
        const end = Math.min(file.size, start + REMOTE_FILE_CHUNK_BYTES);
        const chunk = file.slice(start, end);
        const chunkBuffer = await chunk.arrayBuffer();
        const fileData = arrayBufferToBase64(chunkBuffer);
        const chunkSha256 = await sha256Hex(chunkBuffer);
        await uploadFileChunk(sessionId, {
          filename: remoteFilename,
          fileData,
          transferId,
          chunkIndex,
          totalChunks,
          totalBytes: file.size,
          isLast: chunkIndex === totalChunks - 1,
          chunkSha256,
          ...(chunkIndex === totalChunks - 1 ? { fileSha256 } : {}),
        });
        sentBytes = end;
        setTransferProgress({
          fileName: remoteFilename,
          ...formatTransferStats(sentBytes, file.size, startedAtMs, performance.now()),
        });
      }
      window.setTimeout(() => setTransferProgress(null), 2500);
    } catch (err) {
      setTransferProgress(null);
      throw err;
    }
  };

  const transferSelectedFiles = async (files: File[]) => {
    if (!sessionId || files.length === 0) return;
    try {
      for (const file of files) {
        await transferSingleFile(file);
      }
    } catch (error) {
      alert("File transfer failed: " + (error instanceof Error ? error.message : error));
    }
  };

  const handleFileUpload = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(event.target.files ?? []);
    event.target.value = "";
    await transferSelectedFiles(files);
  };

  const handleFileDrop = (event: React.DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    void transferSelectedFiles(Array.from(event.dataTransfer.files));
  };

  const setFitZoom = () => {
    setZoom(1);
  };

  const setActualSizeZoom = () => {
    const canvas = canvasRef.current;
    const preview = remotePreviewRef.current;
    if (!canvas || !preview || canvas.width <= 0 || canvas.height <= 0) {
      setZoom(1);
      return;
    }
    const fitScale = Math.min(preview.clientWidth / canvas.width, preview.clientHeight / canvas.height);
    setZoom(fitScale > 0 ? Math.min(8, 1 / fitScale) : 1);
  };

  const handleSwitchDisplay = (index: number) => {
    setSelectedDisplayIndex(index);
    onInputEvent(buildSwitchMonitorCommand(index));
  };

  const handleSystemCommand = (command: string) => {
    if (DANGEROUS_SYSTEM_COMMANDS.has(command)) {
      const now = Date.now();
      const confirmUntil = dangerConfirmUntilRef.current[command] ?? 0;
      if (confirmUntil < now) {
        dangerConfirmUntilRef.current[command] = now + 5000;
        alert("위험 명령입니다. 5초 안에 같은 버튼을 한 번 더 누르면 실행됩니다.");
        return;
      }
      dangerConfirmUntilRef.current[command] = 0;
    }
    onInputEvent(buildSystemCommand(command));
  };

  const triggerBeepSound = async () => {
    if (sessionId) {
      await sendChatMessage(sessionId, "__AUDIO_BEEP_SIGNAL__", "viewer");
      playBeepSound();
    }
  };

  if (!device || !session) {
    return (
      <section className="session-panel">
        <div className="section-heading">
          <h2>원격 세션 (실시간 스트림)</h2>
          <span>대기</span>
        </div>
        <div className="remote-screen">
          <div className="remote-placeholder">세션 없음</div>
        </div>
      </section>
    );
  }

  if (session.state === "pending") {
    return (
      <section className="session-panel">
        <div className="section-heading">
          <h2>원격 세션 (실시간 스트림)</h2>
          <span>{device.desktopName}</span>
        </div>
        <div className="remote-screen" style={{ display: "flex", flexDirection: "column", gap: "24px", alignItems: "center", justifyContent: "center", background: "#0f0f1a", minHeight: "400px" }}>
          <div className="status-pill" style={{ background: "rgba(99, 102, 241, 0.2)", color: "#818cf8", padding: "12px 24px", fontSize: "16px", fontWeight: "bold" }}>
            에이전트 연결 준비 중...
          </div>
          <p style={{ color: "#94a3b8", fontSize: "14px", textAlign: "center", maxWidth: "300px" }}>
            Agent 상태를 확인하는 중입니다. 정상 등록된 온라인 장비는 별도 승인 없이 자동으로 연결됩니다.
          </p>
          <button
            onClick={onCloseSession}
            style={{ background: "#ef4444", border: "none", color: "#fff", padding: "10px 20px", borderRadius: "6px", fontWeight: "bold", cursor: "pointer" }}
          >
            접속 시도 취소
          </button>
        </div>
      </section>
    );
  }

  const controlLimited = shouldWarnAboutControlLimit(device.controlDiagnostics);

  return (
    <section
      ref={panelRef}
      className="session-panel"
      style={{ display: "flex", flexDirection: "column", position: "relative", outline: "none" }}
      tabIndex={0}
      onBlur={handlePanelBlur}
      onKeyDown={handleKeyDown}
      onKeyUp={handleKeyUp}
    >
      <div className="remote-work-area" style={{ display: "flex", flex: 1, gap: "16px", minHeight: "450px" }}>
        {/* 원격 스크린 영역 */}
        <div className="remote-screen connected" style={{ display: "flex", flexDirection: "column", flex: 1, overflow: "hidden" }}>
          <div className="remote-titlebar">
            <div className="remote-titlebar-identity">
              <span>{device.deviceName}</span>
              <span>{device.businessNumber}</span>
            </div>
            <div className="remote-titlebar-status">
              <strong>{device.desktopName}</strong>
              <span className="status-pill" style={{ background: "rgba(14, 165, 233, 0.16)", color: "#38bdf8" }}>
                {streamTransportState}
              </span>
              {controlLimited && (
                <span className="status-pill" style={{ background: "rgba(239, 68, 68, 0.16)", color: "#fca5a5" }}>
                  input limited
                </span>
              )}
              {latencyReport && (
                <span className="status-pill" style={{ background: "rgba(99, 102, 241, 0.2)", color: "#818cf8" }}>
                  {latencyReport}
                </span>
              )}
            </div>
          </div>
          <div
            ref={remotePreviewRef}
            className="remote-preview"
            onDragOver={(event) => event.preventDefault()}
            onDrop={handleFileDrop}
            style={{ padding: 0, overflow: "hidden", display: "flex", alignItems: "center", justifyContent: "center", flex: 1 }}
          >
            <canvas
              ref={canvasRef}
              onContextMenu={(event) => event.preventDefault()}
              onMouseDown={handleCanvasMouseDown}
              onMouseMove={handleCanvasMouseMove}
              onMouseUp={handleCanvasMouseUp}
              onWheel={handleCanvasWheel}
              style={{
                width: "100%",
                height: "auto",
                display: "block",
                cursor: "crosshair",
                transform: `scale(${zoom})`,
                transformOrigin: "center center",
              }}
            />
          </div>
        </div>

        {/* 접이식 채팅 패널 */}
        {isChatOpen && (
          <div style={{ width: "260px", background: "#151522", border: "1px solid #2d2d3f", borderRadius: "8px", display: "flex", flexDirection: "column", padding: "12px" }}>
            <div style={{ borderBottom: "1px solid #2d2d3f", paddingBottom: "8px", marginBottom: "8px", fontWeight: "bold", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <span>실시간 채팅</span>
              <button
                onClick={() => setIsChatOpen(false)}
                style={{ background: "none", border: "none", color: "#94a3b8", cursor: "pointer", fontWeight: "bold" }}
              >
                닫기
              </button>
            </div>
            <div style={{ flex: 1, overflowY: "auto", display: "flex", flexDirection: "column", gap: "8px", marginBottom: "8px", maxHeight: "300px" }}>
              {chatMessages.map((msg) => {
                if (msg.message === "__AUDIO_BEEP_SIGNAL__") return null;
                const isViewer = msg.sender === "viewer";
                return (
                  <div key={msg.id} style={{ alignSelf: isViewer ? "flex-end" : "flex-start", background: isViewer ? "#4f46e5" : "#2d2d3f", color: "#fff", padding: "6px 12px", borderRadius: "8px", maxWidth: "80%", fontSize: "12px" }}>
                    <strong>{isViewer ? "나: " : "에이전트: "}</strong>
                    {msg.message}
                  </div>
                );
              })}
            </div>
            <form onSubmit={handleSendChat} style={{ display: "flex", gap: "6px", background: "none", padding: 0, border: "none" }}>
              <input
                value={chatInput}
                onChange={(e) => setChatInput(e.target.value)}
                placeholder="메시지 입력..."
                style={{ flex: 1, padding: "6px", background: "#0f0f1a", border: "1px solid #2d2d3f", borderRadius: "4px", color: "#fff", fontSize: "12px" }}
              />
              <button type="submit" style={{ background: "#4f46e5", border: "none", color: "#fff", padding: "6px 12px", borderRadius: "4px", cursor: "pointer", fontSize: "12px" }}>
                전송
              </button>
            </form>
          </div>
        )}
      </div>

      {/* 액션 컨트롤러 영역 */}
      <div className="session-actions session-actions-top">
        <div className="stream-mode-control" role="group" aria-label="화면 반응 속도">
          <button
            type="button"
            className={streamPerformanceMode === "fast" ? "active" : ""}
            aria-pressed={streamPerformanceMode === "fast"}
            onClick={() => selectStreamPerformanceMode("fast")}
            title="스크롤과 새 창 표시를 우선합니다"
          >
            반응속도 빠름
          </button>
          <button
            type="button"
            className={streamPerformanceMode === "normal" ? "active" : ""}
            aria-pressed={streamPerformanceMode === "normal"}
            onClick={() => selectStreamPerformanceMode("normal")}
            title="화질과 네트워크 안정성을 우선합니다"
          >
            보통
          </button>
        </div>
        <button className="secondary-button" type="button" onClick={toggleSessionFullscreen} title="전체화면 전환">
          {isSessionFullscreen ? <Minimize2 size={17} /> : <Maximize2 size={17} />}
          <span>{isSessionFullscreen ? "전체화면 종료" : "전체화면"}</span>
        </button>
        <button className="secondary-button" type="button" onClick={setFitZoom} title="Fit">
          <Maximize2 size={17} />
          <span>Fit</span>
        </button>
        <button className="secondary-button" type="button" onClick={setActualSizeZoom} title="100%">
          <Monitor size={17} />
          <span>100%</span>
        </button>
        <button className="secondary-button" type="button" onClick={() => setZoom((value) => Math.max(0.25, Number((value - 0.25).toFixed(2))))} title="Zoom out">
          <ZoomOut size={17} />
          <span>{Math.round(zoom * 100)}%</span>
        </button>
        <button className="secondary-button" type="button" onClick={() => setZoom((value) => Math.min(8, Number((value + 0.25).toFixed(2))))} title="Zoom in">
          <ZoomIn size={17} />
          <span>+</span>
        </button>
        {device.displays && device.displays.length > 0 && (
          <select
            value={selectedDisplayIndex}
            onChange={(event) => handleSwitchDisplay(Number(event.target.value))}
            style={{ background: "#151522", border: "1px solid #2d2d3f", color: "#e5e7eb", borderRadius: "6px", padding: "8px 10px" }}
            title="Monitor"
          >
            {device.displays.map((display) => (
              <option key={display.index} value={display.index}>
                {display.primary ? "Primary " : ""}#{display.index + 1} {display.width}x{display.height} {display.name}
              </option>
            ))}
          </select>
        )}
        <button className="secondary-button" type="button" onClick={startVisualPing}>
          <MousePointerClick size={17} />
          <span>Visual Ping 측정</span>
        </button>
        <button className="secondary-button" type="button" onClick={() => onInputEvent("keypress A")}>
          <Keyboard size={17} />
          <span>키 입력 A</span>
        </button>
        {(device.displays?.length ? device.displays : [
          { index: 0, name: "Fallback", width: 0, height: 0, primary: true },
          { index: 1, name: "Fallback", width: 0, height: 0, primary: false },
        ]).map((display) => (
          <button
            className={selectedDisplayIndex === display.index ? "secondary-button active" : "secondary-button"}
            key={`display-button-${display.index}`}
            type="button"
            onClick={() => handleSwitchDisplay(display.index)}
            title={display.width > 0 ? `${display.width}x${display.height} ${display.name}` : `Monitor ${display.index + 1}`}
          >
            <Monitor size={17} />
            <span>{display.primary ? "Primary" : `Monitor ${display.index + 1}`}</span>
          </button>
        ))}

        {/* 3단계 기능들 */}
        {[
          ["services.msc", "서비스"],
          ["taskmgr", "작업 관리자"],
          ["cmd", "CMD"],
          ["explorer", "탐색기"],
          ["devmgmt.msc", "장치관리자"],
          ["lock", "화면 잠금"],
          ["logoff", "로그오프"],
          ["restart", "재시작"],
          ["shutdown", "전원 끄기"],
        ].map(([command, label]) => (
          <button
            key={command}
            className="secondary-button"
            type="button"
            onClick={() => handleSystemCommand(command)}
            title={DANGEROUS_SYSTEM_COMMANDS.has(command) ? "Double click required" : label}
            style={DANGEROUS_SYSTEM_COMMANDS.has(command) ? { borderColor: "rgba(239, 68, 68, 0.45)", color: "#fca5a5" } : undefined}
          >
            {DANGEROUS_SYSTEM_COMMANDS.has(command) ? <Power size={17} /> : <RotateCcw size={17} />}
            <span>{label}</span>
          </button>
        ))}

        <button className="secondary-button" type="button" onClick={() => setIsChatOpen(!isChatOpen)}>
          <MessageSquare size={17} />
          <span>채팅 {chatMessages.length > 0 && `(${chatMessages.length})`}</span>
        </button>

        <button className="secondary-button" type="button" onClick={triggerBeepSound} title="오디오 비프음 송출">
          <Volume2 size={17} />
          <span>사운드 테스트</span>
        </button>

        <button
          className="secondary-button"
          type="button"
          onClick={isRecording ? stopRecording : startRecording}
          style={{ background: isRecording ? "rgba(239, 68, 68, 0.15)" : "", color: isRecording ? "#ef4444" : "" }}
        >
          <Video size={17} />
          <span>{isRecording ? "녹화 중지" : "세션 녹화"}</span>
        </button>

        <button className="secondary-button" type="button" onClick={handleSendClipboard} title="뷰어 복사 텍스트 에이전트로 전달">
          <Clipboard size={17} />
          <span>클립보드 보내기</span>
        </button>

        <button className="secondary-button" type="button" onClick={handleFetchClipboard} title="에이전트 복사 텍스트 가져오기">
          <Clipboard size={17} />
          <span>클립보드 가져오기</span>
        </button>

        <label style={{ display: "flex", alignItems: "center", gap: "6px", color: "#94a3b8", fontSize: "12px", cursor: "pointer" }}>
          <input
            type="checkbox"
            checked={isClipboardSyncOn}
            onChange={(e) => setIsClipboardSyncOn(e.target.checked)}
          />
          자동 동기화
        </label>

        <button className="secondary-button" type="button" onClick={() => fileInputRef.current?.click()}>
          <FileUp size={17} />
          <span>{`파일 전송 (${remoteFileLimitLabel()})`}</span>
        </button>
        <input
          multiple
          type="file"
          ref={fileInputRef}
          onChange={handleFileUpload}
          style={{ display: "none" }}
        />
        <button className="secondary-button" type="button" onClick={() => folderInputRef.current?.click()}>
          <FileUp size={17} />
          <span>폴더 전송</span>
        </button>
        <input
          multiple
          type="file"
          ref={(node) => {
            folderInputRef.current = node;
            node?.setAttribute("webkitdirectory", "");
          }}
          onChange={handleFileUpload}
          style={{ display: "none" }}
        />
        {transferProgress && (
          <span className="status-pill" style={{ background: "rgba(16, 185, 129, 0.15)", color: "#34d399" }}>
            {transferProgress.fileName} {transferProgress.progress}% {transferProgress.speed} ETA {transferProgress.timeLeft}
          </span>
        )}

        <button
          className="secondary-button"
          type="button"
          onClick={onCloseSession}
          style={{ marginLeft: "auto", background: "rgba(239, 68, 68, 0.2)", color: "#ef4444" }}
        >
          <LogOut size={17} />
          <span>세션 종료</span>
        </button>
      </div>
    </section>
  );
}
