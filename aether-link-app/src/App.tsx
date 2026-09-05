import {
  CircleDot,
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
  ChevronDown,
  ChevronUp,
  RotateCcw,
  Power,
  Trash2,
  LayoutDashboard,
  Wifi,
  WifiOff,
  TriangleAlert,
  Pencil,
  SlidersHorizontal,
  Users,
  ArrowLeft,
  Send,
  Activity,
  Star,
  X,
  Columns2,
  GripVertical,
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
  subscribeSessionData,
  sendClipboardText,
  fetchClipboardText,
  uploadFileChunk,
  uploadFileToStorage,
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
import type { SessionData } from "./domain/sessionData";
import {
  isViewerFirebaseEnabled,
  startFirebaseViewerWebRtcTransport,
  subscribeViewerAuthState,
  loadFirebaseUpdateRollout,
  saveFirebaseUpdateRollout,
  updateFirebaseDeviceRollout,
  isCurrentViewerAccountManager,
  requestViewerPasswordReset,
  type ViewerWebRtcTransport,
} from "./firebase/viewerFirebase";
import { ViewerAccountManager } from "./components/ViewerAccountManager";
import { IosCapabilityProbe } from "./components/IosCapabilityProbe";
import { isMobileViewerPath } from "./domain/mobileViewer";
import { groupDevicesByStore } from "./domain/agentRegistry";
import {
  scheduleVisualPingPresentedMeasurement,
} from "./domain/visualPing";
import { getViewerVersion } from "./domain/versioning";
import {
  CURRENT_REMOTE_PROTOCOL_VERSION,
  evaluateRemoteProtocolCompatibility,
  remoteProtocolErrorMessage,
} from "./domain/remoteProtocol";
import {
  resolveViewerUpdateIntervalMs,
  shouldNotifyUpdate,
} from "./domain/updatePolicy";
import { shouldPollViewerTileFallback } from "./domain/realtimeTransportPolicy";
import {
  buildSetStreamModeCommand,
  normalizeStreamPerformanceMode,
  type StreamPerformanceMode,
} from "./domain/streamPerformanceMode";
import {
  ACTIVE_SESSION_STORAGE_KEY,
  consumeActiveSessionForStartupCleanup,
  enqueueSessionCleanup,
  readSessionCleanupQueue,
  removeSessionCleanup,
  serializeActiveSession,
} from "./domain/sessionPersistence";
import { sha256BlobHex } from "./domain/blobHash";
import {
  STORAGE_TRANSFER_CLEANUP_KEY,
  parseStorageTransferCleanup,
  serializeStorageTransferCleanup,
} from "./domain/storageTransferCleanup";
import {
  DEVICE_TYPE_PRESETS,
  resolveDeviceTypeEditor,
  resolveDeviceTypeValue,
  type DeviceTypeChoice,
} from "./domain/deviceType";
import {
  buildKeyboardCommand,
  buildMouseCommand,
  buildPasteTextCommand,
  buildReplaceUnicodeTextCommand,
  buildUnicodeTextCommand,
  buildSwitchMonitorCommand,
  buildSystemCommand,
  formatTransferStats,
  isHangulToggleKey,
  mapCanvasPointToVirtualDesktopAbsolute,
  type MouseButtonCode,
} from "./domain/remoteControlCommands";
import {
  consumeRemoteTextInput,
  finishRemoteComposition,
  isExactCtrlShortcut,
  isRemoteTextInputKeystroke,
  replaceRemoteComposition,
  normalizeWheelDelta,
  pressTrackedKey,
  pressTrackedMouseButton,
  releaseTrackedKey,
  releaseTrackedKeyByRemoteKey,
  releaseTrackedMouseButton,
  releaseTrackedMouseButtonsMissingFromMask,
  shouldForwardTrackedKeyRepeat,
  shouldUseReliableInputFallback,
} from "./domain/viewerInputState";
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
  ConnectionHistoryEntry,
  DeviceMetadataUpdateInput,
  DeviceUpdateRing,
} from "./domain/types";
import type { UpdateFleetRollout } from "./domain/updateFleetPolicy";
import {
  filterDeviceWorkspace,
  parseFavoriteDeviceIds,
  pruneSelectedDeviceIds,
  serializeFavoriteDeviceIds,
  type DeviceWorkspaceStatusFilter,
} from "./domain/deviceWorkspace";
import {
  appendFileTransferQueueItems,
  cancelFileTransfer,
  completeFileTransfer,
  createFileTransferQueueItem,
  failFileTransfer,
  getFileTransferEtaSeconds,
  getFileTransferPercent,
  markFileTransferTransferring,
  updateFileTransferProgress,
  type FileTransferQueueItem,
} from "./domain/fileTransferQueue";
import { closeSessionTab, upsertSessionTab } from "./domain/sessionTabs";
import { clampSplitRatio, validateSameGroupSplit } from "./domain/splitSessionView";
import { formatControlDiagnostics, formatStreamDiagnostics } from "./domain/sessionDiagnostics";
import { formatDeviceSystemInfo } from "./domain/deviceSystemInfo";
import {
  deviceViewPreferencesKey,
  parseDeviceViewPreferences,
} from "./domain/deviceViewPreferences";

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

type ViewerUpdateDialogState =
  | { kind: "available"; version: string }
  | { kind: "current"; version: string }
  | { kind: "error"; message: string };

type DeviceUpdateInfo = {
  kind: "current" | "active" | "attention" | "unknown";
  label: string;
};

function resolveDeviceUpdateInfo(device: ManagedDevice): DeviceUpdateInfo {
  // These fields are accepted from newer Agents before ManagedDevice is expanded.
  const candidate = device as ManagedDevice & Record<string, unknown>;
  const state = [candidate.updateState, candidate.updateStatus]
    .find((value): value is string => typeof value === "string")
    ?.toLowerCase();
  const targetVersion = [candidate.updateTargetVersion, candidate.availableVersion, candidate.latestVersion]
    .find((value): value is string => typeof value === "string" && value.trim().length > 0);
  const currentVersion = [candidate.updateCurrentVersion, device.version]
    .find((value): value is string => typeof value === "string" && value.trim().length > 0);
  const needsUpdate = candidate.updateAvailable === true
    || ["available", "required", "outdated", "pending", "failed", "rollback"].includes(state ?? "");
  if (["checking", "downloading", "installing", "restarting"].includes(state ?? "")) {
    const progress = typeof candidate.updateProgress === "number" ? ` ${candidate.updateProgress}%` : "";
    return { kind: "active", label: state === "downloading" ? `다운로드${progress}` : "업데이트 진행 중" };
  }

  if (state === "failed") {
    return { kind: "attention", label: "업데이트 실패" };
  }
  if (state === "rollback") {
    return { kind: "attention", label: "이전 버전 복원" };
  }

  if (needsUpdate) {
    return { kind: "attention", label: targetVersion ? `업데이트 ${targetVersion}` : "업데이트 필요" };
  }
  if (currentVersion) {
    return { kind: "current", label: `v${currentVersion}` };
  }
  return { kind: "unknown", label: "버전 미확인" };
}

function useModalEscape(onClose: () => void) {
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [onClose]);
}

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
  const [appMode, setAppMode] = useState<"viewer" | "agent" | "ios-probe" | null>(null);

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
      setAppMode(window.location.pathname.replace(/\/+$/, "") === "/ios-check"
        ? "ios-probe"
        : modeParam === "agent" ? "agent" : "viewer");
    }
  }, []);

  if (appMode === null) {
    return <div style={{ background: "#0f0f1a", minHeight: "100vh" }}></div>;
  }

  if (appMode === "ios-probe") return <IosCapabilityProbe />;
  return appMode === "agent" ? <AgentFirstRunApp /> : <ViewerApp />;
}

function ViewerApp() {
  const isMobileViewer = isMobileViewerPath(window.location.pathname);
  const [isAuthenticated, setIsAuthenticated] = useState(false);
  const [isCheckingAutoLogin, setIsCheckingAutoLogin] = useState(() => isViewerFirebaseEnabled());
  const [loginError, setLoginError] = useState("");
  const [devices, setDevices] = useState<ManagedDevice[]>([]);
  const [sessions, setSessions] = useState<RemoteSession[]>([]);
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const [splitSessionIds, setSplitSessionIds] = useState<readonly [string, string] | null>(null);
  const [splitRatio, setSplitRatio] = useState(50);
  const [apiError, setApiError] = useState("");
  const [query, setQuery] = useState("");
  const [selectedStore, setSelectedStore] = useState("전체");
  const [statusFilter, setStatusFilter] = useState<DeviceWorkspaceStatusFilter>("all");
  const [favoriteOnly, setFavoriteOnly] = useState(false);
  const [favoriteDeviceIds, setFavoriteDeviceIds] = useState<string[]>(() =>
    parseFavoriteDeviceIds(window.localStorage.getItem("wonremote-favorite-devices")),
  );
  const [selectedDeviceIds, setSelectedDeviceIds] = useState<string[]>([]);
  const [diagnosticTarget, setDiagnosticTarget] = useState<ManagedDevice | null>(null);
  const [isManualUpdateChecking, setIsManualUpdateChecking] = useState(false);
  const [viewerUpdateDialog, setViewerUpdateDialog] = useState<ViewerUpdateDialogState | null>(null);
  const [isRefreshingDevices, setIsRefreshingDevices] = useState(false);
  const [deviceListRefreshKey, setDeviceListRefreshKey] = useState(0);
  const deviceListRequestRef = useRef<Promise<ManagedDevice[]> | null>(null);
  const startupSessionCleanupAttemptedRef = useRef(false);
  const connectionEpochRef = useRef(0);
  const pendingConnectAttemptsRef = useRef<Set<Promise<{ cleanupSucceeded: boolean; connected: boolean }>>>(new Set());
  const pendingConnectDeviceIdsRef = useRef<Set<string>>(new Set());
  const pendingSessionCloseTasksRef = useRef<Set<Promise<void>>>(new Set());
  const closingDeviceIdsRef = useRef<Set<string>>(new Set());
  const sessionShutdownInProgressRef = useRef(false);
  const [editTarget, setEditTarget] = useState<DeviceEditTarget | null>(null);
  const [secureConnect, setSecureConnect] = useState<SecureConnectState | null>(null);
  const [rolloutDraft, setRolloutDraft] = useState<UpdateFleetRollout | null>(null);
  const [isRolloutOpen, setIsRolloutOpen] = useState(false);
  const [isRolloutSaving, setIsRolloutSaving] = useState(false);
  const [canManageViewerAccounts, setCanManageViewerAccounts] = useState(false);
  const [isAccountManagerOpen, setIsAccountManagerOpen] = useState(false);

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
        if (!hasSession) { setDeviceListRefreshKey(0); setIsRefreshingDevices(false); setDevices([]); }
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

  useEffect(() => {
    if (!isAuthenticated || !isViewerFirebaseEnabled()) {
      setCanManageViewerAccounts(false);
      return;
    }
    let active = true;
    void isCurrentViewerAccountManager()
      .then((allowed) => {
        if (active) setCanManageViewerAccounts(allowed);
      })
      .catch(() => {
        if (active) setCanManageViewerAccounts(false);
      });
    return () => { active = false; };
  }, [isAuthenticated]);

  // Native commands perform signed checks and installation; the WebView owns user consent.
  useEffect(() => {
    if ((window as any).__TAURI_INTERNALS__ || isMobileViewer) {
      return;
    }

    const currentViewerVersion = getViewerVersion(import.meta.env);
    let active = true;
    const checkViewerUpdate = async () => {
      try {
        const data = await fetchViewerUpdateMetadata(import.meta.env);
        if (!data) return;

        const latestVersion = data.latestVersion;
        if (active && typeof latestVersion === "string" && shouldNotifyUpdate(data, currentViewerVersion)) {
          setViewerUpdateDialog((current) => current ?? { kind: "available", version: latestVersion });
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
    };
  }, []);

  useEffect(() => {
    if (!(window as any).__TAURI_INTERNALS__) {
      return;
    }

    let active = true;
    const checkNativeViewerUpdate = async () => {
      try {
        const update = await invoke<{ available: boolean; latestVersion: string }>("check_installer_update");
        if (active && update.available) {
          setViewerUpdateDialog((current) => current ?? {
            kind: "available",
            version: update.latestVersion,
          });
        }
      } catch {
        // Automatic checks retry later. Manual checks surface the error to the user.
      }
    };

    const initialTimer = window.setTimeout(() => void checkNativeViewerUpdate(), 3_000);
    const interval = window.setInterval(
      () => void checkNativeViewerUpdate(),
      resolveViewerUpdateIntervalMs(import.meta.env),
    );
    return () => {
      active = false;
      window.clearTimeout(initialTimer);
      window.clearInterval(interval);
    };
  }, []);


  const handleManualViewerUpdate = async () => {
    if (isManualUpdateChecking) {
      return;
    }
    setIsManualUpdateChecking(true);
    try {
      const currentViewerVersion = getViewerVersion(import.meta.env);
      const update = (window as any).__TAURI_INTERNALS__
        ? await invoke<{ available: boolean; latestVersion: string }>("check_installer_update")
        : await fetchViewerUpdateMetadata(import.meta.env);
      const isAvailable = update && ("available" in update
        ? update.available
        : shouldNotifyUpdate(update, currentViewerVersion));
      if (isAvailable) {
        setViewerUpdateDialog({ kind: "available", version: update.latestVersion! });
      } else {
        setViewerUpdateDialog({ kind: "current", version: currentViewerVersion });
      }
    } catch (error) {
      const message = error instanceof Error && error.message.trim()
        ? error.message.trim()
        : "The signed update server could not be reached.";
      setViewerUpdateDialog({ kind: "error", message });
    } finally {
      setIsManualUpdateChecking(false);
    }
  };

  const handleConfirmViewerUpdate = async () => {
    setViewerUpdateDialog(null);
    try {
      if ((window as any).__TAURI_INTERNALS__) {
        await invoke("start_installer_update", { restartMode: "viewer" });
        return;
      }
      window.location.reload();
    } catch (error) {
      setViewerUpdateDialog({
        kind: "error",
        message: error instanceof Error ? error.message : "업데이트를 시작할 수 없습니다.",
      });
    }
  };

  const handleRefreshDeviceList = () => {
    if (!deviceListRequestRef.current && !isRefreshingDevices) {
      setDeviceListRefreshKey((current) => current + 1);
    }
  };

  const handleOpenRollout = async () => {
    setIsRolloutOpen(true);
    if (!rolloutDraft) {
      const current = isViewerFirebaseEnabled() ? await loadFirebaseUpdateRollout().catch(() => null) : null;
      setRolloutDraft(current ?? { targetVersion: "", stage: "canary", percentage: 10, paused: true });
    }
  };

  const handleSaveRollout = async (rollout: UpdateFleetRollout) => {
    if (!rollout.targetVersion.trim()) {
      setApiError("배포 대상 버전을 입력해야 합니다.");
      return;
    }
    setIsRolloutSaving(true);
    try {
      await saveFirebaseUpdateRollout(rollout);
      setRolloutDraft(rollout);
      setIsRolloutOpen(false);
      setApiError("");
    } catch (error) {
      setApiError(error instanceof Error ? error.message : "배포 정책 저장에 실패했습니다.");
    } finally {
      setIsRolloutSaving(false);
    }
  };

  const handleSaveDeviceRollout = async (deviceId: string, ring: DeviceUpdateRing, paused: boolean) => {
    await updateFirebaseDeviceRollout(deviceId, ring, paused);
    setDevices((current) => current.map((device) => device.id === deviceId
      ? { ...device, updatePaused: paused, updateRing: ring }
      : device));
  };

  const groups = useMemo(() => groupDevicesByStore(devices), [devices]);
  const filteredDevices = useMemo(() => {
    return filterDeviceWorkspace(devices, {
      favoriteDeviceIds,
      favoriteOnly,
      query,
      selectedStore,
      status: statusFilter,
    });
  }, [devices, favoriteDeviceIds, favoriteOnly, query, selectedStore, statusFilter]);

  useEffect(() => {
    window.localStorage.setItem("wonremote-favorite-devices", serializeFavoriteDeviceIds(favoriteDeviceIds));
  }, [favoriteDeviceIds]);

  useEffect(() => {
    setSelectedDeviceIds((current) => pruneSelectedDeviceIds(current, devices));
  }, [devices]);
  const fleetSummary = useMemo(() => {
    const online = devices.filter((device) => device.status === "online").length;
    const updateAttention = devices.filter(
      (device) => ["active", "attention"].includes(resolveDeviceUpdateInfo(device).kind),
    ).length;
    return { online, offline: devices.length - online, updateAttention };
  }, [devices]);

  const session = sessions.find((item) => item.id === activeSessionId) ?? null;
  const activeDevice = session
    ? devices.find((device) => device.id === session.deviceId) ?? null
    : null;
  const isRemoteFocusMode = Boolean(session);
  const selectedDevices = devices.filter((device) => selectedDeviceIds.includes(device.id));
  const activeSplitSessionIds = splitSessionIds
    && splitSessionIds.every((sessionId) => sessions.some((item) => item.id === sessionId))
    ? splitSessionIds
    : null;

  const toggleFavoriteDevice = (deviceId: string) => {
    setFavoriteDeviceIds((current) => current.includes(deviceId)
      ? current.filter((id) => id !== deviceId)
      : [...current, deviceId]);
  };

  const toggleSelectedDevice = (deviceId: string) => {
    setSelectedDeviceIds((current) => current.includes(deviceId)
      ? current.filter((id) => id !== deviceId)
      : [...current, deviceId]);
  };

  useEffect(() => {
    if (!isAuthenticated || !isViewerFirebaseEnabled() || startupSessionCleanupAttemptedRef.current) {
      return;
    }
    startupSessionCleanupAttemptedRef.current = true;
    const storedSession = consumeActiveSessionForStartupCleanup(window.localStorage);
    if (storedSession) {
      enqueueSessionCleanup(window.localStorage, storedSession);
    }
    for (const cleanupSession of readSessionCleanupQueue(window.localStorage)) {
      void closeSession(cleanupSession.id)
        .then(() => removeSessionCleanup(window.localStorage, cleanupSession.id))
        .catch((error) => {
          console.warn("Persisted remote session cleanup will retry on next Viewer startup.", error);
        });
    }
  }, [isAuthenticated]);

  useEffect(() => {
    if (session) {
      window.localStorage.setItem(ACTIVE_SESSION_STORAGE_KEY, serializeActiveSession(session));
    } else {
      window.localStorage.removeItem(ACTIVE_SESSION_STORAGE_KEY);
    }
  }, [session]);

  useEffect(() => {
    sessions.forEach((openSession) => enqueueSessionCleanup(window.localStorage, openSession));
  }, [sessions]);

  useEffect(() => {
    if (!isAuthenticated || deviceListRefreshKey === 0) {
      return;
    }

    let cancelled = false;
    const abort = new AbortController();
    const request = fetchDevices(true, abort.signal);
    deviceListRequestRef.current = request;
    setIsRefreshingDevices(true);
    void request
      .then((nextDevices) => {
        if (!cancelled) {
          setDevices(nextDevices);
          setApiError("");
        }
      })
      .catch((error) => {
        if (!cancelled) {
          setApiError(error instanceof Error ? error.message : "장비 목록 갱신 실패");
        }
      })
      .finally(() => {
        if (deviceListRequestRef.current === request) deviceListRequestRef.current = null;
        if (!cancelled) setIsRefreshingDevices(false);
      });
    return () => {
      cancelled = true;
      abort.abort();
      if (deviceListRequestRef.current === request) deviceListRequestRef.current = null;
    };
  }, [isAuthenticated, deviceListRefreshKey]);

  useEffect(() => {
    const pendingSessions = sessions.filter((item) => item.state === "pending");
    if (pendingSessions.length === 0) {
      return;
    }

    let active = true;
    const checkStatus = async () => {
      for (const pendingSession of pendingSessions) {
        try {
          const nextState = await fetchSessionStatus(pendingSession.id);
          if (!active) return;
          if (nextState === "connected") {
            setSessions((current) => current.map((item) => item.id === pendingSession.id
              ? { ...item, state: "connected" }
              : item));
          }
        } catch {
          if (active) {
            setSessions((current) => current.filter((item) => item.id !== pendingSession.id));
            removeSessionCleanup(window.localStorage, pendingSession.id);
            setActiveSessionId((current) => current === pendingSession.id ? null : current);
          }
        }
      }
    };

    const statusIntervalId = window.setInterval(() => void checkStatus(), 1000);
    return () => {
      active = false;
      window.clearInterval(statusIntervalId);
    };
  }, [sessions]);

  async function handleLogin(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const username = String(data.get("username") ?? "");
    const password = String(data.get("password") ?? "");

    try {
      await loginAdmin(username, password);
      if (!isViewerFirebaseEnabled()) setDevices([]);
      setLoginError("");
      setApiError("");
      sessionShutdownInProgressRef.current = false;
      setIsAuthenticated(true);
    } catch (error) {
      setLoginError(error instanceof Error ? error.message : "관리자 로그인을 완료할 수 없습니다.");
    }
  }

  async function handleLogout() {
    sessionShutdownInProgressRef.current = true;
    connectionEpochRef.current += 1;
    try {
      const pendingResults = await Promise.all([...pendingConnectAttemptsRef.current]);
      if (pendingResults.some(({ cleanupSucceeded }) => !cleanupSucceeded)) {
        setApiError("취소된 원격 세션을 정리하지 못해 로그아웃을 중단했습니다.");
        sessionShutdownInProgressRef.current = false;
        return;
      }
      await Promise.all([...pendingSessionCloseTasksRef.current]);
      await Promise.all(sessions.map((openSession) => closeSession(openSession.id)));
      await logoutAdmin();
      setIsAuthenticated(false);
      setDeviceListRefreshKey(0);
      setIsRefreshingDevices(false);
      sessions.forEach((openSession) => removeSessionCleanup(window.localStorage, openSession.id));
      setSessions([]);
      setActiveSessionId(null);
      setSplitSessionIds(null);
      window.localStorage.removeItem(ACTIVE_SESSION_STORAGE_KEY);
      setDevices([]);
      setApiError("");
    } catch (error) {
      sessionShutdownInProgressRef.current = false;
      setApiError(error instanceof Error ? error.message : "로그아웃 전 세션 정리 실패");
    }
  }

  async function markInput(targetSession: RemoteSession, action: string, options: { localOnly?: boolean } = {}) {
    if (!sessions.some((item) => item.id === targetSession.id)) {
      return;
    }
    if (options.localOnly) {
      setApiError("");
      return;
    }
    try {
      await recordInput(targetSession.id, action);
      setApiError("");
    } catch (error) {
      setApiError(error instanceof Error ? error.message : "입력 이벤트 전송 실패");
    }
  }

  function handleCloseSession(targetSessionId: string, inputReleaseBarrier: Promise<unknown> = Promise.resolve()) {
    const closingSession = sessions.find((item) => item.id === targetSessionId) ?? null;
    const closedTabs = closeSessionTab(sessions, targetSessionId, activeSessionId);
    setSessions(closedTabs.sessions);
    setActiveSessionId(closedTabs.activeSessionId);
    if (splitSessionIds?.includes(targetSessionId)) {
      setSplitSessionIds(null);
    }
    setApiError("");
    if (!closingSession) {
      return;
    }
    closingDeviceIdsRef.current.add(closingSession.deviceId);
    enqueueSessionCleanup(window.localStorage, closingSession);
    const closeTask = inputReleaseBarrier
      .catch(() => undefined)
      .then(() => closeSession(closingSession.id))
      .then(() => removeSessionCleanup(window.localStorage, closingSession.id))
      .catch((error) => {
        setApiError(error instanceof Error ? error.message : "세션 종료 실패");
      })
      .finally(() => {
        closingDeviceIdsRef.current.delete(closingSession.deviceId);
        pendingSessionCloseTasksRef.current.delete(closeTask);
      });
    pendingSessionCloseTasksRef.current.add(closeTask);
  }

  async function runTrackedSessionOpen(
    deviceId: string,
    openRequest: () => Promise<{ session: RemoteSession }>,
    failureMessage: string,
  ): Promise<RemoteSession | null> {
    if (sessionShutdownInProgressRef.current) {
      return null;
    }
    if (closingDeviceIdsRef.current.has(deviceId) || pendingConnectDeviceIdsRef.current.has(deviceId)) {
      return null;
    }
    pendingConnectDeviceIdsRef.current.add(deviceId);
    const connectionEpoch = connectionEpochRef.current;
    const connectionTask = (async (): Promise<{
      cleanupSucceeded: boolean;
      connected: boolean;
      session: RemoteSession | null;
    }> => {
      let createdSessionId: string | null = null;
      try {
        const result = await openRequest();
        createdSessionId = result.session.id;
        if (
          sessionShutdownInProgressRef.current ||
          connectionEpoch !== connectionEpochRef.current
        ) {
          enqueueSessionCleanup(window.localStorage, result.session);
          await closeSession(result.session.id);
          removeSessionCleanup(window.localStorage, result.session.id);
          return { cleanupSucceeded: true, connected: false, session: null };
        }
        setSessions((current) => upsertSessionTab(current, result.session));
        setActiveSessionId(result.session.id);
        setApiError("");
        return { cleanupSucceeded: true, connected: true, session: result.session };
      } catch (error) {
        if (
          !sessionShutdownInProgressRef.current &&
          connectionEpoch === connectionEpochRef.current
        ) {
          setApiError(error instanceof Error ? error.message : failureMessage);
          return { cleanupSucceeded: true, connected: false, session: null };
        }
        if (createdSessionId) {
          setApiError(error instanceof Error ? error.message : "취소된 원격 세션 정리 실패");
          return { cleanupSucceeded: false, connected: false, session: null };
        }
        return { cleanupSucceeded: true, connected: false, session: null };
      }
    })();
    pendingConnectAttemptsRef.current.add(connectionTask);
    try {
      const result = await connectionTask;
      return result.connected ? result.session : null;
    } finally {
      pendingConnectAttemptsRef.current.delete(connectionTask);
      pendingConnectDeviceIdsRef.current.delete(deviceId);
    }
  }

  async function handleConnectDevice(device: ManagedDevice) {
    if (sessionShutdownInProgressRef.current) {
      return;
    }
    if (closingDeviceIdsRef.current.has(device.id)) {
      setApiError("이 장비의 이전 세션을 정리하고 있습니다. 잠시 후 다시 접속하세요.");
      return;
    }
    const existingSession = sessions.find((item) => item.deviceId === device.id);
    if (existingSession) {
      setSplitSessionIds(null);
      setActiveSessionId(existingSession.id);
      return;
    }
    setSplitSessionIds(null);
    await runTrackedSessionOpen(device.id, () => openSession(device.id), "세션 연결 실패");
  }

  async function handleConnectSplitView() {
    const issue = validateSameGroupSplit(selectedDevices);
    if (issue) {
      setApiError(issue === "count"
        ? "좌우 분할은 같은 그룹의 장비 2대를 선택해야 합니다."
        : "좌우 분할은 같은 매장 그룹의 장비만 사용할 수 있습니다.");
      return;
    }

    for (const device of selectedDevices) {
      if (closingDeviceIdsRef.current.has(device.id)) {
        setApiError("선택한 장비의 이전 세션을 정리하고 있습니다. 잠시 후 다시 시도하세요.");
        return;
      }
    }

    const openedSessions = await Promise.all(selectedDevices.map(async (device) => (
      sessions.find((item) => item.deviceId === device.id)
      ?? runTrackedSessionOpen(device.id, () => openSession(device.id), "분할 세션 연결 실패")
    )));
    if (!openedSessions[0] || !openedSessions[1]) {
      return;
    }
    setSplitSessionIds([openedSessions[0].id, openedSessions[1].id]);
    setSplitRatio(50);
    setActiveSessionId(openedSessions[0].id);
    setSelectedDeviceIds([]);
    setApiError("");
  }

  function handleSelectSession(targetSessionId: string) {
    if (!splitSessionIds?.includes(targetSessionId)) {
      setSplitSessionIds(null);
    }
    setActiveSessionId(targetSessionId);
  }

  function updateSplitRatio(clientX: number, divider: HTMLDivElement) {
    const grid = divider.parentElement;
    if (!grid) {
      return;
    }
    const rect = grid.getBoundingClientRect();
    const availableWidth = rect.width - divider.offsetWidth;
    if (availableWidth > 0) {
      const dividerCenter = clientX - rect.left - divider.offsetWidth / 2;
      setSplitRatio(clampSplitRatio((dividerCenter / availableWidth) * 100));
    }
  }

  function handleSplitDividerPointerDown(event: React.PointerEvent<HTMLDivElement>) {
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    updateSplitRatio(event.clientX, event.currentTarget);
  }

  function handleSplitDividerPointerMove(event: React.PointerEvent<HTMLDivElement>) {
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      updateSplitRatio(event.clientX, event.currentTarget);
    }
  }

  function handleSplitDividerPointerUp(event: React.PointerEvent<HTMLDivElement>) {
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  }

  async function handleSecureConnectRequest(device: ManagedDevice) {
    if (sessionShutdownInProgressRef.current) {
      return;
    }
    if (closingDeviceIdsRef.current.has(device.id)) {
      setApiError("이 장비의 이전 세션을 정리하고 있습니다. 잠시 후 다시 접속하세요.");
      return;
    }
    const existingSession = sessions.find((item) => item.deviceId === device.id);
    if (existingSession) {
      setActiveSessionId(existingSession.id);
      return;
    }
    const requestEpoch = connectionEpochRef.current;
    try {
      const challenge = await requestSecureSession(device.id);
      if (
        sessionShutdownInProgressRef.current ||
        requestEpoch !== connectionEpochRef.current
      ) {
        return;
      }
      setSecureConnect({
        challengeId: challenge.challengeId,
        code: "",
        device,
        expiresAt: challenge.expiresAt,
        isSubmitting: false,
      });
      setApiError("");
    } catch (error) {
      if (!sessionShutdownInProgressRef.current) {
        setApiError(error instanceof Error ? error.message : "보안접속 코드 요청 실패");
      }
    }
  }

  async function handleSecureConnectSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!secureConnect) {
      return;
    }
    setSecureConnect({ ...secureConnect, isSubmitting: true });
    const connected = await runTrackedSessionOpen(
      secureConnect.device.id,
      () => connectSecureSession({
        challengeId: secureConnect.challengeId,
        code: secureConnect.code,
        deviceId: secureConnect.device.id,
      }),
      "보안접속 실패",
    );
    if (connected) {
      setSecureConnect(null);
    } else if (!sessionShutdownInProgressRef.current) {
      setSecureConnect({ ...secureConnect, isSubmitting: false });
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
                contactName: input.contactName,
                deviceName: input.deviceName,
                installLocation: input.installLocation,
                notes: input.notes,
                storeName: input.storeName,
                tags: input.tags,
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
      const deviceSession = sessions.find((item) => item.deviceId === device.id);
      if (deviceSession) {
        await closeSession(deviceSession.id);
        removeSessionCleanup(window.localStorage, deviceSession.id);
        const closedTabs = closeSessionTab(sessions, deviceSession.id, activeSessionId);
        setSessions(closedTabs.sessions);
        setActiveSessionId(closedTabs.activeSessionId);
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

  const updateDialogOverlay = viewerUpdateDialog ? (
    <ViewerUpdateDialog
      state={viewerUpdateDialog}
      onClose={() => setViewerUpdateDialog(null)}
      onConfirm={() => void handleConfirmViewerUpdate()}
    />
  ) : null;

  if (isCheckingAutoLogin) {
    return <><AutoLoginScreen />{updateDialogOverlay}</>;
  }

  if (!isAuthenticated) {
    return <><LoginScreen error={loginError} onSubmit={handleLogin} />{updateDialogOverlay}</>;
  }

  return (
    <div className={`app-shell${isMobileViewer ? " mobile-viewer" : ""}${isRemoteFocusMode ? " remote-focus-mode" : ""}`}>
      <aside className="sidebar">
        <div className="brand-row" data-testid="viewer-brand">
          <div className="brand-mark">W</div>
          <div>
            <strong>WonRemote</strong>
            <span>Viewer 운영 콘솔</span>
          </div>
        </div>

        <button
          className={`group-button ${selectedStore === "전체" ? "active" : ""}`}
          type="button"
          onClick={() => setSelectedStore("전체")}
        >
          <LayoutDashboard size={17} />
          <span className="group-label">
            <strong>전체 장비</strong>
            <small>온라인 {fleetSummary.online}대</small>
          </span>
          <b>{devices.length}</b>
        </button>

        <section className="sidebar-section" aria-label="매장 그룹">
          <div className="sidebar-section-heading">
            <span>매장 그룹</span>
            <b>{groups.length}</b>
          </div>
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
        </section>

        <button className="logout-button" type="button" onClick={handleLogout}>
          <LogOut size={17} />
          <span>로그아웃</span>
        </button>
      </aside>

      <main className="workspace">
        <header className="topbar viewer-command-header" data-testid="viewer-command-header">
          <div className="workspace-title">
            <span className="eyebrow">DEVICE OPERATIONS</span>
            <div className="workspace-heading-line">
              <h1>{selectedStore === "전체" ? "전체 장비" : selectedStore}</h1>
              <span className="workspace-live-status">
                <i aria-hidden="true" />
                {fleetSummary.online}대 온라인
              </span>
            </div>
            <p>{devices.length}대 등록 · {groups.length}개 매장</p>
            {apiError && <p className="topbar-error">{apiError}</p>}
          </div>
          <div className="topbar-tools">
          <label className="search-box">
            <Search size={17} />
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="매장, 장비, 담당자, 위치, 태그 검색"
            />
          </label>
          {!isMobileViewer && <button
            className="viewer-update-button"
            type="button"
            onClick={() => void handleManualViewerUpdate()}
            disabled={isManualUpdateChecking}
            title="Viewer 업데이트 확인"
            aria-label="Viewer 업데이트 확인"
          >
            <RotateCcw size={16} className={isManualUpdateChecking ? "is-spinning" : undefined} />
            <span>업데이트</span>
          </button>}
          {isViewerFirebaseEnabled() && <button className="rollout-button" type="button" onClick={() => void handleOpenRollout()}>
            <SlidersHorizontal size={16} />
            <span>단계 배포</span>
          </button>}
          {canManageViewerAccounts && <button className="account-manager-button" type="button" onClick={() => setIsAccountManagerOpen(true)}>
            <Users size={16} />
            <span>계정 관리</span>
          </button>}
          </div>
        </header>

        <section
          className={`${session && activeDevice ? "content-grid" : "content-grid content-grid-dashboard"}${activeSplitSessionIds ? " content-grid-split" : ""}`}
          style={activeSplitSessionIds ? {
            "--split-left": `${splitRatio}fr`,
            "--split-right": `${100 - splitRatio}fr`,
          } as React.CSSProperties : undefined}
        >
          <section className="control-panel device-workspace" data-testid="device-workspace">
            <section className="fleet-summary" aria-label="장비 상태 요약">
              <div className="summary-item online">
                <Wifi size={18} />
                <span>온라인</span>
                <strong>{fleetSummary.online}</strong>
              </div>
              <div className="summary-item offline">
                <WifiOff size={18} />
                <span>오프라인</span>
                <strong>{fleetSummary.offline}</strong>
              </div>
              <div className="summary-item attention">
                <TriangleAlert size={18} />
                <span>업데이트 확인</span>
                <strong>{fleetSummary.updateAttention}</strong>
              </div>
            </section>
            <section className="device-filter-bar" aria-label="장비 필터와 일괄 작업">
              <div className="device-filter-segments" role="group" aria-label="장비 상태 필터">
                {([
                  ["all", "전체"],
                  ["online", "온라인"],
                  ["offline", "오프라인"],
                  ["update-attention", "업데이트 확인"],
                ] as const).map(([value, label]) => (
                  <button
                    className={statusFilter === value ? "active" : ""}
                    key={value}
                    type="button"
                    onClick={() => setStatusFilter(value)}
                  >
                    {label}
                  </button>
                ))}
              </div>
              <button
                className={`favorite-filter-button${favoriteOnly ? " active" : ""}`}
                type="button"
                aria-pressed={favoriteOnly}
                onClick={() => setFavoriteOnly((value) => !value)}
              >
                <Star size={15} fill={favoriteOnly ? "currentColor" : "none"} />
                즐겨찾기
              </button>
              {selectedDevices.length > 0 && (
                <div className="bulk-device-actions">
                  <strong>{selectedDevices.length}대 선택</strong>
                  {selectedDevices.length === 2 && (
                    <button type="button" onClick={() => void handleConnectSplitView()}>
                      <Columns2 size={14} />
                      좌우 분할 접속
                    </button>
                  )}
                  <button type="button" onClick={() => setEditTarget({ mode: "group", devices: selectedDevices })}>
                    일괄 관리
                  </button>
                  <button type="button" onClick={() => setSelectedDeviceIds([])}>선택 해제</button>
                </div>
              )}
            </section>
            <DeviceTable
              devices={filteredDevices}
              activeDeviceId={session?.deviceId ?? ""}
              onConnect={handleConnectDevice}
              onEdit={(device) => setEditTarget({ mode: "device", devices: [device] })}
              onSecureConnect={handleSecureConnectRequest}
              onWake={handleWakeDevice}
              onRefresh={handleRefreshDeviceList}
              isRefreshing={isRefreshingDevices}
              favoriteDeviceIds={favoriteDeviceIds}
              selectedDeviceIds={selectedDeviceIds}
              onToggleFavorite={toggleFavoriteDevice}
              onToggleSelected={toggleSelectedDevice}
              onDiagnostics={setDiagnosticTarget}
            />
            <ConnectionHistorySection devices={devices} />
          </section>

          {sessions.map((openSession) => {
            const splitIndex = activeSplitSessionIds?.indexOf(openSession.id) ?? -1;
            return (
              <RemoteSessionPanel
                activeSessionId={activeSessionId}
                device={devices.find((device) => device.id === openSession.deviceId) ?? null}
                isActive={openSession.id === activeSessionId}
                isSplit={splitIndex >= 0}
                isVisible={activeSplitSessionIds ? splitIndex >= 0 : openSession.id === activeSessionId}
                key={openSession.id}
                sessionId={openSession.id}
                session={openSession}
                sessions={sessions}
                sessionDevices={devices}
                splitPosition={splitIndex === 0 ? "left" : splitIndex === 1 ? "right" : null}
                onInputEvent={(action, options) => markInput(openSession, action, options)}
                onCloseSession={(barrier) => handleCloseSession(openSession.id, barrier)}
                onCloseSessionTab={(sessionId) => handleCloseSession(sessionId)}
                onSelectSession={handleSelectSession}
              />
            );
          })}
          {activeSplitSessionIds && (
            <div
              className="remote-split-divider"
              role="separator"
              tabIndex={0}
              aria-label="좌우 원격 화면 크기 조절"
              aria-orientation="vertical"
              aria-valuemin={20}
              aria-valuemax={80}
              aria-valuenow={Math.round(splitRatio)}
              onKeyDown={(event) => {
                if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
                  event.preventDefault();
                  setSplitRatio((value) => clampSplitRatio(value + (event.key === "ArrowLeft" ? -5 : 5)));
                }
              }}
              onPointerDown={handleSplitDividerPointerDown}
              onPointerMove={handleSplitDividerPointerMove}
              onPointerUp={handleSplitDividerPointerUp}
              onPointerCancel={handleSplitDividerPointerUp}
            >
              <GripVertical size={18} />
              <button
                type="button"
                title="분할 보기 종료"
                aria-label="분할 보기 종료"
                onPointerDown={(event) => event.stopPropagation()}
                onClick={() => setSplitSessionIds(null)}
              >
                <X size={14} />
              </button>
            </div>
          )}
        </section>
      </main>
      {editTarget && (
        <DeviceEditDialog
          target={editTarget}
          onClose={() => setEditTarget(null)}
          onDelete={handleDeleteDevice}
          onSaveRollout={handleSaveDeviceRollout}
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
      {updateDialogOverlay}
      {isRolloutOpen && rolloutDraft && (
        <RolloutDialog
          initial={rolloutDraft}
          isSaving={isRolloutSaving}
          onClose={() => setIsRolloutOpen(false)}
          onSave={handleSaveRollout}
        />
      )}
      {isAccountManagerOpen && <ViewerAccountManager onClose={() => setIsAccountManagerOpen(false)} />}
      {diagnosticTarget && (
        <DeviceDiagnosticsDialog device={diagnosticTarget} onClose={() => setDiagnosticTarget(null)} />
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
  onSaveRollout,
  target,
}: {
  onClose: () => void;
  onDelete: () => Promise<void>;
  onSave: (input: Omit<DeviceMetadataUpdateInput, "deviceId">) => Promise<void>;
  onSaveRollout: (deviceId: string, ring: DeviceUpdateRing, paused: boolean) => Promise<void>;
  target: DeviceEditTarget;
}) {
  useModalEscape(onClose);
  const primaryDevice = target.devices[0];
  const isGroupEdit = target.mode === "group";
  const initialDeviceType = resolveDeviceTypeEditor(primaryDevice.deviceName);
  const [form, setForm] = useState({
    businessNumber: primaryDevice.businessNumber,
    contactName: primaryDevice.contactName ?? "",
    desktopName: primaryDevice.desktopName,
    deviceName: initialDeviceType.value,
    installLocation: primaryDevice.installLocation ?? "",
    notes: primaryDevice.notes ?? "",
    storeName: primaryDevice.storeName,
    tagText: primaryDevice.tags?.join(", ") ?? "",
  });
  const [deviceTypeChoice, setDeviceTypeChoice] = useState<DeviceTypeChoice>(initialDeviceType.choice);
  const [isSaving, setIsSaving] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);
  const [isDeleteArmed, setIsDeleteArmed] = useState(false);
  const [updateRing, setUpdateRing] = useState<DeviceUpdateRing>(primaryDevice.updateRing ?? "general");
  const [updatePaused, setUpdatePaused] = useState(primaryDevice.updatePaused ?? false);

  useEffect(() => {
    const nextDeviceType = resolveDeviceTypeEditor(primaryDevice.deviceName);
    setForm({
      businessNumber: primaryDevice.businessNumber,
      contactName: primaryDevice.contactName ?? "",
      desktopName: primaryDevice.desktopName,
      deviceName: nextDeviceType.value,
      installLocation: primaryDevice.installLocation ?? "",
      notes: primaryDevice.notes ?? "",
      storeName: primaryDevice.storeName,
      tagText: primaryDevice.tags?.join(", ") ?? "",
    });
    setDeviceTypeChoice(nextDeviceType.choice);
    setIsDeleteArmed(false);
    setUpdateRing(primaryDevice.updateRing ?? "general");
    setUpdatePaused(primaryDevice.updatePaused ?? false);
  }, [primaryDevice.id]);

  async function saveCurrentForm() {
    if (isSaving) {
      return;
    }
    setIsSaving(true);
    try {
      const { tagText, ...metadata } = form;
      await onSave({
        ...metadata,
        tags: tagText.split(",").map((tag) => tag.trim()).filter(Boolean),
      });
      if (isViewerFirebaseEnabled()) {
        await Promise.all(target.devices.map((device) => onSaveRollout(device.id, updateRing, updatePaused)));
      }
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
      <form className="modal-panel" role="dialog" aria-modal="true" aria-label="등록 장비 수정" onMouseDown={(event) => event.stopPropagation()} onSubmit={handleSubmit}>
        <div className="section-heading">
          <h2>{isGroupEdit ? "장비 그룹 수정" : "등록 장비 수정"}</h2>
          <span>{isGroupEdit ? `${target.devices.length}대 적용` : primaryDevice.deviceNumber}</span>
        </div>
        <div className="form-grid">
          <label>
            가맹점 상호명
            <input
              autoFocus
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
                장비 종류
                <select
                  value={deviceTypeChoice}
                  onChange={(event) => {
                    const choice = event.target.value as DeviceTypeChoice;
                    setDeviceTypeChoice(choice);
                    setForm((prev) => ({
                      ...prev,
                      deviceName: resolveDeviceTypeValue(choice, choice === "custom" ? "" : prev.deviceName),
                    }));
                  }}
                >
                  {DEVICE_TYPE_PRESETS.map((deviceType) => (
                    <option key={deviceType} value={deviceType}>{deviceType}</option>
                  ))}
                  <option value="custom">직접입력</option>
                </select>
                {deviceTypeChoice === "custom" && (
                  <input
                    required
                    value={form.deviceName}
                    onChange={(event) => setForm((prev) => ({ ...prev, deviceName: event.target.value }))}
                    placeholder="장비 종류 직접입력"
                  />
                )}
              </label>
              <label>
                데스크탑명
                <input
                  readOnly
                  value={form.desktopName}
                  placeholder="데스크탑명"
                />
                <small className="field-help">Agent PC의 Windows 컴퓨터 이름을 자동으로 표시합니다.</small>
              </label>
              <label>
                담당자
                <input
                  maxLength={100}
                  value={form.contactName}
                  onChange={(event) => setForm((prev) => ({ ...prev, contactName: event.target.value }))}
                  placeholder="담당자 이름"
                />
              </label>
              <label>
                설치 위치
                <input
                  maxLength={255}
                  value={form.installLocation}
                  onChange={(event) => setForm((prev) => ({ ...prev, installLocation: event.target.value }))}
                  placeholder="예: 카운터 좌측 메인 POS"
                />
              </label>
              <label>
                태그
                <input
                  maxLength={400}
                  value={form.tagText}
                  onChange={(event) => setForm((prev) => ({ ...prev, tagText: event.target.value }))}
                  placeholder="예: 메인, 1층, 긴급"
                />
              </label>
              <label className="device-notes-field">
                메모 / 장애 이력
                <textarea
                  maxLength={2000}
                  value={form.notes}
                  onChange={(event) => setForm((prev) => ({ ...prev, notes: event.target.value }))}
                  placeholder="장비 특이사항이나 장애 처리 내용을 기록하세요."
                />
              </label>
            </>
          )}
          {isViewerFirebaseEnabled() && (
            <>
              <label>
                업데이트 그룹
                <select value={updateRing} onChange={(event) => setUpdateRing(event.target.value as DeviceUpdateRing)}>
                  <option value="canary">Canary</option>
                  <option value="pilot">Pilot</option>
                  <option value="general">General</option>
                </select>
              </label>
              <label className="toggle-field">
                <input type="checkbox" checked={updatePaused} onChange={(event) => setUpdatePaused(event.target.checked)} />
                {isGroupEdit ? "선택 장비 업데이트 일시 중지" : "이 장비 업데이트 일시 중지"}
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
            type="submit"
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
  useModalEscape(onCancel);
  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={onCancel}>
      <form className="modal-panel compact-modal" role="dialog" aria-modal="true" aria-label="보안 접속" onMouseDown={(event) => event.stopPropagation()} onSubmit={onSubmit}>
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

function RolloutDialog({
  initial,
  isSaving,
  onClose,
  onSave,
}: {
  initial: UpdateFleetRollout;
  isSaving: boolean;
  onClose: () => void;
  onSave: (rollout: UpdateFleetRollout) => Promise<void>;
}) {
  useModalEscape(onClose);
  const [draft, setDraft] = useState(initial);
  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={onClose}>
      <form
        className="modal-panel rollout-panel"
        role="dialog"
        aria-modal="true"
        aria-label="단계 배포 제어"
        onMouseDown={(event) => event.stopPropagation()}
        onSubmit={(event) => { event.preventDefault(); void onSave(draft); }}
      >
        <div className="section-heading">
          <div><span className="section-kicker">안전한 업데이트</span><h2>단계 배포 제어</h2></div>
          <span>{draft.paused ? "전체 중지" : "배포 활성"}</span>
        </div>
        <label>
          대상 버전
          <input autoFocus value={draft.targetVersion} onChange={(event) => setDraft({ ...draft, targetVersion: event.target.value })} placeholder="예: 0.1.64" />
        </label>
        <div className="rollout-stage" role="group" aria-label="배포 단계">
          {(["canary", "pilot", "general"] as const).map((stage) => (
            <button className={draft.stage === stage ? "active" : ""} key={stage} type="button" onClick={() => setDraft({ ...draft, stage })}>
              {stage === "canary" ? "Canary" : stage === "pilot" ? "Pilot" : "General"}
            </button>
          ))}
        </div>
        <label className="range-field">
          <span>단계 내 배포 비율 <strong>{draft.percentage ?? 100}%</strong></span>
          <input type="range" min="0" max="100" step="5" value={draft.percentage ?? 100} onChange={(event) => setDraft({ ...draft, percentage: Number(event.target.value) })} />
        </label>
        <label className="toggle-field rollout-pause">
          <input type="checkbox" checked={draft.paused === true} onChange={(event) => setDraft({ ...draft, paused: event.target.checked })} />
          전체 업데이트 일시 중지
        </label>
        <p className="modal-help">Canary부터 Pilot, General 순서로 확장됩니다. 장비별 업데이트 그룹과 중지 설정이 우선 적용됩니다.</p>
        <div className="modal-actions">
          <button className="secondary-button" type="button" onClick={onClose}>취소</button>
          <button className="primary-button compact" disabled={isSaving} type="submit">{isSaving ? "저장 중..." : "정책 저장"}</button>
        </div>
      </form>
    </div>
  );
}

function ViewerUpdateDialog({
  state,
  onClose,
  onConfirm,
  productLabel = "Viewer",
}: {
  state: ViewerUpdateDialogState;
  onClose: () => void;
  onConfirm: () => void;
  productLabel?: "Viewer" | "Agent";
}) {
  const isAvailable = state.kind === "available";
  useModalEscape(isAvailable ? () => undefined : onClose);
  const title = isAvailable ? "최신 업데이트가 있습니다" : state.kind === "current" ? "최신 버전입니다" : "업데이트 확인 실패";
  const message = isAvailable
    ? `${state.version} 버전 업데이트를 진행합니다.`
    : state.kind === "current"
      ? `현재 ${productLabel}는 ${state.version} 버전입니다.`
      : state.message;

  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={isAvailable ? undefined : onClose}>
      <section className="modal-panel compact-modal" role="dialog" aria-modal="true" aria-labelledby="viewer-update-title" onMouseDown={(event) => event.stopPropagation()}>
        <div className="section-heading">
          <h2 id="viewer-update-title">{title}</h2>
        </div>
        <p className="modal-help">{message}</p>
        <div className="modal-actions">
          {isAvailable ? (
            <button className="primary-button compact" type="button" onClick={onConfirm}>
              확인
            </button>
          ) : (
            <button className="secondary-button" type="button" onClick={onClose}>
              닫기
            </button>
          )}
        </div>
      </section>
    </div>
  );
}

function ConnectionHistorySection({ devices }: { devices: ManagedDevice[] }) {
  const [history, setHistory] = useState<ConnectionHistoryEntry[]>([]);
  const [statusFilter, setStatusFilter] = useState<"all" | ConnectionHistoryEntry["status"]>("all");
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);
  const [historyError, setHistoryError] = useState("");
  const devicesRef = useRef(devices);
  devicesRef.current = devices;

  const loadHistory = async () => {
    if (!isRefreshing) setRefreshKey((key) => key + 1);
  };

  useEffect(() => {
    if (refreshKey === 0) return;
    let active = true;
    setIsRefreshing(true);
    setHistoryError("");
    void fetchConnectionHistory(devicesRef.current)
      .then((entries) => { if (active) setHistory(entries); })
      .catch((error) => { if (active) setHistoryError(error instanceof Error ? error.message : String(error)); })
      .finally(() => { if (active) setIsRefreshing(false); });
    return () => { active = false; };
  }, [refreshKey]);

  const filteredHistory = history
    .filter((entry) => statusFilter === "all" || entry.status === statusFilter)
    .map((entry) => {
      const device = devices.find((item) => item.id === entry.deviceId);
      return device ? { ...entry, storeName: device.storeName, deviceName: device.deviceName } : entry;
    });

  return (
    <section className="device-section" style={{ marginTop: "24px" }}>
      <div className="section-heading">
        <div>
          <span className="section-kicker">감사 기록</span>
          <h2>과거 연결 이력</h2>
        </div>
        <div className="section-heading-actions">
          <select
            aria-label="연결 이력 상태 필터"
            value={statusFilter}
            onChange={(event) => setStatusFilter(event.target.value as typeof statusFilter)}
          >
            <option value="all">전체</option>
            <option value="success">연결됨</option>
            <option value="closed">종료됨</option>
            <option value="rejected">거부됨</option>
          </select>
          <span>{filteredHistory.length}건</span>
          <button
            className="section-refresh-button"
            type="button"
            disabled={isRefreshing}
            title="연결 이력 새로고침"
            aria-label="연결 이력 새로고침"
            onClick={() => void loadHistory()}
          >
            <RotateCcw size={15} className={isRefreshing ? "is-spinning" : undefined} />
          </button>
        </div>
      </div>
      <div className="device-table" style={{ maxHeight: "250px", overflowY: "auto" }}>
        {historyError && <p role="status">연결 이력을 불러오지 못했습니다: {historyError}</p>}
        <div className="table-row table-head" style={{ gridTemplateColumns: "1.2fr 2fr 2fr 3fr 1.5fr" }}>
          <span>상태</span>
          <span>정보</span>
          <span>에이전트 식별코드</span>
          <span>시작 시각</span>
          <span>소요시간</span>
        </div>
        {filteredHistory.map((entry) => {
          const start = new Date(entry.startedAt);
          const end = entry.endedAt ? new Date(entry.endedAt) : null;
          const [businessNumber, agentIdentifier] = entry.deviceId.split(":");
          const duration = end ? `${Math.round((end.getTime() - start.getTime()) / 1000)}초` : "-";
          
          let statusColor = "#10b981";
          if (entry.status === "rejected") statusColor = "#ef4444";
          if (entry.status === "closed") statusColor = "#64748b";
          const statusLabel = entry.status === "success" ? "연결됨" : entry.status === "closed" ? "종료됨" : "거부됨";

          return (
            <div className="table-row" key={entry.id} style={{ gridTemplateColumns: "1.2fr 2fr 2fr 3fr 1.5fr" }}>
              <span className="status-pill" style={{ background: statusColor + "20", color: statusColor }}>
                {statusLabel}
              </span>
              <span className="store-cell">
                <b>{entry.storeName}</b>
                <small>{businessNumber}</small>
              </span>
              <span><b>{agentIdentifier || entry.deviceName}</b></span>
              <span style={{ fontSize: "11px" }}>{start.toLocaleString()}</span>
              <span>{duration}</span>
            </div>
          );
        })}
        {filteredHistory.length === 0 && <div className="empty-row">{refreshKey === 0 ? "조회 전" : "조건에 맞는 연결 이력이 없습니다."}</div>}
      </div>
    </section>
  );
}

function AgentRestartDialog({
  isRestarting,
  onCancel,
  onConfirm,
}: {
  isRestarting: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  useModalEscape(isRestarting ? () => undefined : onCancel);

  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={isRestarting ? undefined : onCancel}>
      <section
        className="modal-panel compact-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="agent-restart-title"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="section-heading">
          <h2 id="agent-restart-title">에이전트를 재시작할까요?</h2>
        </div>
        <p className="modal-help">재시작하는 동안 원격 연결이 잠시 중단됩니다.</p>
        <div className="modal-actions">
          <button className="secondary-button" type="button" disabled={isRestarting} onClick={onCancel}>
            취소
          </button>
          <button className="primary-button compact" type="button" disabled={isRestarting} onClick={onConfirm}>
            {isRestarting ? "재시작 중..." : "재시작"}
          </button>
        </div>
      </section>
    </div>
  );
}

function AgentFirstRunApp() {
  const firebaseMode = isViewerFirebaseEnabled();
  const agentVersion = getViewerVersion(import.meta.env);
  const [businessNumber, setBusinessNumber] = useState("");
  const [password, setPassword] = useState("");
  const [apiUrl, setApiUrl] = useState("http://127.0.0.1:8787");
  const [installId, setInstallId] = useState(getOrCreateAgentInstallId);
  const [desktopName, setDesktopName] = useState("");
  const [isInstallIdentityReady, setIsInstallIdentityReady] = useState(
    () => !(window as any).__TAURI_INTERNALS__,
  );
  const [registeredDevice, setRegisteredDevice] = useState<ManagedDevice | null>(null);
  const [registeredConfig, setRegisteredConfig] = useState<any | null>(null);
  const [error, setError] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isRestartDialogOpen, setIsRestartDialogOpen] = useState(false);
  const [isRestarting, setIsRestarting] = useState(false);
  const [isAgentUpdateChecking, setIsAgentUpdateChecking] = useState(false);
  const [agentUpdateDialog, setAgentUpdateDialog] = useState<ViewerUpdateDialogState | null>(null);

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
        const [persistentInstallId, detectedDesktopName] = await Promise.all([
          invoke<string>("get_or_create_agent_install_id", { legacyInstallId: installId }),
          invoke<string>("get_computer_name").catch(() => ""),
        ]);
        if (cancelled) {
          return;
        }
        setInstallId(persistentInstallId);
        setDesktopName(detectedDesktopName);
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
        desktopName: desktopName || undefined,
        protocolVersion: CURRENT_REMOTE_PROTOCOL_VERSION,
        version: agentVersion,
        apiUrl: firebaseMode ? undefined : apiUrl,
      });
      setRegisteredDevice(result.device);
      setError("");

      const configData = {
        businessNumber: result.device.businessNumber,
        installId,
        registeredDeviceId: result.device.id,
        version: agentVersion,
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

  async function handleRestartAgent() {
    if (isRestarting) return;
    setIsRestarting(true);
    try {
      if ((window as any).__TAURI_INTERNALS__) {
        await invoke("restart_agent_process");
      }
      setIsRestartDialogOpen(false);
    } catch (restartError) {
      setError(restartError instanceof Error ? restartError.message : "에이전트 재시작에 실패했습니다.");
      setIsRestartDialogOpen(false);
    } finally {
      setIsRestarting(false);
    }
  }

  async function handleAgentUpdateCheck() {
    if (isAgentUpdateChecking) return;
    setIsAgentUpdateChecking(true);
    try {
      const update = await invoke<{ available: boolean; latestVersion: string }>("check_agent_installer_update");
      setAgentUpdateDialog(update.available
        ? { kind: "available", version: update.latestVersion }
        : { kind: "current", version: update.latestVersion });
    } catch (updateError) {
      setAgentUpdateDialog({
        kind: "error",
        message: updateError instanceof Error ? updateError.message : "업데이트 서버를 확인할 수 없습니다.",
      });
    } finally {
      setIsAgentUpdateChecking(false);
    }
  }

  async function handleConfirmAgentUpdate() {
    setAgentUpdateDialog(null);
    try {
      await invoke("start_installer_update", { restartMode: "agent" });
    } catch (updateError) {
      setAgentUpdateDialog({
        kind: "error",
        message: updateError instanceof Error ? updateError.message : "업데이트를 시작할 수 없습니다.",
      });
    }
  }

  if (registeredConfig) {
    return (
      <>
        <main className="login-screen agent-screen">
          <div className="login-panel agent-panel active-agent-panel">
            <div className="login-badge active-agent-badge">
              <Monitor size={20} />
              <span>Active Agent · v{agentVersion}</span>
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
            <div className="agent-action-row">
              <button className="secondary-button" type="button" disabled={isAgentUpdateChecking} onClick={() => void handleAgentUpdateCheck()}>
                <RotateCcw size={16} className={isAgentUpdateChecking ? "is-spinning" : undefined} />
                <span>{isAgentUpdateChecking ? "확인 중..." : "업데이트 확인"}</span>
              </button>
              <button className="primary-button" type="button" onClick={() => setIsRestartDialogOpen(true)}>
                <span>에이전트 재시작</span>
              </button>
            </div>
          </div>
        </main>
        {isRestartDialogOpen && (
          <AgentRestartDialog
            isRestarting={isRestarting}
            onCancel={() => setIsRestartDialogOpen(false)}
            onConfirm={() => void handleRestartAgent()}
          />
        )}
        {agentUpdateDialog && (
          <ViewerUpdateDialog
            state={agentUpdateDialog}
            productLabel="Agent"
            onClose={() => setAgentUpdateDialog(null)}
            onConfirm={() => void handleConfirmAgentUpdate()}
          />
        )}
      </>
    );
  }

  return (
    <main className="login-screen agent-screen">
      <form className={`login-panel agent-panel ${firebaseMode ? "firebase-agent-panel" : ""}`} onSubmit={handleFirstRun}>
        <div className="login-badge">
          <Monitor size={20} />
          <span>Agent · v{agentVersion}</span>
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
  const [username, setUsername] = useState("");
  const [recoveryMessage, setRecoveryMessage] = useState("");
  const [isResettingPassword, setIsResettingPassword] = useState(false);

  const handlePasswordReset = async () => {
    setIsResettingPassword(true);
    try {
      await requestViewerPasswordReset(username);
      setRecoveryMessage("비밀번호 재설정 메일을 보냈습니다. 메일함을 확인해 주세요.");
    } catch (cause) {
      setRecoveryMessage(cause instanceof Error ? cause.message : "재설정 메일을 보내지 못했습니다.");
    } finally {
      setIsResettingPassword(false);
    }
  };

  return (
    <main className="login-screen">
      <form className="login-panel" onSubmit={onSubmit}>
        <div className="login-badge">
          <ShieldCheck size={20} />
          <span>Viewer</span>
        </div>
        <h1>Viewer 관리자 로그인</h1>
        <label>
          아이디 <input autoComplete="username" name="username" type="text" value={username} onChange={(event) => setUsername(event.target.value)} />
        </label>
        <label>
          비밀번호
          <input autoComplete="current-password" name="password" type="password" />
        </label>
        {error && <p className="error-text">{error}</p>}
        {recoveryMessage && <p className="login-recovery-message" role="status">{recoveryMessage}</p>}
        <button className="primary-button" type="submit">
          <LogIn size={17} />
          <span>로그인</span>
        </button>
        <div className="login-recovery-actions">
          <button type="button" onClick={() => setRecoveryMessage("Viewer 아이디는 가입할 때 등록한 이메일 주소입니다.")}>아이디 찾기</button>
          <button type="button" disabled={isResettingPassword} onClick={() => void handlePasswordReset()}>
            {isResettingPassword ? "메일 발송 중" : "비밀번호 재설정"}
          </button>
        </div>
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
        <h1>자동 로그인</h1>
        <p>저장된 Viewer 세션을 확인하고 있습니다.</p>
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

function DeviceTable({
  activeDeviceId,
  devices,
  favoriteDeviceIds,
  onConnect,
  onDiagnostics,
  onEdit,
  onSecureConnect,
  onToggleFavorite,
  onToggleSelected,
  onWake,
  onRefresh,
  isRefreshing,
  selectedDeviceIds,
}: {
  activeDeviceId: string;
  devices: ManagedDevice[];
  favoriteDeviceIds: string[];
  onConnect: (device: ManagedDevice) => void | Promise<void>;
  onDiagnostics: (device: ManagedDevice) => void;
  onEdit: (device: ManagedDevice) => void;
  onSecureConnect: (device: ManagedDevice) => void | Promise<void>;
  onToggleFavorite: (deviceId: string) => void;
  onToggleSelected: (deviceId: string) => void;
  onWake: (device: ManagedDevice) => void | Promise<void>;
  onRefresh: () => void | Promise<void>;
  isRefreshing: boolean;
  selectedDeviceIds: string[];
}) {
  const allSelected = devices.length > 0 && devices.every((device) => selectedDeviceIds.includes(device.id));

  const toggleAllVisibleDevices = () => {
    devices.forEach((device) => {
      if (allSelected === selectedDeviceIds.includes(device.id)) {
        onToggleSelected(device.id);
      }
    });
  };

  return (
    <section className="device-section">
      <div className="section-heading">
        <div>
          <span className="section-kicker">기기 인벤토리</span>
          <h2>등록 장비</h2>
        </div>
        <div className="section-heading-actions">
          <span><strong>{devices.length}</strong>대 표시</span>
          <button
            className="section-refresh-button"
            type="button"
            onClick={() => void onRefresh()}
            disabled={isRefreshing}
            title="장비 목록 새로고침"
            aria-label="장비 목록 새로고침"
          >
            <RotateCcw size={15} className={isRefreshing ? "is-spinning" : undefined} />
          </button>
        </div>
      </div>
      <div className="device-table">
        <div className="table-row table-head">
          <span className="device-status-heading">
            <input
              checked={allSelected}
              type="checkbox"
              aria-label="표시된 장비 전체 선택"
              onChange={toggleAllVisibleDevices}
            />
            상태
          </span>
          <span>매장</span>
          <span>장비</span>
          <span>소프트웨어</span>
          <span>시스템</span>
          <span>작업</span>
        </div>
        {devices.map((device) => {
          const isOnline = device.status === "online";
          const updateInfo = resolveDeviceUpdateInfo(device);
          const systemSummary = formatDeviceSystemInfo(device.systemInfo);
          return (
            <div
              className="table-row"
              key={device.id}
              onContextMenu={(event) => {
                event.preventDefault();
                onEdit(device);
              }}
              onDoubleClick={() => {
                void onConnect(device);
              }}
              title="접속 시 최신 상태를 확인합니다."
            >
              <span className="device-status-cell">
                <input
                  checked={selectedDeviceIds.includes(device.id)}
                  type="checkbox"
                  aria-label={`${device.desktopName} 선택`}
                  onChange={() => onToggleSelected(device.id)}
                />
                <span className={`status-pill ${isOnline ? "online" : "offline"}`} title="마지막 조회 시 상태">
                  {isOnline ? <Wifi size={14} /> : <WifiOff size={14} />}
                  {isOnline ? "온라인" : "오프라인"}
                </span>
              </span>
              <span className="store-cell">
                <span className="store-name-line">
                  <button
                    className={`favorite-device-button${favoriteDeviceIds.includes(device.id) ? " active" : ""}`}
                    type="button"
                    title="즐겨찾기"
                    aria-label={`${device.desktopName} 즐겨찾기`}
                    aria-pressed={favoriteDeviceIds.includes(device.id)}
                    onClick={() => onToggleFavorite(device.id)}
                  >
                    <Star size={14} fill={favoriteDeviceIds.includes(device.id) ? "currentColor" : "none"} />
                  </button>
                  <b>{device.storeName}</b>
                </span>
                <small>{device.businessNumber}</small>
                {(device.contactName || device.installLocation) && (
                  <small className="device-operations-summary">
                    {[device.contactName, device.installLocation].filter(Boolean).join(" · ")}
                  </small>
                )}
              </span>
              <span className="device-identity-cell">
                <b>{device.desktopName}</b>
                <small>{device.deviceName} · {device.deviceNumber}</small>
                {device.tags && device.tags.length > 0 && (
                  <span className="device-tag-list">
                    {device.tags.slice(0, 3).map((tag) => <i key={tag}>{tag}</i>)}
                  </span>
                )}
              </span>
              <span className="software-cell">
                <span className={`version-badge ${updateInfo.kind}`}>{updateInfo.label}</span>
                {device.controlDiagnostics && (
                  <small>{device.controlDiagnostics.elevated ? "관리자 권한" : "사용자 권한"}</small>
                )}
              </span>
              <span className="device-system-cell" title={systemSummary}>{systemSummary}</span>
              <span className="device-actions">
                <button
                  className={activeDeviceId === device.id ? "connect-button connect-icon active" : "connect-button connect-icon"}
                  type="button"
                  title="접속"
                  aria-label="접속"
                  onClick={() => onConnect(device)}
                >
                  <PlugZap size={16} />
                </button>
                <button
                  className="connect-button connect-icon secure"
                  type="button"
                  title="보안접속"
                  aria-label="보안접속"
                  onClick={() => onSecureConnect(device)}
                >
                  <ShieldCheck size={16} />
                </button>
                <button
                  className="connect-button connect-icon edit"
                  type="button"
                  title="장비 정보 수정"
                  aria-label="장비 정보 수정"
                  onClick={() => onEdit(device)}
                >
                  <Pencil size={15} />
                </button>
                <button
                  className="connect-button connect-icon diagnostics"
                  type="button"
                  title="장비 진단"
                  aria-label="장비 진단"
                  onClick={() => onDiagnostics(device)}
                >
                  <Activity size={15} />
                </button>
                <button
                  className="connect-button connect-icon wake"
                  disabled={isOnline || !device.macAddresses?.length}
                  type="button"
                  title={
                    device.macAddresses?.length
                      ? "Wake-on-LAN"
                      : "Agent heartbeat에 MAC 주소가 아직 없습니다"
                  }
                  aria-label="Wake-on-LAN"
                  onClick={() => onWake(device)}
                >
                  <Power size={16} />
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

function DeviceDiagnosticsDialog({ device, onClose }: { device: ManagedDevice; onClose: () => void }) {
  useModalEscape(onClose);
  const protocol = evaluateRemoteProtocolCompatibility(device.protocolVersion);
  const updateInfo = resolveDeviceUpdateInfo(device);
  const streamLines = formatStreamDiagnostics(device.streamDiagnostics, "device-heartbeat", 0, 0);
  const controlLines = formatControlDiagnostics(device.controlDiagnostics);

  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={onClose}>
      <section
        className="modal-panel diagnostics-panel"
        role="dialog"
        aria-modal="true"
        aria-labelledby="device-diagnostics-title"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="section-heading">
          <div>
            <span className="section-kicker">장비 상태</span>
            <h2 id="device-diagnostics-title">{device.desktopName}</h2>
          </div>
          <span className={`status-pill ${device.status}`}>{device.status === "online" ? "온라인" : "오프라인"}</span>
        </div>
        <div className="diagnostics-summary-grid">
          <div><small>장비 ID</small><strong>{device.id}</strong></div>
          <div><small>마지막 응답</small><strong>{new Date(device.lastSeenAt).toLocaleString()}</strong></div>
          <div><small>Agent 버전</small><strong>{device.version ? `v${device.version}` : "미확인"}</strong></div>
          <div>
            <small>원격 프로토콜</small>
            <strong className={protocol.compatible ? "diagnostic-ok" : "diagnostic-error"}>
              v{protocol.effectiveVersion} · {protocol.compatible ? "호환" : "업데이트 필요"}
            </strong>
          </div>
          <div><small>업데이트</small><strong>{updateInfo.label}</strong></div>
          <div><small>배포 그룹</small><strong>{device.updateRing ?? "general"}{device.updatePaused ? " · 중지" : ""}</strong></div>
        </div>
        {device.updateError && <p className="diagnostic-error-message">{device.updateError}</p>}
        <div className="diagnostics-columns">
          <section>
            <h3>화면 전송</h3>
            {streamLines.map((line) => <code key={line}>{line}</code>)}
          </section>
          <section>
            <h3>입력 제어</h3>
            {controlLines.map((line) => <code key={line}>{line}</code>)}
          </section>
        </div>
        {!protocol.compatible && <p className="diagnostic-error-message">{remoteProtocolErrorMessage(protocol)}</p>}
        <div className="modal-actions">
          <button className="secondary-button" type="button" onClick={onClose}>닫기</button>
        </div>
      </section>
    </div>
  );
}

const DANGEROUS_SYSTEM_COMMANDS = new Set(["logoff", "restart", "shutdown"]);

function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) {
    return false;
  }
  if (target.closest("[data-remote-ime-input='true']")) {
    return false;
  }
  return Boolean(target.closest(
    "button, input, select, summary, textarea, a[href], [contenteditable='true'], [role='button']",
  ));
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
  activeSessionId,
  device,
  isActive,
  isSplit,
  isVisible,
  sessionId,
  session,
  sessions,
  sessionDevices,
  splitPosition,
  onCloseSessionTab,
  onInputEvent: sendInputEvent,
  onCloseSession,
  onSelectSession,
}: {
  activeSessionId: string | null;
  device: ManagedDevice | null;
  isActive: boolean;
  isSplit: boolean;
  isVisible: boolean;
  sessionId: string;
  session: RemoteSession | null;
  sessions: RemoteSession[];
  sessionDevices: ManagedDevice[];
  splitPosition: "left" | "right" | null;
  onCloseSessionTab: (sessionId: string) => void;
  onInputEvent: (action: string, options?: { localOnly?: boolean }) => void | Promise<void>;
  onCloseSession: (inputReleaseBarrier?: Promise<unknown>) => void;
  onSelectSession: (sessionId: string) => void;
}) {
  const preferenceDeviceId = device?.id ?? session?.deviceId ?? "";
  const storedViewPreferences = React.useRef(
    preferenceDeviceId
      ? window.localStorage.getItem(deviceViewPreferencesKey(preferenceDeviceId))
      : null,
  ).current;
  const initialViewPreferences = React.useRef(parseDeviceViewPreferences(storedViewPreferences)).current;
  const panelRef = React.useRef<HTMLElement | null>(null);
  const imeInputRef = React.useRef<HTMLTextAreaElement | null>(null);
  const imeComposingRef = React.useRef(false);
  const imeCompositionValueRef = React.useRef("");
  const suppressNextImeValueRef = React.useRef("");
  const remotePreviewRef = React.useRef<HTMLDivElement | null>(null);
  const canvasRef = React.useRef<HTMLCanvasElement | null>(null);
  const pressedKeysRef = React.useRef<Map<string, string>>(new Map());
  const suppressedKeyUpsRef = React.useRef<Set<string>>(new Set());
  const pressedButtonsRef = React.useRef<Set<MouseButtonCode>>(new Set());
  const activePointerIdRef = React.useRef<number | null>(null);
  const moveFrameRef = React.useRef<number | null>(null);
  const moveDelayTimerRef = React.useRef<number | null>(null);
  const lastMoveSentAtRef = React.useRef(0);
  const pendingMoveRef = React.useRef<{ dx: number; dy: number } | null>(null);
  const lastPointerPointRef = React.useRef({ dx: 32768, dy: 32768 });
  const lastClipboardTextRef = React.useRef<string>("");
  const lastClipboardImageHashRef = React.useRef<string>("");
  const pingStateRef = React.useRef<{ start: number } | null>(null);
  const activeTransferIdRef = React.useRef<string>("");
  const storageTransfersRef = React.useRef(
    parseStorageTransferCleanup(window.localStorage.getItem(STORAGE_TRANSFER_CLEANUP_KEY)),
  );
  const [receiptIds, setReceiptIds] = useState<string[]>(() => [...storageTransfersRef.current]
    .filter(([, transfer]) => !transfer.received && transfer.path.startsWith(`sessions/${sessionId}/`))
    .map(([id]) => id));
  const [sessionDataError, setSessionDataError] = useState("");
  const [sessionDataRetry, setSessionDataRetry] = useState(0);
  const sessionDataHandlerRef = useRef<(data: SessionData, isCurrent: () => boolean) => Promise<void>>(async () => {});
  const clipboardRequestRef = useRef<((text: string) => void) | null>(null);
  const tileSequenceRef = React.useRef<Map<string, number>>(new Map());
  const receivedFrameSequenceRef = React.useRef(0);
  const webRtcTransportRef = React.useRef<ViewerWebRtcTransport | null>(null);
  const lastDisplayCommandRef = React.useRef<number | null>(null);
  const activeSessionIdRef = React.useRef(activeSessionId);
  React.useEffect(() => {
    activeSessionIdRef.current = activeSessionId;
  }, [activeSessionId]);
  const onInputEvent = React.useCallback((action: string) => {
    const transport = webRtcTransportRef.current;
    const sentOverWebRtc = transport?.isControlReady() === true
      ? transport.sendControl(action)
      : false;
    return sendInputEvent(action, {
      localOnly: sentOverWebRtc || !shouldUseReliableInputFallback(action),
    });
  }, [sendInputEvent]);
  const dangerConfirmUntilRef = React.useRef<Record<string, number>>({});
  const [latencyReport, setLatencyReport] = useState<string>("");
  const [pingState, setPingState] = useState<{ start: number } | null>(null);
  const [zoom, setZoom] = useState(initialViewPreferences.zoom);
  const [isSessionFullscreen, setIsSessionFullscreen] = useState(initialViewPreferences.fullscreen);
  const [isFullscreenToolbarOpen, setIsFullscreenToolbarOpen] = useState(false);
  const [isWebRtcConnectionReady, setIsWebRtcConnectionReady] = useState(false);
  const [webRtcReconnectGeneration, setWebRtcReconnectGeneration] = useState(0);
  const [needsManualReconnect, setNeedsManualReconnect] = useState(false);
  const [rebootReconnectState, setRebootReconnectState] = useState<"idle" | "restarting" | "reconnecting">("idle");
  const rebootReconnectStateRef = React.useRef(rebootReconnectState);
  React.useEffect(() => {
    rebootReconnectStateRef.current = rebootReconnectState;
  }, [rebootReconnectState]);
  const [streamPerformanceMode, setStreamPerformanceMode] = useState<StreamPerformanceMode>(() =>
    normalizeStreamPerformanceMode(window.localStorage.getItem("wonremote-stream-performance-mode")),
  );
  const [selectedDisplayIndex, setSelectedDisplayIndex] = useState(initialViewPreferences.selectedDisplayIndex);
  const [transferProgress, setTransferProgress] = useState<{
    fileName: string;
    progress: number;
    speed: string;
    timeLeft: string;
  } | null>(null);
  const [transferQueue, setTransferQueue] = useState<FileTransferQueueItem[]>([]);
  const transferFilesRef = React.useRef<Map<string, File>>(new Map());
  const transferAbortControllersRef = React.useRef<Map<string, AbortController>>(new Map());
  const cancelledTransferIdsRef = React.useRef<Set<string>>(new Set());

  // Phase 3 states
  const mediaRecorderRef = React.useRef<MediaRecorder | null>(null);
  const recordedChunksRef = React.useRef<Blob[]>([]);
  const [isRecording, setIsRecording] = useState(false);
  const [chatMessages, setChatMessages] = useState<ChatMessage[]>([]);
  const [chatInput, setChatInput] = useState("");
  const [isClipboardSyncOn, setIsClipboardSyncOn] = useState(initialViewPreferences.clipboardSync);
  const [isChatOpen, setIsChatOpen] = useState(false);

  useEffect(() => {
    setIsFullscreenToolbarOpen(false);
    setIsWebRtcConnectionReady(false);
    lastDisplayCommandRef.current = null;
    if (initialViewPreferences.fullscreen) {
      void applySessionFullscreen(true);
    }
  }, [sessionId]);

  useEffect(() => {
    if (!preferenceDeviceId) return;
    window.localStorage.setItem(deviceViewPreferencesKey(preferenceDeviceId), JSON.stringify({
      clipboardSync: isClipboardSyncOn,
      fullscreen: isSessionFullscreen,
      selectedDisplayIndex,
      zoom,
    }));
  }, [isClipboardSyncOn, isSessionFullscreen, preferenceDeviceId, selectedDisplayIndex, zoom]);

  useEffect(() => {
    if ((window as any).__TAURI_INTERNALS__) return;

    const syncBrowserFullscreen = () => {
      if (!document.fullscreenElement) setIsSessionFullscreen(false);
    };
    document.addEventListener("fullscreenchange", syncBrowserFullscreen);
    return () => document.removeEventListener("fullscreenchange", syncBrowserFullscreen);
  }, []);

  async function applySessionFullscreen(nextFullscreen: boolean) {
    setIsSessionFullscreen(nextFullscreen);
    setIsFullscreenToolbarOpen(false);

    try {
      if ((window as any).__TAURI_INTERNALS__) {
        await getCurrentWindow().setFullscreen(nextFullscreen);
        return;
      }

      if (!nextFullscreen && document.fullscreenElement) {
        await document.exitFullscreen();
      } else if (nextFullscreen && !document.fullscreenElement) {
        await panelRef.current?.requestFullscreen();
      }
    } catch {
      // The fixed immersive layout remains usable when native fullscreen is unavailable.
    }
  }

  useEffect(() => {
    if (isSplit && isSessionFullscreen) {
      void applySessionFullscreen(false);
    }
  }, [isSessionFullscreen, isSplit]);

  async function toggleSessionFullscreen() {
    await applySessionFullscreen(!isSessionFullscreen);
  }

  function leaveRemoteSession() {
    const inputReleaseBarrier = releaseAllInputs();
    onCloseSession(inputReleaseBarrier);
    setIsFullscreenToolbarOpen(false);
    if ((window as any).__TAURI_INTERNALS__) {
      void getCurrentWindow().setFullscreen(false).catch(() => {});
    } else if (document.fullscreenElement) {
      void document.exitFullscreen().catch(() => {});
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

  useEffect(() => () => {
    transferAbortControllersRef.current.forEach((controller) => controller.abort());
    transferAbortControllersRef.current.clear();
  }, [sessionId]);

  useEffect(() => {
    if (!device?.displays?.length) {
      if (!storedViewPreferences) setSelectedDisplayIndex(device?.activeDisplayIndex ?? 0);
      return;
    }
    if (!storedViewPreferences) {
      const activeDisplay =
        device.displays.find((display) => display.index === device.activeDisplayIndex) ??
        device.displays.find((display) => display.primary) ??
        device.displays[0];
      setSelectedDisplayIndex(activeDisplay.index);
      return;
    }
    if (device.displays.some((display) => display.index === selectedDisplayIndex)) {
      return;
    }
    const activeDisplay =
      device.displays.find((display) => display.index === device.activeDisplayIndex) ??
      device.displays.find((display) => display.primary) ??
      device.displays[0];
    setSelectedDisplayIndex(activeDisplay.index);
  }, [device?.activeDisplayIndex, device?.displays, selectedDisplayIndex, storedViewPreferences]);

  useEffect(() => {
    if (!isWebRtcConnectionReady || lastDisplayCommandRef.current === selectedDisplayIndex) {
      return;
    }
    lastDisplayCommandRef.current = selectedDisplayIndex;
    onInputEvent(buildSwitchMonitorCommand(selectedDisplayIndex));
  }, [isWebRtcConnectionReady, onInputEvent, selectedDisplayIndex]);

  useEffect(() => {
    if (isActive && session?.state === "connected") {
      panelRef.current?.focus({ preventScroll: true });
    }
  }, [isActive, session?.id, session?.state]);

  useEffect(() => {
    if (!sessionId || session?.state !== "connected") {
      return;
    }
    if (isViewerFirebaseEnabled() && !isWebRtcConnectionReady) {
      return;
    }
    void onInputEvent(buildSetStreamModeCommand(streamPerformanceMode));
  }, [isWebRtcConnectionReady, sessionId, session?.state, streamPerformanceMode]);

  useEffect(() => {
    pingStateRef.current = pingState;
  }, [pingState]);

  sessionDataHandlerRef.current = async (data, isCurrent) => {
        if (!isCurrent()) return;
        const chats = data.messages;
        if (chats.length > 0) {
          const processed = chats.map((c) => {
            if (c.message === "__AUDIO_BEEP_SIGNAL__") {
              playBeepSound();
            }
            return c;
          });
          setChatMessages((prev) => [...prev, ...processed]);
        }

        // 2. Clipboard
        const clips = data.clipboards;
        if (clips.length > 0) {
          for (const clip of clips) {
            if (!isCurrent()) return;
            if (clip.sender === "agent") {
              clipboardRequestRef.current?.(clip.text);
              if (isActive && isClipboardSyncOn) {
                await navigator.clipboard.writeText(clip.text).catch(() => {});
              }
            }
          }
        }

        // 3. Files
        const files = data.files;
        if (files.length > 0) {
          for (const file of files) {
            if (!isCurrent()) return;
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

        if (!isCurrent()) return;
        const receipts = data.receipts;
        for (const completedReceipt of receipts) {
          if (completedReceipt.status !== "received") continue;
          const transfer = storageTransfersRef.current.get(completedReceipt.transferId);
          if (!transfer) continue;
          storageTransfersRef.current.set(completedReceipt.transferId, { ...transfer, received: true });
        }
        if (receipts.length) window.localStorage.setItem(STORAGE_TRANSFER_CLEANUP_KEY, serializeStorageTransferCleanup(storageTransfersRef.current));
        for (const { transferId } of receipts) {
          if (!isCurrent()) return;
          const transfer = storageTransfersRef.current.get(transferId);
          if (!transfer) continue;
          if (!transfer.received) continue;
          try {
            await deleteUploadedFileFromStorage(transfer.path);
            storageTransfersRef.current.delete(transferId);
            window.localStorage.setItem(
              STORAGE_TRANSFER_CLEANUP_KEY,
              serializeStorageTransferCleanup(storageTransfersRef.current),
            );
          } catch (error) {
            setSessionDataError("전송 원본 정리 실패. 재시도해 주세요.");
          }
        }
        if (!isCurrent()) return;
        for (const receipt of receipts) {
          if (receipt.status !== "partial") setReceiptIds((ids) => ids.filter((id) => id !== receipt.transferId));
        }
        if (activeTransferIdRef.current && receipts.length > 0) {
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
  };

  useEffect(() => {
    if (!sessionId || session?.state !== "connected") return;
    let active = true;
    const unsubscribe = subscribeSessionData(sessionId,
      (data) => sessionDataHandlerRef.current(data, () => active),
      (error) => { if (active) setSessionDataError(error.message); },
      { clipboard: isActive && isClipboardSyncOn });
    return () => {
      active = false;
      clipboardRequestRef.current = null;
      unsubscribe();
    };
  }, [isActive, sessionId, session?.state, isClipboardSyncOn, sessionDataRetry]);

  const receiptKey = JSON.stringify(receiptIds);
  useEffect(() => {
    if (!sessionId || session?.state !== "connected" || !receiptIds.length) return;
    let active = true;
    const unsubscribe = subscribeSessionData(sessionId,
      (data) => sessionDataHandlerRef.current(data, () => active),
      (error) => { if (active) setSessionDataError(error.message); },
      { queues: false, receiptIds });
    const timeout = window.setTimeout(() => {
      if (active) setSessionDataError("파일 수신 확인 시간 초과. 재시도해 주세요.");
      active = false;
      unsubscribe();
    }, 15 * 60_000);
    return () => { active = false; unsubscribe(); window.clearTimeout(timeout); };
  }, [sessionId, session?.state, receiptKey, sessionDataRetry]);

  useEffect(() => {
    let active = true;
    void (async () => {
      await Promise.resolve();
      for (const [id, transfer] of storageTransfersRef.current) {
        if (!active) return;
        if (!transfer.received) continue;
        try {
          await deleteUploadedFileFromStorage(transfer.path);
          storageTransfersRef.current.delete(id);
          window.localStorage.setItem(STORAGE_TRANSFER_CLEANUP_KEY, serializeStorageTransferCleanup(storageTransfersRef.current));
        } catch {
          if (active) setSessionDataError("전송 원본 정리 실패. 재시도해 주세요.");
          return;
        }
      }
    })();
    return () => { active = false; };
  }, [sessionId, sessionDataRetry]);

  useEffect(() => {
    if (!isActive || !isClipboardSyncOn || !sessionId || !session || session.state !== "connected") {
      return;
    }

    let active = true;
    let inFlight = false;
    const syncClipboard = async () => {
      if (!active || inFlight) return;
      inFlight = true;
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
      } finally {
        inFlight = false;
      }
    };

    void syncClipboard();
    const intervalId = window.setInterval(() => void syncClipboard(), 1500);
    return () => {
      active = false;
      window.clearInterval(intervalId);
    };
  }, [isActive, isClipboardSyncOn, sessionId, session, sendClipboardImage]);

  // Stream Frame drawing
  useEffect(() => {
    if (!device || !sessionId || !session || session.state !== "connected") {
      return;
    }

    tileSequenceRef.current.clear();
    receivedFrameSequenceRef.current = 0;
    let active = true;
    let webRtcTransport: ViewerWebRtcTransport | null = null;
    let webRtcStartInFlight = false;
    let webRtcConnectionOpen = false;
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
      const startWebRtc = async () => {
        if (!active || webRtcStartInFlight) {
          return;
        }
        webRtcStartInFlight = true;
        setNeedsManualReconnect(false);
        webRtcConnectionOpen = false;
        setIsWebRtcConnectionReady(false);
        webRtcTransport?.close();
        webRtcTransport = null;
        webRtcTransportRef.current = null;
        let failed = false;
        try {
          const transport = await startFirebaseViewerWebRtcTransport(sessionId, {
            onFrame: drawTileFrame,
            onState: (state) => {
              if (!active) return;
              if (state === "webrtc-open") {
                webRtcConnectionOpen = true;
                setNeedsManualReconnect(false);
                setIsWebRtcConnectionReady(true);
                if (rebootReconnectStateRef.current === "reconnecting") {
                  setRebootReconnectState("idle");
                }
              }
            },
            onDiagnostic: (message) => {
              if (active) {
                console.warn("[WebRTC Viewer diagnostic]", message);
              }
            },
            onError: (error) => {
              if (!active) return;
              failed = true;
              webRtcConnectionOpen = false;
              setIsWebRtcConnectionReady(false);
              if (rebootReconnectStateRef.current !== "idle") {
                setRebootReconnectState("reconnecting");
              }
              console.warn("[WebRTC Viewer]", error.message);
              setNeedsManualReconnect(true);
              webRtcTransport?.close();
              webRtcTransportRef.current = null;
            },
          });
          if (!active || failed) {
            transport.close();
            return;
          }
          webRtcTransport = transport;
          webRtcTransportRef.current = transport;
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          console.warn("[WebRTC Viewer] transport unavailable:", message);
          if (rebootReconnectStateRef.current !== "idle") {
            setRebootReconnectState("reconnecting");
          }
          if (active) setNeedsManualReconnect(true);
        } finally {
          webRtcStartInFlight = false;
        }
      };

      queueMicrotask(() => { void startWebRtc(); });
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
      webRtcConnectionOpen = false;
      webRtcTransport?.close();
      if (webRtcTransportRef.current === webRtcTransport) {
        webRtcTransportRef.current = null;
      }
      if (intervalId) {
        clearInterval(intervalId);
      }
    };
  }, [device?.id, sessionId, session?.id, session?.state, webRtcReconnectGeneration]);

  const cancelPendingPointerMove = () => {
    pendingMoveRef.current = null;
    if (moveFrameRef.current !== null) {
      window.cancelAnimationFrame(moveFrameRef.current);
      moveFrameRef.current = null;
    }
    if (moveDelayTimerRef.current !== null) {
      window.clearTimeout(moveDelayTimerRef.current);
      moveDelayTimerRef.current = null;
    }
  };

  const releaseAllInputs = (): Promise<void> => {
    const releaseTasks: Promise<unknown>[] = [];
    cancelPendingPointerMove();
    if (pressedKeysRef.current.size > 0 || suppressedKeyUpsRef.current.size > 0) {
      pressedKeysRef.current.clear();
      releaseTasks.push(Promise.resolve(onInputEvent("key-release-all")));
    }
    suppressedKeyUpsRef.current.clear();
    if (pressedButtonsRef.current.size > 0) {
      const point = lastPointerPointRef.current;
      for (const button of pressedButtonsRef.current) {
        releaseTasks.push(Promise.resolve(onInputEvent(buildMouseCommand("up", point.dx, point.dy, button))));
      }
      pressedButtonsRef.current.clear();
    }
    activePointerIdRef.current = null;
    return Promise.allSettled(releaseTasks).then(() => undefined);
  };

  useEffect(() => {
    if (!isActive) {
      void releaseAllInputs();
    }
  }, [isActive]);

  const handlePanelBlur = (event: React.FocusEvent<HTMLElement>) => {
    const nextTarget = event.relatedTarget;
    if (nextTarget instanceof Node && event.currentTarget.contains(nextTarget)) {
      return;
    }
    releaseAllInputs();
  };

  const handleCanvasPointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    e.preventDefault();
    if (activePointerIdRef.current !== null && activePointerIdRef.current !== e.pointerId) {
      return;
    }
    const canvas = canvasRef.current;
    if (!canvas) return;

    const rect = canvas.getBoundingClientRect();
    const point = mapRemotePoint(e.clientX, e.clientY, rect);
    lastPointerPointRef.current = point;
    const { dx, dy } = point;
    const button = pressTrackedMouseButton(pressedButtonsRef.current, e.button);
    if (button === null) {
      return;
    }
    activePointerIdRef.current = e.pointerId;
    e.currentTarget.setPointerCapture(e.pointerId);
    imeInputRef.current?.focus({ preventScroll: true });
    onInputEvent(buildMouseCommand("down", dx, dy, button));
  };

  const handleCanvasPointerUp = (e: React.PointerEvent<HTMLCanvasElement>) => {
    e.preventDefault();
    if (activePointerIdRef.current !== null && activePointerIdRef.current !== e.pointerId) {
      return;
    }
    const canvas = canvasRef.current;
    if (!canvas) return;

    const rect = canvas.getBoundingClientRect();
    const point = mapRemotePoint(e.clientX, e.clientY, rect);
    lastPointerPointRef.current = point;
    const { dx, dy } = point;
    cancelPendingPointerMove();
    const button = releaseTrackedMouseButton(pressedButtonsRef.current, e.button);
    if (button !== null) {
      onInputEvent(buildMouseCommand("up", dx, dy, button));
    }
    if (pressedButtonsRef.current.size === 0) {
      activePointerIdRef.current = null;
      if (e.currentTarget.hasPointerCapture(e.pointerId)) {
        e.currentTarget.releasePointerCapture(e.pointerId);
      }
    }
  };

  const handleCanvasPointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!isActive) {
      return;
    }
    if (activePointerIdRef.current !== null && activePointerIdRef.current !== e.pointerId) {
      return;
    }
    const canvas = canvasRef.current;
    if (!canvas) return;

    const rect = canvas.getBoundingClientRect();
    const point = mapRemotePoint(e.clientX, e.clientY, rect);
    lastPointerPointRef.current = point;
    const releasedButtons = releaseTrackedMouseButtonsMissingFromMask(
      pressedButtonsRef.current,
      e.buttons,
    );
    if (releasedButtons.length > 0) {
      cancelPendingPointerMove();
      for (const button of releasedButtons) {
        onInputEvent(buildMouseCommand("up", point.dx, point.dy, button));
      }
      if (pressedButtonsRef.current.size === 0) {
        activePointerIdRef.current = null;
      }
    }
    pendingMoveRef.current = point;
    if (moveFrameRef.current !== null || moveDelayTimerRef.current !== null) {
      return;
    }

    const sendLatestMove = () => {
      moveFrameRef.current = window.requestAnimationFrame(() => {
        moveFrameRef.current = null;
        const point = pendingMoveRef.current;
        if (point) {
          lastMoveSentAtRef.current = performance.now();
          onInputEvent(buildMouseCommand("move", point.dx, point.dy));
        }
      });
    };
    const waitMs = Math.max(0, 33 - (performance.now() - lastMoveSentAtRef.current));
    if (waitMs === 0) {
      sendLatestMove();
      return;
    }
    moveDelayTimerRef.current = window.setTimeout(() => {
      moveDelayTimerRef.current = null;
      sendLatestMove();
    }, waitMs);
  };

  const handleCanvasPointerCancel = (e: React.PointerEvent<HTMLCanvasElement>) => {
    e.preventDefault();
    if (activePointerIdRef.current !== null && activePointerIdRef.current !== e.pointerId) {
      return;
    }
    cancelPendingPointerMove();
    const point = lastPointerPointRef.current;
    for (const button of pressedButtonsRef.current) {
      onInputEvent(buildMouseCommand("up", point.dx, point.dy, button));
    }
    pressedButtonsRef.current.clear();
    activePointerIdRef.current = null;
  };

  const handleCanvasWheel = (e: React.WheelEvent<HTMLCanvasElement>) => {
    e.preventDefault();
    if (!isActive) {
      onSelectSession(sessionId);
      return;
    }
    const canvas = canvasRef.current;
    if (!canvas) return;

    const rect = canvas.getBoundingClientRect();
    const point = mapRemotePoint(e.clientX, e.clientY, rect);
    lastPointerPointRef.current = point;
    const { dx, dy } = point;
    const delta = normalizeWheelDelta(e.deltaY);
    if (delta !== 0) {
      onInputEvent(buildMouseCommand("wheel", dx, dy, 0, delta));
    }
  };

  const handleKeyDown = async (event: React.KeyboardEvent<HTMLElement>) => {
    if (!isActive) {
      return;
    }
    if (isEditableTarget(event.target)) {
      return;
    }
    const hangulToggle = isHangulToggleKey(event.key, event.code, event.keyCode);
    if (hangulToggle) {
      if (event.repeat) {
        event.preventDefault();
        return;
      }
      suppressedKeyUpsRef.current.add(event.code || "Hangul");
      imeInputRef.current?.focus({ preventScroll: true });
      return;
    }
    if (isExactCtrlShortcut(event, "Escape")) {
      event.preventDefault();
      if (event.repeat) {
        return;
      }
      if (releaseTrackedKeyByRemoteKey(pressedKeysRef.current, "Ctrl")) {
        onInputEvent("key-up Ctrl");
      }
      suppressedKeyUpsRef.current.add(event.code || "Esc");
      onInputEvent("keypress Win");
      return;
    }

    if (isExactCtrlShortcut(event, "v")) {
      event.preventDefault();
      if (event.repeat) {
        return;
      }
      suppressedKeyUpsRef.current.add(event.code || event.key);
      const targetSessionId = sessionId;
      const targetTransport = webRtcTransportRef.current;
      if (!targetSessionId || activeSessionIdRef.current !== targetSessionId) {
        return;
      }
      const image = await readClipboardPngBlob();
      if (image) {
        if (!targetTransport || activeSessionIdRef.current !== targetSessionId || webRtcTransportRef.current !== targetTransport) {
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
        if (activeSessionIdRef.current === targetSessionId && webRtcTransportRef.current === targetTransport) {
          onInputEvent(text ? buildPasteTextCommand(text) : "paste");
        }
      } catch {
        if (activeSessionIdRef.current === targetSessionId && webRtcTransportRef.current === targetTransport) {
          onInputEvent("paste");
        }
      }
      return;
    }

    const isLocalText = isRemoteTextInputKeystroke({
      key: event.key,
      code: event.code,
      ctrlKey: event.ctrlKey,
      altKey: event.altKey,
      metaKey: event.metaKey,
      shiftKey: event.shiftKey,
      isComposing: event.nativeEvent.isComposing || event.keyCode === 229,
    });
    if (isLocalText) {
      suppressedKeyUpsRef.current.add(event.code || event.key);
      if (event.target !== imeInputRef.current && event.key.length === 1) {
        event.preventDefault();
        onInputEvent(buildUnicodeTextCommand(event.key));
      }
      return;
    }

    event.preventDefault();
    const command = buildKeyboardCommand("keydown", event.key, event.code, event.keyCode);
    const remoteKey = command.slice("key-down ".length);
    const physicalKey = event.code || remoteKey;
    if (event.repeat) {
      if (shouldForwardTrackedKeyRepeat(pressedKeysRef.current, physicalKey, remoteKey)) {
        onInputEvent(command);
      }
      return;
    }
    if (!pressTrackedKey(pressedKeysRef.current, physicalKey, remoteKey)) {
      return;
    }
    onInputEvent(command);
  };

  const handleKeyUp = (event: React.KeyboardEvent<HTMLElement>) => {
    if (!isActive) {
      return;
    }
    const command = buildKeyboardCommand("keyup", event.key, event.code, event.keyCode);
    const fallbackRemoteKey = command.slice("key-up ".length);
    const physicalKey = event.code || fallbackRemoteKey;
    if (suppressedKeyUpsRef.current.delete(physicalKey)) {
      event.preventDefault();
      return;
    }
    const remoteKey = releaseTrackedKey(pressedKeysRef.current, physicalKey);
    if (remoteKey === null) {
      return;
    }
    event.preventDefault();
    onInputEvent(`key-up ${remoteKey}`);
  };

  const handleImeCompositionStart = () => {
    if (!isActive) {
      return;
    }
    imeComposingRef.current = true;
    imeCompositionValueRef.current = "";
    suppressNextImeValueRef.current = "";
  };

  const sendImeCompositionReplacement = (nextText: string) => {
    const replacement = replaceRemoteComposition(imeCompositionValueRef.current, nextText);
    imeCompositionValueRef.current = nextText;
    if (replacement.changed) {
      onInputEvent(buildReplaceUnicodeTextCommand(replacement.deleteCount, replacement.text));
    }
  };

  const handleImeCompositionUpdate = (event: React.CompositionEvent<HTMLTextAreaElement>) => {
    if (!isActive) {
      return;
    }
    sendImeCompositionReplacement(event.data);
  };

  const handleImeCompositionEnd = (event: React.CompositionEvent<HTMLTextAreaElement>) => {
    if (!isActive) {
      event.currentTarget.value = "";
      return;
    }
    imeComposingRef.current = false;
    const result = finishRemoteComposition(event.data, event.currentTarget.value);
    sendImeCompositionReplacement(result.text);
    imeCompositionValueRef.current = "";
    suppressNextImeValueRef.current = result.suppressNextValue;
    event.currentTarget.value = "";
  };

  const handleImeInput = (event: React.FormEvent<HTMLTextAreaElement>) => {
    const input = event.currentTarget;
    if (!isActive) {
      input.value = "";
      return;
    }
    const nativeEvent = event.nativeEvent as InputEvent;
    const result = consumeRemoteTextInput(
      input.value,
      imeComposingRef.current || nativeEvent.isComposing,
      suppressNextImeValueRef.current,
    );
    suppressNextImeValueRef.current = result.suppressNextValue;
    if (!imeComposingRef.current && !nativeEvent.isComposing) {
      input.value = "";
    }
    if (result.text) {
      onInputEvent(buildUnicodeTextCommand(result.text));
    }
  };

  useEffect(() => {
    if (isActive) {
      imeInputRef.current?.focus({ preventScroll: true });
    }
  }, [isActive, sessionId]);

  useEffect(() => {
    const handleWindowPointerUp = (event: PointerEvent) => {
      if (activePointerIdRef.current !== null && activePointerIdRef.current !== event.pointerId) {
        return;
      }
      cancelPendingPointerMove();
      const button = releaseTrackedMouseButton(pressedButtonsRef.current, event.button);
      if (button === null) {
        return;
      }
      const canvas = canvasRef.current;
      const rect = canvas?.getBoundingClientRect();
      const point = rect
        ? mapRemotePoint(event.clientX, event.clientY, rect)
        : lastPointerPointRef.current;
      lastPointerPointRef.current = point;
      onInputEvent(buildMouseCommand("up", point.dx, point.dy, button));
      if (pressedButtonsRef.current.size === 0) {
        activePointerIdRef.current = null;
      }
    };
    const handleWindowPointerCancel = (event: PointerEvent) => {
      if (activePointerIdRef.current !== null && activePointerIdRef.current !== event.pointerId) {
        return;
      }
      releaseAllInputs();
    };
    const handleWindowBlur = () => releaseAllInputs();
    const handleVisibilityChange = () => {
      if (document.visibilityState === "hidden") {
        releaseAllInputs();
      }
    };

    window.addEventListener("pointerup", handleWindowPointerUp, true);
    window.addEventListener("pointercancel", handleWindowPointerCancel, true);
    window.addEventListener("blur", handleWindowBlur);
    document.addEventListener("visibilitychange", handleVisibilityChange);
    return () => {
      window.removeEventListener("pointerup", handleWindowPointerUp, true);
      window.removeEventListener("pointercancel", handleWindowPointerCancel, true);
      window.removeEventListener("blur", handleWindowBlur);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
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
      if (isActive && isClipboardSyncOn) {
        let timeout: ReturnType<typeof setTimeout> | undefined;
        const response = new Promise<string>((resolve, reject) => {
          clipboardRequestRef.current = resolve;
          timeout = setTimeout(() => reject(new Error("클립보드 응답 시간 초과")), 5_000);
        });
        try {
          await Promise.resolve(onInputEvent("clipboard-request"));
          await navigator.clipboard.writeText(await response);
          alert("클립보드 수신 완료");
        } finally { clearTimeout(timeout); clipboardRequestRef.current = null; }
        return;
      }
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
  const scheduleTransferProgressClear = (transferId: string) => {
    window.setTimeout(() => {
      if (activeTransferIdRef.current === transferId) {
        activeTransferIdRef.current = "";
        setTransferProgress(null);
      }
    }, 2500);
  };

  const updateTransferQueueItem = (
    transferId: string,
    updater: (item: FileTransferQueueItem) => FileTransferQueueItem,
  ) => {
    setTransferQueue((current) => current.map((item) => item.id === transferId ? updater(item) : item));
  };

  const updateQueuedTransferProgress = (
    transferId: string,
    receivedBytes: number,
    totalBytes: number,
    startedAtMs: number,
  ) => {
    const elapsedSeconds = Math.max(0.001, (performance.now() - startedAtMs) / 1000);
    const speedBytesPerSecond = receivedBytes / elapsedSeconds;
    updateTransferQueueItem(
      transferId,
      (item) => updateFileTransferProgress(item, Math.min(receivedBytes, totalBytes), speedBytesPerSecond),
    );
    setTransferProgress({
      fileName: transferFilesRef.current.get(transferId)?.name ?? "파일",
      ...formatTransferStats(receivedBytes, totalBytes, startedAtMs, performance.now()),
    });
  };

  const transferSingleFile = async (file: File, transferId: string) => {
    if (!sessionId) return;
    if (cancelledTransferIdsRef.current.has(transferId)) {
      throw new DOMException("File transfer cancelled.", "AbortError");
    }
    const relativePath = (file as File & { webkitRelativePath?: string }).webkitRelativePath?.trim();
    const remoteFilename = relativePath || file.name;
    if (!canTransferRemoteFile(file.size)) {
      throw new Error(`${remoteFilename}: file transfer limit is ${remoteFileLimitLabel()}.`);
    }

    const abortController = new AbortController();
    transferAbortControllersRef.current.set(transferId, abortController);
    activeTransferIdRef.current = transferId;
    updateTransferQueueItem(transferId, (item) => markFileTransferTransferring(item));
    setTransferProgress({
      fileName: remoteFilename,
      progress: 0,
      speed: "전송 준비 중",
      timeLeft: "",
    });
    let fileSha256: string;
    try {
      fileSha256 = await sha256BlobHex(file);
    } catch (error) {
      if (activeTransferIdRef.current === transferId) {
        setTransferProgress(null);
      }
      transferAbortControllersRef.current.delete(transferId);
      throw error;
    }
    if (!fileSha256) {
      setTransferProgress(null);
      throw new Error("File checksum is unavailable in this runtime.");
    }
    if (abortController.signal.aborted) {
      transferAbortControllersRef.current.delete(transferId);
      throw new DOMException("File transfer cancelled.", "AbortError");
    }
    const startedAtMs = performance.now();

    if (isViewerFirebaseEnabled()) {
      const realtimeTransport = webRtcTransportRef.current;
      if (realtimeTransport) {
        try {
          const sentOverWebRtc = await realtimeTransport.sendFile({
            file,
            filename: remoteFilename,
            fileSha256,
            transferId,
            signal: abortController.signal,
            onProgress: (receivedBytes, totalBytes) => {
              updateQueuedTransferProgress(transferId, receivedBytes, totalBytes, startedAtMs);
            },
          });
          if (sentOverWebRtc) {
            updateTransferQueueItem(transferId, completeFileTransfer);
            setTransferProgress({
              fileName: remoteFilename,
              ...formatTransferStats(file.size, file.size, startedAtMs, performance.now()),
            });
            transferAbortControllersRef.current.delete(transferId);
            scheduleTransferProgressClear(transferId);
            return;
          }
        } catch (error) {
          if (abortController.signal.aborted) {
            transferAbortControllersRef.current.delete(transferId);
            throw new DOMException("File transfer cancelled.", "AbortError");
          }
          console.warn("WebRTC file transfer failed; trying the signed Firebase fallback.", error);
        }
      }

      try {
        const upload = await uploadFileToStorage(sessionId, {
          file,
          fileSha256,
          filename: remoteFilename,
          signal: abortController.signal,
          onProgress: (sentBytes, totalBytes) => {
            updateQueuedTransferProgress(transferId, sentBytes, totalBytes, startedAtMs);
          },
          totalBytes: file.size,
          transferId,
        });
        storageTransfersRef.current.set(transferId, { path: upload.storagePath, received: false });
        setReceiptIds((ids) => ids.includes(transferId) ? ids : [...ids, transferId]);
        window.localStorage.setItem(
          STORAGE_TRANSFER_CLEANUP_KEY,
          serializeStorageTransferCleanup(storageTransfersRef.current),
        );
        setTransferProgress({
          fileName: remoteFilename,
          ...formatTransferStats(file.size, file.size, startedAtMs, performance.now()),
        });
        updateTransferQueueItem(transferId, completeFileTransfer);
        transferAbortControllersRef.current.delete(transferId);
        scheduleTransferProgressClear(transferId);
        return;
      } catch (err) {
        if (abortController.signal.aborted) {
          throw new DOMException("File transfer cancelled.", "AbortError");
        }
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
    setReceiptIds((ids) => ids.includes(transferId) ? ids : [...ids, transferId]);
    let sentBytes = 0;

    try {
      for (let chunkIndex = 0; chunkIndex < totalChunks; chunkIndex += 1) {
        if (abortController.signal.aborted) {
          throw new DOMException("File transfer cancelled.", "AbortError");
        }
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
        updateQueuedTransferProgress(transferId, sentBytes, file.size, startedAtMs);
      }
      updateTransferQueueItem(transferId, completeFileTransfer);
      scheduleTransferProgressClear(transferId);
    } catch (err) {
      setTransferProgress(null);
      throw err;
    } finally {
      transferAbortControllersRef.current.delete(transferId);
    }
  };

  const transferSelectedFiles = async (files: File[]) => {
    if (!sessionId || files.length === 0) return;
    const queued = files.map((file, index) => {
      const id = `transfer-${Date.now()}-${index}-${Math.random().toString(36).slice(2, 8)}`;
      transferFilesRef.current.set(id, file);
      return createFileTransferQueueItem({ id, fileName: file.name, totalBytes: file.size });
    });
    setTransferQueue((current) => appendFileTransferQueueItems(current, queued));
    for (const item of queued) {
      const file = transferFilesRef.current.get(item.id);
      if (!file) continue;
      if (cancelledTransferIdsRef.current.has(item.id)) {
        updateTransferQueueItem(item.id, cancelFileTransfer);
        continue;
      }
      try {
        await transferSingleFile(file, item.id);
      } catch (error) {
        if (error instanceof DOMException && error.name === "AbortError") {
          updateTransferQueueItem(item.id, cancelFileTransfer);
        } else {
          updateTransferQueueItem(item.id, (entry) => failFileTransfer(
            entry,
            error instanceof Error ? error.message : String(error),
          ));
        }
      }
      transferAbortControllersRef.current.delete(item.id);
      cancelledTransferIdsRef.current.delete(item.id);
    }
  };

  const cancelQueuedTransfer = (transferId: string) => {
    cancelledTransferIdsRef.current.add(transferId);
    transferAbortControllersRef.current.get(transferId)?.abort();
    updateTransferQueueItem(transferId, cancelFileTransfer);
  };

  const retryQueuedTransfer = (transferId: string) => {
    const file = transferFilesRef.current.get(transferId);
    if (!file) return;
    const retryId = `${transferId}-retry-${Date.now()}`;
    transferFilesRef.current.set(retryId, file);
    transferFilesRef.current.delete(transferId);
    updateTransferQueueItem(transferId, () => createFileTransferQueueItem({
      id: retryId,
      fileName: file.name,
      totalBytes: file.size,
    }));
    void transferSingleFile(file, retryId)
      .catch((error) => {
        if (error instanceof DOMException && error.name === "AbortError") {
          updateTransferQueueItem(retryId, cancelFileTransfer);
        } else {
          updateTransferQueueItem(retryId, (item) => failFileTransfer(
            item,
            error instanceof Error ? error.message : String(error),
          ));
        }
      })
      .finally(() => {
        transferAbortControllersRef.current.delete(retryId);
        cancelledTransferIdsRef.current.delete(retryId);
      });
  };

  const clearTerminalTransfers = () => {
    setTransferQueue((current) => {
      const retained = current.filter((item) => item.status === "queued" || item.status === "transferring");
      const retainedIds = new Set(retained.map((item) => item.id));
      for (const transferId of transferFilesRef.current.keys()) {
        if (!retainedIds.has(transferId)) {
          transferFilesRef.current.delete(transferId);
          cancelledTransferIdsRef.current.delete(transferId);
        }
      }
      return retained;
    });
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
    lastDisplayCommandRef.current = index;
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
    if (command === "restart") {
      setRebootReconnectState("restarting");
      setIsWebRtcConnectionReady(false);
    }
    onInputEvent(buildSystemCommand(command));
  };

  const triggerBeepSound = async () => {
    if (sessionId) {
      await sendChatMessage(sessionId, "__AUDIO_BEEP_SIGNAL__", "viewer");
      playBeepSound();
    }
  };

  const sessionTabsBar = !isSplit && sessions.length > 1 ? (
    <nav className="remote-session-tabs" aria-label="열린 원격 세션">
      {sessions.map((tabSession) => {
        const tabDevice = sessionDevices.find((candidate) => candidate.id === tabSession.deviceId);
        const active = tabSession.id === activeSessionId;
        return (
          <span className={`remote-session-tab${active ? " active" : ""}`} key={tabSession.id}>
            <button type="button" onClick={() => onSelectSession(tabSession.id)}>
              <i aria-hidden="true" />
              {tabDevice?.desktopName ?? tabSession.deviceId}
            </button>
            <button
              className="remote-session-tab-close"
              type="button"
              title="이 세션 닫기"
              aria-label={`${tabDevice?.desktopName ?? tabSession.deviceId} 세션 닫기`}
              onClick={() => active && tabSession.id === sessionId
                ? leaveRemoteSession()
                : onCloseSessionTab(tabSession.id)}
            >
              <X size={13} />
            </button>
          </span>
        );
      })}
    </nav>
  ) : null;
  const splitPanelClass = splitPosition
    ? ` session-panel-split session-panel-split-${splitPosition}${isActive ? " active" : ""}`
    : "";

  if (!device || !session) {
    return null;
  }

  if (session.state === "pending") {
    return (
      <section
        className={`session-panel session-pending-panel${isVisible ? "" : " session-panel-inactive"}${splitPanelClass}`}
        data-testid="remote-session-pending"
        onPointerDownCapture={() => !isActive && onSelectSession(sessionId)}
      >
        {sessionTabsBar}
        <div className="pending-session-header">
          <button className="session-back-button" type="button" onClick={() => void leaveRemoteSession()}>
            <ArrowLeft size={17} />
            <span>장비 목록</span>
          </button>
          <div className="session-device-context">
            <span className="session-live-dot is-connecting" aria-hidden="true" />
            <div>
              <strong>{device.desktopName}</strong>
              <small>{device.deviceName}</small>
            </div>
          </div>
        </div>
        <div className="pending-session-content">
          <span className="pending-session-indicator" aria-hidden="true" />
          <strong>에이전트 연결 준비 중</strong>
          <p>
            Agent 상태를 확인하는 중입니다. 정상 등록된 온라인 장비는 별도 승인 없이 자동으로 연결됩니다.
          </p>
          <button className="session-cancel-button" type="button" onClick={() => void leaveRemoteSession()}>
            접속 시도 취소
          </button>
        </div>
      </section>
    );
  }

  return (
    <section
      ref={panelRef}
      className={`session-panel${isVisible ? "" : " session-panel-inactive"}${splitPanelClass}${isSessionFullscreen ? " session-fullscreen-active" : ""}${isSessionFullscreen && isFullscreenToolbarOpen ? " session-fullscreen-tools-open" : ""}`}
      data-testid="remote-session-workspace"
      tabIndex={0}
      onBlur={handlePanelBlur}
      onFocusCapture={() => !isActive && onSelectSession(sessionId)}
      onKeyDown={handleKeyDown}
      onKeyUp={handleKeyUp}
      onPointerDownCapture={() => !isActive && onSelectSession(sessionId)}
    >
      {sessionTabsBar}
      <textarea
        ref={imeInputRef}
        className="remote-ime-input"
        data-remote-ime-input="true"
        aria-label="원격 키보드 입력"
        autoCapitalize="off"
        autoCorrect="off"
        spellCheck={false}
        onCompositionStart={handleImeCompositionStart}
        onCompositionUpdate={handleImeCompositionUpdate}
        onCompositionEnd={handleImeCompositionEnd}
        onInput={handleImeInput}
      />
      <div className="remote-work-area remote-canvas-viewport" data-testid="remote-canvas-viewport">
          <div className="remote-screen connected">
          <div
            ref={remotePreviewRef}
            className="remote-preview"
            onDragOver={(event) => event.preventDefault()}
            onDrop={handleFileDrop}
          >
            <canvas
              ref={canvasRef}
              className="remote-canvas"
              onContextMenu={(event) => event.preventDefault()}
              onPointerDown={handleCanvasPointerDown}
              onPointerMove={handleCanvasPointerMove}
              onPointerUp={handleCanvasPointerUp}
              onPointerCancel={handleCanvasPointerCancel}
              onLostPointerCapture={handleCanvasPointerCancel}
              onWheel={handleCanvasWheel}
              style={{
                display: "block",
                cursor: "crosshair",
                transform: `scale(${zoom})`,
                transformOrigin: "center center",
              }}
            />
            </div>
          </div>

          {transferProgress && transferQueue.length === 0 && (
            <div
              className="session-transfer-progress"
              role="progressbar"
              aria-label={`${transferProgress.fileName} 파일 전송`}
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={transferProgress.progress}
            >
              <span className="session-transfer-status">
                {transferProgress.fileName} {transferProgress.progress}% · {transferProgress.speed}
                {transferProgress.timeLeft && ` · ${transferProgress.timeLeft}`}
              </span>
              <span className="session-transfer-progress-track" aria-hidden="true">
                <span
                  className="session-transfer-progress-fill"
                  style={{ width: `${transferProgress.progress}%` }}
                />
              </span>
            </div>
          )}

          {transferQueue.length > 0 && (
            <aside className="session-transfer-queue" aria-label="파일 전송 목록">
              <div className="session-transfer-queue-heading">
                <strong>파일 전송</strong>
                <button
                  type="button"
                  title="완료 항목 정리"
                  aria-label="완료 항목 정리"
                  onClick={clearTerminalTransfers}
                >
                  <Trash2 size={14} />
                </button>
              </div>
              {transferQueue.map((item) => {
                const percent = getFileTransferPercent(item);
                const eta = getFileTransferEtaSeconds(item);
                const statusLabel = item.status === "queued" ? "대기"
                  : item.status === "transferring" ? `${percent}%${eta === null ? "" : ` · ${eta}초`}`
                    : item.status === "completed" ? "완료"
                      : item.status === "cancelled" ? "취소됨" : "실패";
                return (
                  <div className={`session-transfer-queue-item ${item.status}`} key={item.id}>
                    <span><strong>{item.fileName}</strong><small>{statusLabel}</small></span>
                    <span className="session-transfer-progress-track" aria-hidden="true">
                      <span className="session-transfer-progress-fill" style={{ width: `${percent}%` }} />
                    </span>
                    {(item.status === "queued" || item.status === "transferring") && (
                      <button type="button" onClick={() => cancelQueuedTransfer(item.id)}>취소</button>
                    )}
                    {(item.status === "failed" || item.status === "cancelled") && (
                      <button type="button" onClick={() => retryQueuedTransfer(item.id)}>재시도</button>
                    )}
                  </div>
                );
              })}
            </aside>
          )}

          {sessionDataError && (
            <div className="error-banner" role="alert">
              {sessionDataError}
              <button type="button" title="부가 기능 재시도" aria-label="부가 기능 재시도" onClick={() => {
                setSessionDataError(""); setSessionDataRetry((value) => value + 1);
              }}><RotateCcw size={16} /></button>
            </div>
          )}
          {isChatOpen && (
          <aside className="remote-chat-panel" aria-label="실시간 채팅">
            <div className="remote-chat-header">
              <span>실시간 채팅</span>
              <button type="button" onClick={() => setIsChatOpen(false)} aria-label="채팅 닫기" title="채팅 닫기">
                <ChevronDown size={17} />
              </button>
            </div>
            <div className="remote-chat-messages">
              {chatMessages.map((msg) => {
                if (msg.message === "__AUDIO_BEEP_SIGNAL__") return null;
                const isViewer = msg.sender === "viewer";
                return (
                  <div className={`remote-chat-message ${isViewer ? "viewer" : "agent"}`} key={msg.id}>
                    <strong>{isViewer ? "나: " : "에이전트: "}</strong>
                    {msg.message}
                  </div>
                );
              })}
            </div>
            <form className="remote-chat-compose" onSubmit={handleSendChat}>
              <input
                value={chatInput}
                onChange={(e) => setChatInput(e.target.value)}
                placeholder="메시지 입력..."
              />
              <button type="submit" aria-label="채팅 전송" title="채팅 전송">
                <Send size={16} />
              </button>
            </form>
          </aside>
        )}
      </div>

      {isSessionFullscreen && (
        <>
          <button
            className="session-fullscreen-toolbar-toggle"
            data-testid="fullscreen-toolbar-toggle"
            type="button"
            aria-expanded={isFullscreenToolbarOpen}
            aria-label={isFullscreenToolbarOpen ? "작업 도구 닫기" : "작업 도구 열기"}
            title={isFullscreenToolbarOpen ? "작업 도구 닫기" : "작업 도구 열기"}
            onClick={() => setIsFullscreenToolbarOpen((open) => !open)}
          >
            {isFullscreenToolbarOpen ? <ChevronUp size={20} /> : <ChevronDown size={20} />}
          </button>
          <button
            className="session-fullscreen-exit"
            type="button"
            aria-label="전체화면 종료"
            title="창모드로 전환"
            onClick={toggleSessionFullscreen}
          >
            <Minimize2 size={20} />
            <span>창모드</span>
          </button>
        </>
      )}

      <div className="session-actions session-actions-top remote-command-bar" data-testid="remote-command-bar">
        <div className="session-command-identity">
          <div className="session-device-context" data-testid="remote-connection-status" role="status" aria-live="polite">
            <span className="session-live-dot" aria-hidden="true" />
            <div>
              <strong>{device.desktopName}</strong>
              <small>
                {device.storeName} · {rebootReconnectState === "restarting"
                  ? "재부팅 시작"
                  : rebootReconnectState === "reconnecting" || !isWebRtcConnectionReady
                    ? (needsManualReconnect ? "연결 끊김" : "연결 중")
                    : "연결됨"}
              </small>
            </div>
          </div>
        </div>

        <div className="session-display-controls" data-testid="display-mode-controls" role="group" aria-label="원격 화면 표시 설정">
          <button type="button" title="원격 연결 새로고침" aria-label="원격 연결 새로고침"
            disabled={!needsManualReconnect && rebootReconnectState === "idle"}
            onClick={() => { setNeedsManualReconnect(false); setRebootReconnectState("idle"); setWebRtcReconnectGeneration((value) => value + 1); }}>
            <RotateCcw size={16} />
          </button>
          <div className="stream-mode-control" role="group" aria-label="화면 반응 속도">
            <button
              type="button"
              className={streamPerformanceMode === "auto" ? "active" : ""}
              aria-pressed={streamPerformanceMode === "auto"}
              onClick={() => selectStreamPerformanceMode("auto")}
              title="네트워크와 Agent 부하에 맞춰 자동 조절합니다"
            >
              자동
            </button>
            <button
              type="button"
              className={streamPerformanceMode === "fast" ? "active" : ""}
              aria-pressed={streamPerformanceMode === "fast"}
              onClick={() => selectStreamPerformanceMode("fast")}
              title="스크롤과 새 창 표시를 우선합니다"
            >
              빠름
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
          <div className="display-scale-control" role="group" aria-label="화면 배율">
            <button type="button" onClick={setFitZoom} title="화면에 맞춤">Fit</button>
            <button type="button" onClick={setActualSizeZoom} title="실제 크기">100%</button>
          </div>
          <div className="zoom-control" role="group" aria-label="확대 축소">
            <button type="button" onClick={() => setZoom((value) => Math.max(0.25, Number((value - 0.05).toFixed(2))))} title="축소" aria-label="화면 축소">
              <ZoomOut size={16} />
            </button>
            <span>{Math.round(zoom * 100)}%</span>
            <button type="button" onClick={() => setZoom((value) => Math.min(8, Number((value + 0.05).toFixed(2))))} title="확대" aria-label="화면 확대">
              <ZoomIn size={16} />
            </button>
          </div>
          {device.displays && device.displays.length > 0 && (
            <select
              className="session-monitor-select"
              value={selectedDisplayIndex}
              onChange={(event) => handleSwitchDisplay(Number(event.target.value))}
              title="모니터 선택"
              aria-label="모니터 선택"
            >
              {device.displays.map((display) => (
                <option key={display.index} value={display.index}>
                  {display.primary ? "Primary " : ""}#{display.index + 1} {display.width}x{display.height} {display.name}
                </option>
              ))}
            </select>
          )}
        </div>

        <div className="session-command-actions">
          <details className="session-tool-menu" data-testid="secondary-tools">
            <summary>
              <SlidersHorizontal size={17} />
              <span>도구</span>
              <ChevronDown size={15} />
            </summary>
            <div className="session-tool-menu-content">
              <section className="session-tool-group" aria-label="시스템 도구">
                <span className="session-tool-heading">시스템</span>
                <div className="session-tool-grid">
                  {[
                    ["services.msc", "서비스"],
                    ["taskmgr", "작업 관리자"],
                    ["cmd", "CMD"],
                    ["explorer", "탐색기"],
                    ["devmgmt.msc", "장치관리자"],
                    ["run", "실행"],
                    ["lock", "화면 잠금"],
                    ["logoff", "로그오프"],
                    ["restart", "재시작"],
                    ["shutdown", "전원 끄기"],
                  ].map(([command, label]) => (
                    <button
                      key={command}
                      className={`secondary-button${DANGEROUS_SYSTEM_COMMANDS.has(command) ? " dangerous-tool" : ""}`}
                      type="button"
                      onClick={() => handleSystemCommand(command)}
                      title={DANGEROUS_SYSTEM_COMMANDS.has(command) ? "두 번 눌러 실행" : label}
                    >
                      {DANGEROUS_SYSTEM_COMMANDS.has(command) ? <Power size={17} /> : <RotateCcw size={17} />}
                      <span>{label}</span>
                    </button>
                  ))}
                </div>
              </section>

              <section className="session-tool-group" aria-label="협업 및 전송 도구">
                <span className="session-tool-heading">협업 및 전송</span>
                <div className="session-tool-grid">
                  <button className="secondary-button" type="button" onClick={() => setIsChatOpen(!isChatOpen)}>
                    <MessageSquare size={17} />
                    <span>채팅 {chatMessages.length > 0 && `(${chatMessages.length})`}</span>
                  </button>
                  <button className="secondary-button" type="button" onClick={triggerBeepSound} title="오디오 비프음 송출">
                    <Volume2 size={17} />
                    <span>사운드 테스트</span>
                  </button>
                  <button className={`secondary-button${isRecording ? " recording" : ""}`} type="button" onClick={isRecording ? stopRecording : startRecording}>
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
                  <label className="session-clipboard-sync">
                    <input type="checkbox" checked={isClipboardSyncOn} onChange={(e) => setIsClipboardSyncOn(e.target.checked)} />
                    자동 동기화
                  </label>
                  <button className="secondary-button" type="button" onClick={() => fileInputRef.current?.click()}>
                    <FileUp size={17} />
                    <span>{`파일 전송 (${remoteFileLimitLabel()})`}</span>
                  </button>
                  <input multiple type="file" ref={fileInputRef} onChange={handleFileUpload} style={{ display: "none" }} />
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
                  <button className="secondary-button" type="button" onClick={startVisualPing}>
                    <MousePointerClick size={17} />
                    <span>{latencyReport || "Visual Ping"}</span>
                  </button>
                </div>
              </section>
            </div>
          </details>
          <button
            className="session-fullscreen-button"
            type="button"
            aria-pressed={isSessionFullscreen}
            onClick={toggleSessionFullscreen}
            title="전체화면 전환"
          >
            {isSessionFullscreen ? <Minimize2 size={17} /> : <Maximize2 size={17} />}
            <span>{isSessionFullscreen ? "창모드" : "전체화면"}</span>
          </button>
          <button
            className="session-end-button destructive"
            data-testid="end-session"
            data-action="back-to-devices"
            type="button"
            onClick={() => void leaveRemoteSession()}
            title="세션을 종료하고 장비 목록으로 돌아가기"
          >
            <LogOut size={17} />
            <span>세션 종료</span>
          </button>
        </div>
      </div>
    </section>
  );
}
