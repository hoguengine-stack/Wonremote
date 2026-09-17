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
  Download,
  ExternalLink,
  FolderOpen,
  Video,
  Volume2,
  ZoomIn,
  ZoomOut,
  Maximize2,
  Minimize2,
  ChevronDown,
  ChevronUp,
  RotateCcw,
  RefreshCw,
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
  Pause,
  Columns2,
  GripVertical,
} from "lucide-react";
import React, { FormEvent, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { listen } from "@tauri-apps/api/event";
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
  uploadFileChunk,
  uploadFileToStorage,
  fetchConnectionHistory,
  requestAgentUpdate,
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
  getFirebaseViewerStorageOwner,
  subscribeViewerAuthState,
  loadFirebaseUpdateRollout,
  saveFirebaseUpdateRollout,
  updateFirebaseDeviceRollout,
  requestFirebaseAgentRollback,
  isCurrentViewerAccountManager,
  requestViewerPasswordReset,
  type ViewerWebRtcTransport,
} from "./firebase/viewerFirebase";
import { ViewerAccountManager } from "./components/ViewerAccountManager";
import { IosCapabilityProbe } from "./components/IosCapabilityProbe";
import { isMobileViewerPath } from "./domain/mobileViewer";
import { MobileRemoteControls, useMobileRemoteHeight } from "./components/MobileRemoteControls";
import { MobileRemoteGesturePad } from "./components/MobileRemoteGesturePad";
import { DesktopRemoteKeyboardRecovery } from "./components/DesktopRemoteKeyboardRecovery";
import { groupDevicesByStore } from "./domain/agentRegistry";
import { organizeDevices, createDeviceGroupMover, DEVICE_DRAG_TYPE } from "./domain/deviceOrganization";
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
import { androidFileExporter } from "./domain/androidFileExport";
import { ViewerRollbackControl } from "./components/ViewerRollbackControl";
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
  releaseTrackedModifierKeys,
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
import { decideUpdateEligibility, type UpdateFleetRollout } from "./domain/updateFleetPolicy";
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
  awaitFileTransferReceipt,
  createFileTransferQueueItem,
  failFileTransfer,
  getFileTransferEtaSeconds,
  getFileTransferPercent,
  markFileTransferTransferring,
  pauseFileTransfer,
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
import { requestFreshClipboardText } from "./domain/requestedClipboard";
import { isRemoteInputAvailable, sessionConnectionStatus } from "./domain/sessionConnectionStatus";
import { createDiagnosticReport, nativeDiagnosticExportUrl } from "./domain/diagnosticReport";
import { IncomingFileAssembler } from "./domain/incomingFile";
import { saveDesktopFile } from "./domain/desktopFileSave";
import { startSelectedViewerScheduler } from "./domain/selectedViewerScheduler";
import { PersistentFileReceiver } from "./domain/persistentFileReceiver";
import { hasCompleteTileCoverage } from "./domain/webrtcFrameAssembly";

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
  const [rawDevices, setDevices] = useState<ManagedDevice[]>([]);
  const devices = useMemo(() => organizeDevices(rawDevices), [rawDevices]);
  const [dropStore, setDropStore] = useState<string | null>(null);
  const groupMover = useMemo(() => createDeviceGroupMover(updateDeviceMetadata), [isAuthenticated]);
  useEffect(() => { groupMover.activate(); return () => groupMover.dispose(); }, [groupMover]);
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
  const [connectionHistory, setConnectionHistory] = useState<ConnectionHistoryEntry[]>([]);
  const [observedConnections, setObservedConnections] = useState<Record<string, string>>({});
  useEffect(() => { if (!isAuthenticated) setObservedConnections({}); }, [isAuthenticated]);
  const deviceListRequestRef = useRef<Promise<ManagedDevice[]> | null>(null);
  const startupSessionCleanupAttemptedRef = useRef(false);
  const connectionEpochRef = useRef(0);
  const pendingConnectAttemptsRef = useRef<Set<Promise<{ cleanupSucceeded: boolean; connected: boolean }>>>(new Set());
  const pendingConnectDeviceIdsRef = useRef<Set<string>>(new Set());
  const selectedUpdateInstallingRef = useRef(false);
  const [selectedUpdateInstalling, setSelectedUpdateInstalling] = useState(false);
  const selectedUpdateIdle = useRef(false);
  selectedUpdateIdle.current = isAuthenticated && sessions.length === 0 && pendingConnectDeviceIdsRef.current.size === 0;
  useEffect(() => {
    if (!(window as any).__TAURI_INTERNALS__ || !isAuthenticated) return;
    let disposed = false;
    let unlisten: (() => void) | undefined;
    let scheduler: ReturnType<typeof startSelectedViewerScheduler> | undefined;
    void listen("selected-viewer-update-finished", () => {
      if (disposed) return;
      scheduler?.installationFailed();
      selectedUpdateInstallingRef.current = false; setSelectedUpdateInstalling(false);
      setApiError("자동 업데이트가 적용되지 않았습니다. 업데이트 확인에서 결과를 확인하세요.");
    }).then(remove => {
      if (disposed) { remove(); return; }
      unlisten = remove;
      scheduler = startSelectedViewerScheduler({
      idle: () => selectedUpdateIdle.current && pendingConnectDeviceIdsRef.current.size === 0 && !selectedUpdateInstallingRef.current,
      check: () => invoke<{available:boolean}>("check_selected_viewer_update"),
      install: async () => {
        selectedUpdateInstallingRef.current = true; setSelectedUpdateInstalling(true);
        try { await invoke("start_installer_update", {restartMode:"viewer",selectedViewer:true}); }
        catch (error) { selectedUpdateInstallingRef.current = false; setSelectedUpdateInstalling(false); throw error; }
      },
      report: error => console.warn("[Selected Viewer update]", error),
      });
    }).catch(error => console.warn("[Selected Viewer update listener]", error));
    return () => { disposed = true; scheduler?.stop(); unlisten?.(); };
  }, [isAuthenticated]);
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
        if (!hasSession) { setDeviceListRefreshKey(0); setIsRefreshingDevices(false); setDevices([]); setConnectionHistory([]); }
        if (hasSession) {
          setDeviceListRefreshKey((current) => current || 1);
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
      if (!isViewerFirebaseEnabled()) { setDevices([]); setDeviceListRefreshKey((current) => current || 1); }
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
      setConnectionHistory([]);
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
    if (selectedUpdateInstallingRef.current) { setApiError("뷰어 업데이트 적용 중입니다. 완료 후 다시 접속하세요."); return null; }
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

  async function handleReconnectSession(previous: RemoteSession) {
    const replacement = await runTrackedSessionOpen(previous.deviceId, () => openSession(previous.deviceId, true), "재접속 실패");
    if (!replacement) throw new Error("재접속하지 못했습니다. 연결 상태를 확인하고 다시 시도하세요.");
    if (replacement.id !== previous.id) {
      setSessions(current => current.filter(item => item.id !== previous.id));
      setSplitSessionIds(null);
      enqueueSessionCleanup(window.localStorage, previous);
      try {
        await closeSession(previous.id);
        removeSessionCleanup(window.localStorage, previous.id);
      } catch { /* Retain the owned old session in the existing cleanup queue. */ }
    }
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

  function handleShowDeviceList() {
    setSplitSessionIds(null);
    setActiveSessionId(null);
    setApiError("");
  }

  useEffect(() => {
    if (!isMobileViewer) {
      return;
    }
    const mobileWindow = window as Window & typeof globalThis & {
      __wonRemoteMobileBackScope?: () => "session" | "list";
    };
    const getBackScope = () => activeSessionId ? "session" as const : "list" as const;
    const showDeviceList = () => handleShowDeviceList();
    mobileWindow.__wonRemoteMobileBackScope = getBackScope;
    window.addEventListener("wonremote:show-device-list", showDeviceList);
    return () => {
      window.removeEventListener("wonremote:show-device-list", showDeviceList);
      if (mobileWindow.__wonRemoteMobileBackScope === getBackScope) {
        delete mobileWindow.__wonRemoteMobileBackScope;
      }
    };
  }, [activeSessionId, isMobileViewer]);

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

  const updateRequestsRef = useRef(new Map<string, number>());
  const updateRequestEpochRef = useRef(0);
  useEffect(() => () => { updateRequestEpochRef.current++; updateRequestsRef.current.clear(); }, [isAuthenticated]);
  async function handleRequestAgentUpdate(device: ManagedDevice) {
    const epoch = updateRequestEpochRef.current;
    const now = Date.now();
    if (now - (updateRequestsRef.current.get(device.id) ?? 0) < 60_000) return;
    updateRequestsRef.current.set(device.id, now);
    try {
      await requestAgentUpdate(device.id);
      if (epoch !== updateRequestEpochRef.current) return;
      setApiError(`${device.desktopName}: 업데이트 요청을 전송했습니다. 설치 완료는 아닙니다. 결과는 장비 새로고침으로 확인하세요. 미지원 구버전은 반응하지 않을 수 있습니다.`);
    } catch (error) {
      if (epoch !== updateRequestEpochRef.current) return;
      setApiError(error instanceof Error ? error.message : "업데이트 요청 전송 실패");
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
                contactPhone: input.contactPhone,
                deviceName: input.deviceName,
                desktopName: input.desktopName === device.desktopName ? undefined : input.desktopName,
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
      setApiError("");
    } catch (error) {
      setApiError(error instanceof Error ? error.message : "장비 정보 수정 실패");
      throw error;
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
      <aside className="sidebar" inert={editTarget !== null}>
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
              className={`group-button ${selectedStore === group.storeName ? "active" : ""} ${dropStore === group.storeName ? "drop-target" : ""}`}
              key={group.storeName}
              type="button"
              onClick={() => setSelectedStore(group.storeName)}
              onDragOver={(event) => {
                if (!event.dataTransfer.types.includes(DEVICE_DRAG_TYPE)) return;
                event.preventDefault();
                event.dataTransfer.dropEffect = "move";
                setDropStore(group.storeName);
              }}
              onDragLeave={() => setDropStore(null)}
              onDrop={async (event) => {
                event.preventDefault();
                setDropStore(null);
                const device = devices.find((item) => item.id === event.dataTransfer.getData(DEVICE_DRAG_TYPE));
                if (!device) return;
                try {
                  const updated = await groupMover.move(device, group.storeName);
                  if (updated) {
                    setDevices((current) => current.map((item) => item.id === updated.id ? updated : item));
                    setApiError("");
                  }
                } catch (error) {
                  setApiError(error instanceof Error ? error.message : "매장 그룹 이동 실패");
                }
              }}
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

      <main className="workspace" inert={editTarget !== null}>
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
          </div>
          <div className="topbar-tools">
          <label className="search-box">
            <Search size={17} />
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="매장, 장비, 담당자, 연락처, 메모 검색"
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
          {!isMobileViewer && Boolean((window as any).__TAURI_INTERNALS__) && <ViewerRollbackControl currentVersion={getViewerVersion(import.meta.env)} restore={version => invoke("start_installer_update", { restartMode: "viewer", rollbackVersion: version })} />}
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
        {(apiError || selectedUpdateInstalling) && (
          <div className="workspace-notices" aria-live="polite">
            {apiError && <p className="workspace-notice topbar-error">{apiError}</p>}
            {selectedUpdateInstalling && <p className="workspace-notice">지정된 뷰어 업데이트 적용 중 · 완료 후 다시 실행됩니다</p>}
          </div>
        )}

        <section
          className={`${session && activeDevice ? "content-grid" : "content-grid content-grid-dashboard"}${activeSplitSessionIds ? " content-grid-split" : ""}`}
          style={activeSplitSessionIds ? {
            "--split-left": `${splitRatio}fr`,
            "--split-right": `${100 - splitRatio}fr`,
          } as React.CSSProperties : undefined}
        >
          <section className="control-panel device-workspace" data-testid="device-workspace">
            {!session && sessions.length > 0 && (
              <nav className="viewer-open-sessions" aria-label="열린 세션 바로가기">
                <span><Monitor size={16} /><strong>열린 세션 {sessions.length}</strong></span>
                <div>
                  {sessions.map((openSession) => {
                    const openDevice = devices.find((device) => device.id === openSession.deviceId);
                    return (
                      <button key={openSession.id} type="button" onClick={() => handleSelectSession(openSession.id)}>
                        <i aria-hidden="true" />
                        <span>{openDevice?.desktopName ?? openSession.deviceId}</span>
                      </button>
                    );
                  })}
                </div>
              </nav>
            )}
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
              connectionHistory={connectionHistory}
              observedConnections={observedConnections}
              activeDeviceIds={sessions.map((openSession) => openSession.deviceId)}
              onConnect={handleConnectDevice}
              onEdit={(device) => setEditTarget({ mode: "device", devices: [device] })}
              onSecureConnect={handleSecureConnectRequest}
              onWake={handleWakeDevice}
              onRequestUpdate={handleRequestAgentUpdate}
              onRefresh={handleRefreshDeviceList}
              isRefreshing={isRefreshingDevices}
              favoriteDeviceIds={favoriteDeviceIds}
              selectedDeviceIds={selectedDeviceIds}
              onToggleFavorite={toggleFavoriteDevice}
              onToggleSelected={toggleSelectedDevice}
              onDiagnostics={setDiagnosticTarget}
            />
            <ConnectionHistorySection devices={devices} history={connectionHistory} onHistory={setConnectionHistory} />
          </section>

          {sessions.map((openSession) => {
            const splitIndex = activeSplitSessionIds?.indexOf(openSession.id) ?? -1;
            return (
              <RemoteSessionPanel
                activeSessionId={activeSessionId}
                inputSuspended={editTarget !== null}
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
                onShowDeviceList={handleShowDeviceList}
                onPicturePresented={() => setObservedConnections(current => ({ ...current, [openSession.deviceId]: new Date().toISOString() }))}
                onReconnect={() => handleReconnectSession(openSession)}
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
          devices={devices}
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
    contactPhone: primaryDevice.contactPhone ?? "",
    desktopName: primaryDevice.desktopName,
    deviceName: initialDeviceType.value,
    installLocation: primaryDevice.installLocation ?? "",
    notes: primaryDevice.notes ?? "",
    storeName: primaryDevice.storeName,
    tagText: primaryDevice.tags?.join(", ") ?? "",
  });
  const [deviceTypeChoice, setDeviceTypeChoice] = useState<DeviceTypeChoice>(initialDeviceType.choice);
  const [isSaving, setIsSaving] = useState(false);
  const [saveError, setSaveError] = useState("");
  const [isDeleting, setIsDeleting] = useState(false);
  const [isDeleteArmed, setIsDeleteArmed] = useState(false);
  const [updateRing, setUpdateRing] = useState<DeviceUpdateRing>(primaryDevice.updateRing ?? "general");
  const [updatePaused, setUpdatePaused] = useState(primaryDevice.updatePaused ?? false);

  useEffect(() => {
    const nextDeviceType = resolveDeviceTypeEditor(primaryDevice.deviceName);
    setForm({
      businessNumber: primaryDevice.businessNumber,
      contactName: primaryDevice.contactName ?? "",
      contactPhone: primaryDevice.contactPhone ?? "",
      desktopName: primaryDevice.desktopName,
      deviceName: nextDeviceType.value,
      installLocation: primaryDevice.installLocation ?? "",
      notes: primaryDevice.notes ?? "",
      storeName: primaryDevice.storeName,
      tagText: primaryDevice.tags?.join(", ") ?? "",
    });
    setDeviceTypeChoice(nextDeviceType.choice);
    setSaveError("");
    setIsDeleteArmed(false);
    setUpdateRing(primaryDevice.updateRing ?? "general");
    setUpdatePaused(primaryDevice.updatePaused ?? false);
  }, [primaryDevice.id]);

  async function saveCurrentForm() {
    if (isSaving) {
      return;
    }
    setIsSaving(true);
    setSaveError("");
    try {
      const { tagText, ...metadata } = form;
      await onSave({
        ...metadata,
        tags: tagText.split(",").map((tag) => tag.trim()).filter(Boolean),
      });
      if (isViewerFirebaseEnabled()) {
        await Promise.all(target.devices.map((device) => onSaveRollout(device.id, updateRing, updatePaused)));
      }
      onClose();
    } catch (error) {
      setSaveError(error instanceof Error ? error.message : "장비 정보 수정 실패");
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

  function focusEditorControl(event: React.PointerEvent<HTMLFormElement>) {
    if (event.button !== 0) {
      return;
    }
    const control = event.target;
    if (
      (control instanceof HTMLInputElement
        || control instanceof HTMLSelectElement
        || control instanceof HTMLTextAreaElement)
      && !control.disabled
    ) {
      control.focus({ preventScroll: true });
    }
  }

  function openSelectFromPrimaryPointer(event: React.PointerEvent<HTMLSelectElement>) {
    if (event.button !== 0) {
      return;
    }
    event.currentTarget.focus({ preventScroll: true });
    if (typeof event.currentTarget.showPicker !== "function") {
      return;
    }
    try {
      event.currentTarget.showPicker();
      event.preventDefault();
    } catch {
      // Keep the browser's normal click behavior when the native picker is unavailable.
    }
  }

  return (
    <div className="modal-backdrop device-editor-backdrop" role="presentation" onMouseDown={onClose}>
      <form
        className="modal-panel"
        role="dialog"
        aria-modal="true"
        aria-label="등록 장비 수정"
        onKeyDown={(event) => event.stopPropagation()}
        onKeyUp={(event) => event.stopPropagation()}
        onMouseDown={(event) => event.stopPropagation()}
        onPointerDown={(event) => event.stopPropagation()}
        onPointerDownCapture={focusEditorControl}
        onSubmit={handleSubmit}
      >
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
                  onPointerDown={openSelectFromPrimaryPointer}
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
                  maxLength={255}
                  value={form.desktopName}
                  onChange={(event) => setForm((prev) => ({ ...prev, desktopName: event.target.value }))}
                  placeholder="데스크탑명"
                />
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
                연락처
                <input type="tel" maxLength={40} value={form.contactPhone}
                  onChange={event => setForm(prev => ({ ...prev, contactPhone: event.target.value }))} />
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
                <select value={updateRing} onPointerDown={openSelectFromPrimaryPointer} onChange={(event) => setUpdateRing(event.target.value as DeviceUpdateRing)}>
                  <option value="canary">Canary</option>
                  <option value="pilot">Pilot</option>
                  <option value="general">General</option>
                </select>
              </label>
              <label className="toggle-field">
                <input type="checkbox" checked={updatePaused} onChange={(event) => setUpdatePaused(event.target.checked)} />
                {isGroupEdit ? "선택 장비 업데이트 일시 중지" : "이 장비 업데이트 일시 중지"}
              </label>
              {!isGroupEdit && primaryDevice.platform !== "android" && primaryDevice.version && primaryDevice.rollbackSupportVersion === primaryDevice.version && (
                <ViewerRollbackControl currentVersion={primaryDevice.version} agentName={primaryDevice.desktopName} restore={async version => {
                  await requestFirebaseAgentRollback(primaryDevice.id, version);
                  setUpdatePaused(true);
                }} />
              )}
            </>
          )}
        </div>
        {saveError && <p className="error-text" role="alert">{saveError}</p>}
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
  devices,
  initial,
  isSaving,
  onClose,
  onSave,
}: {
  devices: ManagedDevice[];
  initial: UpdateFleetRollout;
  isSaving: boolean;
  onClose: () => void;
  onSave: (rollout: UpdateFleetRollout) => Promise<void>;
}) {
  useModalEscape(onClose);
  const [draft, setDraft] = useState(initial);
  const recipients = devices.map((device) => ({ device, decision: decideUpdateEligibility(device, draft) }));
  const visibleDeviceIds = new Set(devices.map(device => device.id));
  const unlistedTargetIds = draft.targetDeviceIds?.filter(id => !visibleDeviceIds.has(id)) ?? [];
  const reasonLabels = {
    eligible: "업데이트 대상",
    "missing-rollout-policy": "업데이트 정책 없음",
    paused: "업데이트 중지",
    "missing-device-id": "장비 ID 없음",
    "missing-target-version": "대상 버전 없음",
    "already-current": "대상 버전 사용 중",
    "ring-not-enabled": "배포 단계 제외",
    "outside-percentage": "배포 비율 제외",
    "not-selected": "선택하지 않은 PC",
    "invalid-selection-policy": "선택 배포 설정 오류",
    "selection-support-unknown": "선택 배포 지원 미확인",
  };
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
        <label className="toggle-field">
          <input type="checkbox" checked={draft.targetDeviceIds !== undefined} onChange={event => setDraft(event.target.checked
            ? {...draft, targetDeviceIds: [], stage: "general", percentage: 0}
            : {...draft, targetDeviceIds: undefined, paused: true, percentage: 0})}/>
          선택한 PC에만 배포
        </label>
        <div className="rollout-stage" role="group" aria-label="배포 단계">
          {(["canary", "pilot", "general"] as const).map((stage) => (
            <button disabled={draft.targetDeviceIds !== undefined} className={draft.stage === stage ? "active" : ""} key={stage} type="button" onClick={() => setDraft({ ...draft, stage })}>
              {stage === "canary" ? "Canary" : stage === "pilot" ? "Pilot" : "General"}
            </button>
          ))}
        </div>
        <label className="range-field">
          <span>단계 내 배포 비율 <strong>{draft.percentage ?? 100}%</strong></span>
          <input disabled={draft.targetDeviceIds !== undefined} type="range" min="0" max="100" step="5" value={draft.percentage ?? 100} onChange={(event) => setDraft({ ...draft, percentage: Number(event.target.value) })} />
        </label>
        <label className="toggle-field rollout-pause">
          <input type="checkbox" checked={draft.paused === true} onChange={(event) => setDraft({ ...draft, paused: event.target.checked })} />
          전체 업데이트 일시 중지
        </label>
        <section aria-label="배포 대상 미리보기" className="rollout-recipients">
          <strong>현재 목록 {devices.length}대 중 대상 {recipients.filter(({ decision }) => decision.eligible).length}대</strong>
          {draft.targetDeviceIds !== undefined && <p>선택 ID 총 {draft.targetDeviceIds.length}개 · 현재 목록 밖 {unlistedTargetIds.length}개</p>}
          <ul>
            {recipients.map(({ device, decision }) => <li key={device.id}>
              {draft.targetDeviceIds !== undefined && <input type="checkbox" aria-label={`${device.desktopName} 배포 대상`}
                checked={draft.targetDeviceIds.includes(device.id)}
                disabled={!draft.targetDeviceIds.includes(device.id) && draft.targetDeviceIds.length >= 200}
                onChange={event => setDraft({...draft, targetDeviceIds: event.target.checked
                  ? [...(draft.targetDeviceIds ?? []), device.id] : draft.targetDeviceIds?.filter(id => id !== device.id)})}/>}
              <span>{device.desktopName} · {device.storeName}</span>
              <span>{device.version ?? "버전 미확인"} → {draft.targetVersion || "미지정"}</span>
              <span>{reasonLabels[decision.reason]}</span>
            </li>)}
          </ul>
          {unlistedTargetIds.length > 0 && <section aria-label="현재 목록 밖 배포 대상">
            <strong>현재 목록 밖 대상 · 장비 정보 미확인</strong>
            <ul>{unlistedTargetIds.map(id => <li key={id}>
              <span style={{overflowWrap:"anywhere",minWidth:0}}>{id}</span>
              <button type="button" title={`${id} 배포 대상 제외`} aria-label={`${id} 배포 대상 제외`}
                onClick={() => setDraft({...draft,targetDeviceIds:draft.targetDeviceIds?.filter(target => target !== id)})}>
                <X size={16}/>
              </button>
            </li>)}</ul>
          </section>}
          <p>{draft.targetDeviceIds !== undefined ? "선택 배포를 지원하는 에이전트만 적용됩니다. 구버전은 제외됩니다." : "이 정책은 현재 목록 밖의 장비에도 적용됩니다."}</p>
        </section>
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

function ConnectionHistorySection({ devices, history, onHistory }: {
  devices: ManagedDevice[];
  history: ConnectionHistoryEntry[];
  onHistory: (entries: ConnectionHistoryEntry[]) => void;
}) {
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
      .then((entries) => { if (active) onHistory(entries); })
      .catch((error) => { if (active) setHistoryError(error instanceof Error ? error.message : String(error)); })
      .finally(() => { if (active) setIsRefreshing(false); });
    return () => { active = false; };
  }, [refreshKey, onHistory]);

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
                <strong title={registeredConfig.apiUrl}>{registeredConfig.apiUrl}</strong>
              </div>
              <div>
                <span>등록 장비 ID:</span>
                <strong title={registeredConfig.registeredDeviceId}>{registeredConfig.registeredDeviceId}</strong>
              </div>
              <div>
                <span>사업자번호:</span>
                <strong>{registeredConfig.businessNumber}</strong>
              </div>
              <div>
                <span>설치 식별자:</span>
                <code title={registeredConfig.installId}>{registeredConfig.installId}</code>
              </div>
            </div>
            <p className="agent-status-copy">
              원격 제어 대기 중 · 트레이에서 관리
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
  activeDeviceIds,
  devices,
  connectionHistory,
  observedConnections,
  favoriteDeviceIds,
  onConnect,
  onDiagnostics,
  onEdit,
  onSecureConnect,
  onToggleFavorite,
  onToggleSelected,
  onWake,
  onRequestUpdate,
  onRefresh,
  isRefreshing,
  selectedDeviceIds,
}: {
  activeDeviceIds: string[];
  devices: ManagedDevice[];
  connectionHistory: ConnectionHistoryEntry[];
  observedConnections: Record<string, string>;
  favoriteDeviceIds: string[];
  onConnect: (device: ManagedDevice) => void | Promise<void>;
  onDiagnostics: (device: ManagedDevice) => void;
  onEdit: (device: ManagedDevice) => void;
  onSecureConnect: (device: ManagedDevice) => void | Promise<void>;
  onToggleFavorite: (deviceId: string) => void;
  onToggleSelected: (deviceId: string) => void;
  onWake: (device: ManagedDevice) => void | Promise<void>;
  onRequestUpdate: (device: ManagedDevice) => void | Promise<void>;
  onRefresh: () => void | Promise<void>;
  isRefreshing: boolean;
  selectedDeviceIds: string[];
}) {
  const recentConnections = useMemo(() => {
    const latest = new Map<string, string>(Object.entries(observedConnections));
    for (const entry of connectionHistory) {
      const timestamp = Date.parse(entry.startedAt);
      if ((entry.status !== "success" && entry.status !== "closed") || !Number.isFinite(timestamp)) continue;
      const previous = latest.get(entry.deviceId);
      if (!previous || timestamp > Date.parse(previous)) latest.set(entry.deviceId, entry.startedAt);
    }
    return latest;
  }, [connectionHistory, observedConnections]);
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
              draggable
              onDragStart={(event) => {
                event.dataTransfer.setData(DEVICE_DRAG_TYPE, device.id);
                event.dataTransfer.effectAllowed = "move";
              }}
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
                {device.contactPhone && <small className="device-contact-phone">{device.contactPhone}</small>}
                {(device.contactName || device.installLocation) && (
                  <small className="device-operations-summary">
                    {[device.contactName, device.installLocation].filter(Boolean).join(" · ")}
                  </small>
                )}
                {recentConnections.has(device.id) && <small className="device-recent-connection">
                  최근 접속 <time dateTime={recentConnections.get(device.id)}>{new Date(recentConnections.get(device.id)!).toLocaleString()}</time>
                </small>}
                {device.notes && <details className="device-row-notes">
                  <summary>작업 메모</summary>
                  <p>{device.notes}</p>
                </details>}
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
                <button className="connect-button connect-icon" type="button" title="에이전트 업데이트 요청" aria-label="에이전트 업데이트 요청" onClick={() => onRequestUpdate(device)}><RefreshCw size={16} /></button>
                <span className={`version-badge ${updateInfo.kind}`}>{updateInfo.label}</span>
                {device.updateError && <small>{device.updateError}</small>}
                {device.controlDiagnostics && (
                  <small>{device.controlDiagnostics.elevated ? "관리자 권한" : "사용자 권한"}</small>
                )}
              </span>
              <span className="device-system-cell" title={systemSummary}>{systemSummary}</span>
              <span className="device-actions">
                <button
                  className={activeDeviceIds.includes(device.id) ? "connect-button connect-icon active" : "connect-button connect-icon"}
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
  const [reportPreview, setReportPreview] = useState<string | null>(null);
  const saveReport = () => {
    if (!reportPreview) return;
    const nativeUrl = nativeDiagnosticExportUrl(reportPreview, navigator.userAgent);
    if (nativeUrl) { window.location.assign(nativeUrl); return; }
    const url = URL.createObjectURL(new Blob([reportPreview], { type: "application/json" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = "wonremote-diagnostics.json";
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
  };
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
        {reportPreview && <textarea aria-label="저장할 진단 내용" readOnly value={reportPreview} rows={10} />}
        <div className="modal-actions">
          <button className="secondary-button" type="button" onClick={() => setReportPreview(JSON.stringify(createDiagnosticReport(device, getViewerVersion(import.meta.env)), null, 2))}>진단 내보내기</button>
          {reportPreview && <button className="secondary-button" type="button" onClick={saveReport}>파일 저장</button>}
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

type RemoteKeyboardEvent = React.KeyboardEvent<HTMLElement> | KeyboardEvent;

function isKeyboardEventComposing(event: RemoteKeyboardEvent): boolean {
  return "nativeEvent" in event ? event.nativeEvent.isComposing : event.isComposing;
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
  inputSuspended,
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
  onShowDeviceList,
  onPicturePresented,
  onReconnect,
}: {
  activeSessionId: string | null;
  inputSuspended: boolean;
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
  onShowDeviceList: () => void;
  onPicturePresented: () => void;
  onReconnect: () => Promise<void>;
}) {
  const preferenceDeviceId = device?.id ?? session?.deviceId ?? "";
  const [preferenceSnapshot] = useState(() => {
    try {
      return { value: preferenceDeviceId ? window.localStorage.getItem(deviceViewPreferencesKey(preferenceDeviceId)) : null, failed: false };
    } catch {
      return { value: null, failed: true };
    }
  });
  const storedViewPreferences = preferenceSnapshot.value;
  const [preferenceSaveFailed, setPreferenceSaveFailed] = useState(preferenceSnapshot.failed);
  const initialViewPreferences = React.useRef(parseDeviceViewPreferences(storedViewPreferences)).current;
  const [mobileInputMode, setMobileInputMode] = useState(initialViewPreferences.inputMode ?? "screen");
  const panelRef = React.useRef<HTMLElement | null>(null);
  const incomingFilesRef = React.useRef(new IncomingFileAssembler());
  const reverseReceiverRef = React.useRef<PersistentFileReceiver | null>(null);
  const receivedFileRef = React.useRef<{ id: string; filename: string; blob: Blob } | null>(null);
  const [receivedFile, setReceivedFile] = useState<{ id: string; filename: string; blob: Blob } | null>(null);
  const [transferPanelOpen, setTransferPanelOpen] = useState(true);
  const [receivedDownloadRequested, setReceivedDownloadRequested] = useState(false);
  const [nativeSaveState, setNativeSaveState] = useState("");
  const [receivedSavedPath, setReceivedSavedPath] = useState("");
  const nativeSaveRef = React.useRef<AbortController | null>(null);
  const desktopDownloads = Boolean((window as any).__TAURI_INTERNALS__);
  const [downloadFolder, setDownloadFolder] = useState("");
  const autoSavedId = React.useRef<string | null>(null);
  async function saveReceivedDesktopFile(file: NonNullable<typeof receivedFile>) {
    if (nativeSaveRef.current) return;
    const controller = new AbortController();
    nativeSaveRef.current = controller;
    setNativeSaveState("검증 및 저장 중 · 99%");
    try {
      const savedPath = await saveDesktopFile(file, invoke, controller.signal);
      if (!controller.signal.aborted) {
        setReceivedSavedPath(savedPath);
        setNativeSaveState(`완료 · 100% · ${savedPath}`);
      }
      try {
        await reverseReceiverRef.current?.discard();
        receivedFileRef.current = null;
        if (!controller.signal.aborted) setReceivedDownloadRequested(true);
      } catch { if (!controller.signal.aborted) setSessionDataError("파일은 저장됐지만 수신 기록 정리에 실패했습니다. 수신 항목을 정리해 주세요."); }
    } catch (error) {
      if (!controller.signal.aborted) setNativeSaveState(`저장 실패 · ${error instanceof Error ? error.message : String(error)}`);
    } finally { if (nativeSaveRef.current === controller) nativeSaveRef.current = null; }
  }
  useEffect(() => { setNativeSaveState(""); setReceivedSavedPath(""); }, [receivedFile?.id]);
  useEffect(() => {
    if (!desktopDownloads || !receivedFile || autoSavedId.current === receivedFile.id) return;
    autoSavedId.current = receivedFile.id;
    void saveReceivedDesktopFile(receivedFile);
  }, [receivedFile?.id, desktopDownloads]);
  const [remoteFileStatus, setRemoteFileStatus] = useState("");
  const [reverseFileSupported, setReverseFileSupported] = useState(false);
  const [reverseResumeSupported, setReverseResumeSupported] = useState(false);
  const [interruptedFile, setInterruptedFile] = useState<{ transferId: string; filename: string; receivedBytes: number; totalBytes: number; receiving?: boolean } | null>(null);
  const incomingProgressRef = React.useRef<typeof interruptedFile>(null);
  const incomingStopIntentRef = React.useRef<"pause" | "cancel" | null>(null);
  const [incomingStopPending, setIncomingStopPending] = useState<"pause" | "cancel" | null>(null);
  const markReceiveInterrupted = () => {
    if (!incomingProgressRef.current) return;
    incomingProgressRef.current = { ...incomingProgressRef.current, receiving: false };
    setInterruptedFile(incomingProgressRef.current);
  };
  const getReverseReceiver = () => {
    if (!reverseReceiverRef.current) {
      const owner = getFirebaseViewerStorageOwner();
      if (!owner || !preferenceDeviceId) throw new Error("File storage owner is unavailable.");
      reverseReceiverRef.current = new PersistentFileReceiver(`wonremote-receive:${encodeURIComponent(owner)}:${encodeURIComponent(preferenceDeviceId)}`, async file => {
        const ready = { id: file.transferId, filename: file.filename, blob: file.blob };
        incomingProgressRef.current = null;
        incomingStopIntentRef.current = null;
        setIncomingStopPending(null);
        setSessionDataError(previous => previous === "파일을 수신하지 못했습니다. 저장 공간을 확인한 뒤 다시 시도해 주세요." ? "" : previous);
        setTransferPanelOpen(true);
        receivedFileRef.current = ready; setReceivedFile(ready); setInterruptedFile(null); setReceivedDownloadRequested(false);
      });
    }
    return reverseReceiverRef.current;
  };
  useEffect(() => () => {
    nativeSaveRef.current?.abort();
    reverseReceiverRef.current?.close();
    reverseReceiverRef.current = null;
    receivedFileRef.current = null;
  }, [sessionId]);
  useEffect(() => () => incomingFilesRef.current.clear(), [sessionId]);
  const imeInputRef = React.useRef<HTMLTextAreaElement | null>(null);
  const mobileRemote = isMobileViewerPath(window.location.pathname);
  const [mobileToolsOpen, setMobileToolsOpen] = useState(false);
  useEffect(() => {
    if (!isActive || !isVisible) {
      setMobileToolsOpen(false);
    }
  }, [isActive, isVisible]);
  const mobileHeight = useMobileRemoteHeight(mobileRemote && isVisible);
  const portraitRemote = mobileRemote && mobileHeight !== undefined;
  const [mobilePan, setMobilePan] = useState({x: 0, y: 0});
  useEffect(() => { setMobilePan({x: 0, y: 0}); }, [portraitRemote, sessionId]);
  const imeComposingRef = React.useRef(false);
  const imeEnterCommittedRef = React.useRef(false);
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
  const [mobilePointer, setMobilePointer] = useState({ dx: 32768, dy: 32768 });
  const [mobileKeyboardEnabled, setMobileKeyboardEnabled] = useState(false);
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
  const [zoom, setZoom] = useState(mobileRemote ? 1 : initialViewPreferences.zoom);
  useEffect(() => {
    if (mobileRemote) {
      setZoom(1);
      setMobilePan({x: 0, y: 0});
      setMobilePointer({dx: 32768, dy: 32768});
      setMobileKeyboardEnabled(false);
      imeInputRef.current?.blur();
    }
  }, [mobileRemote, sessionId]);
  useEffect(() => {
    if (!mobileRemote || !canvasRef.current || !remotePreviewRef.current) return;
    const canvas = canvasRef.current, area = remotePreviewRef.current;
    const x = Math.max(0, (canvas.offsetWidth * zoom - area.clientWidth) / 2);
    const y = portraitRemote
      ? Math.max(0, canvas.offsetHeight * zoom - Math.max(1, area.clientHeight - 80))
      : Math.max(0, (canvas.offsetHeight * zoom - area.clientHeight) / 2);
    setMobilePan(point => ({
      x: Math.max(-x, Math.min(x, point.x)),
      y: Math.max(-y, Math.min(portraitRemote ? 0 : y, point.y)),
    }));
  }, [zoom, mobileHeight, mobileRemote, portraitRemote]);
  const [isSessionFullscreen, setIsSessionFullscreen] = useState(initialViewPreferences.fullscreen);
  const [isFullscreenToolbarOpen, setIsFullscreenToolbarOpen] = useState(false);
  const [isWebRtcConnectionReady, setIsWebRtcConnectionReady] = useState(false);
  const [picturePresented, setPicturePresented] = useState(false);
  const reportedPictureSessionRef = useRef<string | null>(null);
  useEffect(() => {
    if (!picturePresented || reportedPictureSessionRef.current === sessionId) return;
    reportedPictureSessionRef.current = sessionId;
    onPicturePresented();
  }, [picturePresented, sessionId, onPicturePresented]);
  const [pictureError, setPictureError] = useState(false);
  const [receiveError, setReceiveError] = useState(false);
  const [webRtcReconnectGeneration, setWebRtcReconnectGeneration] = useState(0);
  const [needsManualReconnect, setNeedsManualReconnect] = useState(false);
  const reconnectBusyRef = React.useRef(false);
  const [reconnectBusy, setReconnectBusy] = useState(false);
  const [reconnectError, setReconnectError] = useState("");
  async function reconnectSession() {
    if (reconnectBusyRef.current) return;
    reconnectBusyRef.current = true; setReconnectBusy(true); setReconnectError("");
    try { await onReconnect(); }
    catch (error) { setReconnectError(error instanceof Error ? error.message : "재접속 실패"); }
    finally { reconnectBusyRef.current = false; setReconnectBusy(false); }
  }
  const [rebootReconnectState, setRebootReconnectState] = useState<"idle" | "restarting" | "reconnecting">("idle");
  const rebootReconnectStateRef = React.useRef(rebootReconnectState);
  const connectionStatus = sessionConnectionStatus({
    restarting: rebootReconnectState === "restarting",
    reconnecting: rebootReconnectState === "reconnecting",
    disconnected: needsManualReconnect,
    transportReady: isWebRtcConnectionReady || !isViewerFirebaseEnabled(),
    picturePresented,
    pictureError,
    receiveError,
  });
  const remoteInputAvailable = isRemoteInputAvailable({
    active: isActive && !inputSuspended,
    visible: isVisible,
    sessionConnected: session?.state === "connected",
    disconnected: needsManualReconnect,
    firebaseEnabled: isViewerFirebaseEnabled(),
    transportReady: isWebRtcConnectionReady,
  });
  React.useEffect(() => {
    rebootReconnectStateRef.current = rebootReconnectState;
  }, [rebootReconnectState]);
  const [streamPerformanceMode, setStreamPerformanceMode] = useState<StreamPerformanceMode>(() =>
    initialViewPreferences.streamPerformanceMode ?? normalizeStreamPerformanceMode(window.localStorage.getItem("wonremote-stream-performance-mode")),
  );
  const [selectedDisplayIndex, setSelectedDisplayIndex] = useState(() => {
    if (storedViewPreferences) return initialViewPreferences.selectedDisplayIndex;
    const display = device?.displays?.find(item => item.index === device.activeDisplayIndex)
      ?? device?.displays?.find(item => item.primary)
      ?? device?.displays?.[0];
    return display?.index ?? device?.activeDisplayIndex ?? 0;
  });
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
  const pausedTransferIdsRef = React.useRef<Set<string>>(new Set());
  const resumeTransferIdsRef = React.useRef(new Map<string, string>());

  // Phase 3 states
  const mediaRecorderRef = React.useRef<MediaRecorder | null>(null);
  const recordedChunksRef = React.useRef<Blob[]>([]);
  const [isRecording, setIsRecording] = useState(false);
  const [chatMessages, setChatMessages] = useState<ChatMessage[]>([]);
  const [chatInput, setChatInput] = useState("");
  const [isChatOpen, setIsChatOpen] = useState(false);

  useEffect(() => {
    setIsFullscreenToolbarOpen(false);
    setIsWebRtcConnectionReady(false);
    setPicturePresented(false);
    lastDisplayCommandRef.current = null;
    if (initialViewPreferences.fullscreen) {
      void applySessionFullscreen(true);
    }
  }, [sessionId]);

  useEffect(() => {
    // A failed read is not an empty setting: preserve the unread stored value.
    if (!preferenceDeviceId || preferenceSnapshot.failed) return;
    try {
      window.localStorage.setItem(deviceViewPreferencesKey(preferenceDeviceId), JSON.stringify({
        clipboardSync: false,
        fullscreen: isSessionFullscreen,
        selectedDisplayIndex,
        zoom,
        streamPerformanceMode,
        inputMode: mobileInputMode,
      }));
      setPreferenceSaveFailed(false);
    } catch {
      setPreferenceSaveFailed(true);
    }
  }, [isSessionFullscreen, preferenceDeviceId, preferenceSnapshot.failed, selectedDisplayIndex, zoom, streamPerformanceMode, mobileInputMode]);

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

  function showDeviceList() {
    void releaseAllInputs();
    void applySessionFullscreen(false);
    onShowDeviceList();
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
  }, [sessionId]);

  const mapRemotePoint = (clientX: number, clientY: number, rect: DOMRect) =>
    mapCanvasPointToVirtualDesktopAbsolute(
      clientX,
      clientY,
      rect,
      device?.displays?.find((display) => display.index === selectedDisplayIndex),
      device?.displays,
    );
  const mobileDisplayCorner = (edge: number) => mapCanvasPointToVirtualDesktopAbsolute(
    edge, edge, {left: 0, top: 0, width: 1, height: 1},
    device?.displays?.find(display => display.index === selectedDisplayIndex), device?.displays,
  );
  const mobileDisplayStart = mobileDisplayCorner(0), mobileDisplayEnd = mobileDisplayCorner(1);
  const fileInputRef = React.useRef<HTMLInputElement | null>(null);
  const folderInputRef = React.useRef<HTMLInputElement | null>(null);

  useEffect(() => () => {
    transferAbortControllersRef.current.forEach((controller) => controller.abort());
    transferAbortControllersRef.current.clear();
  }, [sessionId]);

  useEffect(() => {
    if (!device?.displays?.length) return;
    if (device.displays.some((display) => display.index === selectedDisplayIndex)) {
      return;
    }
    const activeDisplay =
      device.displays.find((display) => display.index === device.activeDisplayIndex) ??
      device.displays.find((display) => display.primary) ??
      device.displays[0];
    setSelectedDisplayIndex(activeDisplay.index);
  }, [device?.activeDisplayIndex, device?.displays, selectedDisplayIndex]);

  useEffect(() => {
    if (!isWebRtcConnectionReady || lastDisplayCommandRef.current === selectedDisplayIndex) {
      return;
    }
    lastDisplayCommandRef.current = selectedDisplayIndex;
    onInputEvent(buildSwitchMonitorCommand(selectedDisplayIndex));
  }, [isWebRtcConnectionReady, onInputEvent, selectedDisplayIndex]);

  useEffect(() => {
    if (isActive && !inputSuspended && session?.state === "connected") {
      panelRef.current?.focus({ preventScroll: true });
    }
  }, [isActive, inputSuspended, session?.id, session?.state]);

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

        // 3. Files
        const files = data.files;
        if (files.length > 0) {
          for (const file of files) {
            if (!isCurrent()) return;
            let assembled;
            try { assembled = await incomingFilesRef.current.accept(file); }
            catch (error) {
              if (isCurrent()) setSessionDataError(error instanceof Error ? error.message : "원격 파일 수신 실패");
              continue;
            }
            if (!assembled || !isCurrent()) continue;
            const url = URL.createObjectURL(assembled.blob);
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
          if (receipt.status === "received") updateTransferQueueItem(receipt.transferId, completeFileTransfer);
          if (receipt.status === "failed") updateTransferQueueItem(receipt.transferId, item => failFileTransfer(item, receipt.error ?? "원격 PC 저장 실패"));
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
      { clipboard: false });
    return () => {
      active = false;
      unsubscribe();
    };
  }, [isActive, sessionId, session?.state, sessionDataRetry]);

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
    let hasPresentedBaseline = false;
    let baselineRevision = 0;
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

      if (data.tiles && data.tiles.length > 0) {
        const frameSequence = resolveFrameSequence(data);
        const revision = baselineRevision;
        let loadedCount = 0;
        for (const tile of data.tiles) {
          const img = new Image();
          img.onload = () => {
            if (active && revision === baselineRevision) {
              drawTileCells(ctx, img, tile, frameSequence, true);
              if (img.naturalWidth > 0 && Number(tile.w) > 0 && Number(tile.h) > 0) {
                setPicturePresented(true);
              }
            }
            loadedCount++;
            if (loadedCount === data.tiles!.length) {
              measurePresentedPing(ctx);
            }
          };
          img.onerror = () => { if (active && revision === baselineRevision) setPictureError(true); };
          img.src = `data:image/jpeg;base64,${tile.data}`;
        }
      }
    };

    const renderKeyframeAtomically = async (data: TileFrame) => {
      const canvas = canvasRef.current;
      const width = Number(data.width ?? 0);
      const height = Number(data.height ?? 0);
      const tiles = data.tiles ?? [];
      if (!active || !canvas) {
        return;
      }
      if (!hasCompleteTileCoverage(width, height, tiles)) { setPictureError(true); return; }
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
      if (decodedTiles.some(({ tile, img }) => !img || img.naturalWidth !== tile.w || img.naturalHeight !== tile.h)) {
        setPictureError(true);
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
            hasPresentedBaseline = true;
            baselineRevision++;
            if (decodedTiles.some(({ img }) => img && img.naturalWidth > 0)) {
              setPicturePresented(true);
              setPictureError(false);
            }
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
      const canvas = canvasRef.current;
      const needsBaseline = !hasPresentedBaseline ||
        (data.width !== undefined && data.width !== canvas?.width) ||
        (data.height !== undefined && data.height !== canvas?.height);
      // Legacy senders may omit keyframe; a resize still needs a complete picture.
      if (data.keyframe || (needsBaseline && (data.tiles?.length ?? 0) > 0)) {
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
        setPicturePresented(false);
        setPictureError(false);
        setReverseFileSupported(false);
        setReverseResumeSupported(false);
        setRemoteFileStatus("");
        webRtcTransport?.close();
        webRtcTransport = null;
        webRtcTransportRef.current = null;
        let failed = false;
        try {
          const transport = await startFirebaseViewerWebRtcTransport(sessionId, {
            onFrame: drawTileFrame,
            onReverseFileSupport: resumeSupported => { if (active) { setReverseFileSupported(true); setReverseResumeSupported(resumeSupported === true); } },
            onFileStatus: status => {
              if (!active) return;
              const labels = { selecting: "원격 PC에서 파일 선택 중", sending: "원격 파일 수신 중", complete: "전송 완료 · 검증 및 저장 중",
                cancelled: "원격 파일 가져오기 취소됨", "selection-failed": "원격 파일 선택 창을 열지 못했습니다. 로그인된 사용자 화면을 확인해 주세요.",
                "send-failed": "원격 파일을 가져오지 못했습니다. 연결과 저장 공간을 확인해 주세요." };
              if (status.state === "selecting" || status.state === "sending") {
                setTransferPanelOpen(true);
              }
              if (status.state === "cancelled") {
                const intent = incomingStopIntentRef.current;
                incomingStopIntentRef.current = null;
                setIncomingStopPending(null);
                if (intent === "cancel") {
                  setRemoteFileStatus("원격 파일 가져오기 취소됨");
                  void getReverseReceiver().discard().then(() => {
                    if (!active) return;
                    incomingProgressRef.current = null;
                    setInterruptedFile(null);
                  }).catch(() => {
                    if (active) setSessionDataError("취소한 수신 파일을 정리하지 못했습니다.");
                  });
                  return;
                }
                if (intent === "pause") {
                  setRemoteFileStatus("파일 수신 일시중단됨");
                  markReceiveInterrupted();
                  return;
                }
              }
              setRemoteFileStatus(labels[status.state]);
              if (status.state === "cancelled" || status.state === "send-failed" || status.state === "selection-failed") markReceiveInterrupted();
            },
            onFileChunk: async (chunk, isCurrent) => {
              if (!active || !isCurrent()) return null;
              if (/\bWonRemoteViewer\/1\b/.test(navigator.userAgent) && !androidFileExporter.available()) throw new Error("Android file destination is not available yet.");
              if (receivedFileRef.current && receivedFileRef.current.id !== chunk.transferId) {
                throw new Error("Save or discard the previous received file first.");
              }
              try {
                const ack = await getReverseReceiver().accept(chunk, () => active && isCurrent());
                if (ack && active && isCurrent() && ack.status !== "complete") {
                  setTransferPanelOpen(true);
                  const previous = incomingProgressRef.current;
                  const progress = { transferId: chunk.transferId, filename: chunk.filename, totalBytes: chunk.totalBytes, receivedBytes: ack.receivedBytes, receiving: true };
                  incomingProgressRef.current = progress;
                  const percent = (bytes: number, total: number) => Math.floor(bytes * 100 / Math.max(1, total));
                  if (!previous?.receiving || previous.transferId !== progress.transferId || percent(previous.receivedBytes, previous.totalBytes) !== percent(progress.receivedBytes, progress.totalBytes)) setInterruptedFile(progress);
                }
                return ack;
              } catch (error) {
                if (active && isCurrent()) { markReceiveInterrupted(); setRemoteFileStatus("파일 수신 중단됨"); setSessionDataError("파일을 수신하지 못했습니다. 저장 공간을 확인한 뒤 다시 시도해 주세요."); }
                throw error;
              }
            },
            onState: (state) => {
              if (!active) return;
              if (state === "webrtc-file-closed") { markReceiveInterrupted(); setReverseFileSupported(false); setReverseResumeSupported(false); }
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
              markReceiveInterrupted();
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

    let tileRequestSequence = 0;
    let latestTileResponse = 0;
    const pollTiles = async () => {
      if (!shouldPollTiles) {
        return;
      }
      const requestSequence = ++tileRequestSequence;
      try {
        const tileData = await fetchTiles(sessionId);
        if (!active || requestSequence < latestTileResponse) return;
        latestTileResponse = requestSequence;
        setReceiveError(false);
        drawTileFrame(tileData);
      } catch {
        if (!active || requestSequence < latestTileResponse) return;
        latestTileResponse = requestSequence;
        setReceiveError(true);
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
    const pointerId = activePointerIdRef.current;
    activePointerIdRef.current = null;
    const canvas = canvasRef.current;
    if (pointerId !== null && canvas?.hasPointerCapture(pointerId)) {
      canvas.releasePointerCapture(pointerId);
    }
    return Promise.allSettled(releaseTasks).then(() => undefined);
  };

  useEffect(() => {
    if (!remoteInputAvailable) {
      void releaseAllInputs();
      imeInputRef.current?.blur();
      panelRef.current?.blur();
    }
  }, [remoteInputAvailable]);

  const handlePanelBlur = (event: React.FocusEvent<HTMLElement>) => {
    const nextTarget = event.relatedTarget;
    if (nextTarget instanceof Node && event.currentTarget.contains(nextTarget)) {
      return;
    }
    releaseAllInputs();
  };

  const handleCanvasPointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!remoteInputAvailable) return;
    e.preventDefault();
    if (activePointerIdRef.current !== null && activePointerIdRef.current !== e.pointerId) {
      return;
    }
    const canvas = canvasRef.current;
    if (!canvas) return;

    const rect = canvas.getBoundingClientRect();
    const point = mapRemotePoint(e.clientX, e.clientY, rect);
    lastPointerPointRef.current = point;
    if (mobileRemote) setMobilePointer(point);
    const { dx, dy } = point;
    const button = pressTrackedMouseButton(pressedButtonsRef.current, e.button);
    if (button === null) {
      return;
    }
    activePointerIdRef.current = e.pointerId;
    e.currentTarget.setPointerCapture(e.pointerId);
    if (!mobileRemote) imeInputRef.current?.focus({ preventScroll: true });
    onInputEvent(buildMouseCommand("down", dx, dy, button));
  };

  const handleCanvasPointerUp = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!remoteInputAvailable) return;
    e.preventDefault();
    if (activePointerIdRef.current !== null && activePointerIdRef.current !== e.pointerId) {
      return;
    }
    const canvas = canvasRef.current;
    if (!canvas) return;

    const rect = canvas.getBoundingClientRect();
    const point = mapRemotePoint(e.clientX, e.clientY, rect);
    lastPointerPointRef.current = point;
    if (mobileRemote) setMobilePointer(point);
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
    if (!remoteInputAvailable) {
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
          if (mobileRemote) setMobilePointer(point);
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
    if (!remoteInputAvailable) {
      void releaseAllInputs();
      return;
    }
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
    if (!remoteInputAvailable) return;
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
    if (mobileRemote) setMobilePointer(point);
    const { dx, dy } = point;
    const delta = normalizeWheelDelta(e.deltaY);
    if (delta !== 0) {
      onInputEvent(buildMouseCommand("wheel", dx, dy, 0, delta));
    }
  };

  const commitImeBeforeRemoteKey = () => {
    if (!imeComposingRef.current || imeEnterCommittedRef.current) return;
    sendImeCompositionReplacement(imeInputRef.current?.value || imeCompositionValueRef.current);
    // Finalize before sending a modifier: late preedit replacement must not edit a selection.
    imeEnterCommittedRef.current = true;
    panelRef.current?.focus({ preventScroll: true });
    if (imeInputRef.current) {
      imeInputRef.current.value = "";
      imeInputRef.current.focus({ preventScroll: true });
    }
    imeComposingRef.current = false;
  };

  const handleKeyDown = async (event: RemoteKeyboardEvent) => {
    if (!remoteInputAvailable) {
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
      commitImeBeforeRemoteKey();
      for (const modifier of releaseTrackedModifierKeys(pressedKeysRef.current)) {
        onInputEvent(`key-up ${modifier}`);
      }
      imeInputRef.current?.focus({ preventScroll: true });
      return;
    }
    if (event.ctrlKey || event.altKey || event.metaKey
        || /^(Control|Alt|Meta)(Left|Right)$/.test(event.code)) {
      commitImeBeforeRemoteKey();
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

    const isLocalText = isRemoteTextInputKeystroke({
      key: event.key,
      code: event.code,
      ctrlKey: event.ctrlKey,
      altKey: event.altKey,
      metaKey: event.metaKey,
      shiftKey: event.shiftKey,
      isComposing: isKeyboardEventComposing(event) || event.keyCode === 229,
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
    if (event.code === "Enter" || event.code === "NumpadEnter") commitImeBeforeRemoteKey();
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

  const handleKeyUp = (event: RemoteKeyboardEvent) => {
    if (!remoteInputAvailable) {
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
    imeEnterCommittedRef.current = false;
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
    if (!isActive || imeEnterCommittedRef.current) {
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
    if (!imeEnterCommittedRef.current) sendImeCompositionReplacement(result.text);
    imeEnterCommittedRef.current = false;
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
    if (remoteInputAvailable && !mobileRemote) {
      imeInputRef.current?.focus({ preventScroll: true });
    }
  }, [remoteInputAvailable, sessionId, mobileRemote]);

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
  const isClipboardBusyRef = useRef(false);
  const clipboardRequestAbortRef = useRef<AbortController | null>(null);
  useEffect(() => {
    if (!isActive || !isVisible) {
      clipboardRequestAbortRef.current?.abort();
      clipboardRequestAbortRef.current = null;
      isClipboardBusyRef.current = false;
    }
    return () => {
      clipboardRequestAbortRef.current?.abort();
      clipboardRequestAbortRef.current = null;
      isClipboardBusyRef.current = false;
    };
  }, [isActive, isVisible, sessionId]);

  const handleSendClipboard = async () => {
    if (!isActive || !sessionId || isClipboardBusyRef.current) return;
    isClipboardBusyRef.current = true;
    try {
      const image = await readClipboardPngBlob().catch(() => null);
      if (activeSessionIdRef.current !== sessionId) return;
      if (image) {
        await sendClipboardImage(image);
        alert("클립보드 이미지를 원격 장비로 전송했습니다.");
        return;
      }
      const text = await navigator.clipboard.readText();
      if (activeSessionIdRef.current !== sessionId) return;
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
    } finally {
      isClipboardBusyRef.current = false;
    }
  };

  const handleFetchClipboard = async () => {
    if (!isActive || !sessionId || isClipboardBusyRef.current) return;
    isClipboardBusyRef.current = true;
    const controller = new AbortController();
    clipboardRequestAbortRef.current = controller;
    try {
      const text = await requestFreshClipboardText({
        request: () => onInputEvent("clipboard-request"),
        signal: controller.signal,
        subscribe: (onData, onError, onReady) => subscribeSessionData(
          sessionId,
          onData,
          onError,
          { chat: false, files: false },
          onReady,
        ),
      });
      if (controller.signal.aborted || activeSessionIdRef.current !== sessionId) return;
      await navigator.clipboard.writeText(text);
      alert(`클립보드 수신 완료: "${text}"`);
    } catch (err) {
      if (err instanceof DOMException && err.name === "AbortError") return;
      console.error("클립보드 수집 실패:", err);
      alert(err instanceof Error && err.message.includes("시간 초과")
        ? "원격 PC의 클립보드 응답 시간이 초과되었습니다. 다시 시도해 주세요."
        : "클립보드를 가져오지 못했습니다. 다시 시도해 주세요.");
    } finally {
      if (clipboardRequestAbortRef.current === controller) {
        clipboardRequestAbortRef.current = null;
        isClipboardBusyRef.current = false;
      }
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

  const transferSingleFile = async (file: File, transferId: string, resumeTransferId?: string) => {
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
            resume: resumeTransferId !== undefined,
            file,
            filename: remoteFilename,
            fileSha256,
            transferId: resumeTransferId ?? transferId,
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
        updateTransferQueueItem(transferId, awaitFileTransferReceipt);
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
      updateTransferQueueItem(transferId, awaitFileTransferReceipt);
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
    setTransferPanelOpen(true);
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
      if (pausedTransferIdsRef.current.has(item.id)) {
        updateTransferQueueItem(item.id, pauseFileTransfer);
        pausedTransferIdsRef.current.delete(item.id);
        continue;
      }
      try {
        await transferSingleFile(file, item.id);
      } catch (error) {
        if (error instanceof DOMException && error.name === "AbortError") {
          updateTransferQueueItem(
            item.id,
            pausedTransferIdsRef.current.has(item.id) ? pauseFileTransfer : cancelFileTransfer,
          );
        } else {
          updateTransferQueueItem(item.id, (entry) => failFileTransfer(
            entry,
            error instanceof Error ? error.message : String(error),
          ));
        }
      }
      transferAbortControllersRef.current.delete(item.id);
      cancelledTransferIdsRef.current.delete(item.id);
      pausedTransferIdsRef.current.delete(item.id);
    }
  };

  const clearActiveTransferProgress = (transferId: string) => {
    if (activeTransferIdRef.current !== transferId) return;
    activeTransferIdRef.current = "";
    setTransferProgress(null);
  };

  const pauseQueuedTransfer = (transferId: string) => {
    pausedTransferIdsRef.current.add(transferId);
    transferAbortControllersRef.current.get(transferId)?.abort();
    updateTransferQueueItem(transferId, pauseFileTransfer);
    clearActiveTransferProgress(transferId);
  };

  const cancelQueuedTransfer = (transferId: string) => {
    pausedTransferIdsRef.current.delete(transferId);
    cancelledTransferIdsRef.current.add(transferId);
    transferAbortControllersRef.current.get(transferId)?.abort();
    updateTransferQueueItem(transferId, cancelFileTransfer);
    clearActiveTransferProgress(transferId);
  };

  const retryQueuedTransfer = (transferId: string) => {
    if (transferAbortControllersRef.current.has(transferId)) return;
    const file = transferFilesRef.current.get(transferId);
    if (!file) return;
    pausedTransferIdsRef.current.delete(transferId);
    cancelledTransferIdsRef.current.delete(transferId);
    const retryId = `${transferId}-retry-${Date.now()}`;
    const resumeId = resumeTransferIdsRef.current.get(transferId) ?? transferId;
    resumeTransferIdsRef.current.set(retryId, resumeId);
    resumeTransferIdsRef.current.delete(transferId);
    transferFilesRef.current.set(retryId, file);
    transferFilesRef.current.delete(transferId);
    updateTransferQueueItem(transferId, () => createFileTransferQueueItem({
      id: retryId,
      fileName: file.name,
      totalBytes: file.size,
    }));
    void transferSingleFile(file, retryId, resumeId)
      .catch((error) => {
        if (error instanceof DOMException && error.name === "AbortError") {
          updateTransferQueueItem(
            retryId,
            pausedTransferIdsRef.current.has(retryId) ? pauseFileTransfer : cancelFileTransfer,
          );
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
        pausedTransferIdsRef.current.delete(retryId);
      });
  };

  const requestIncomingReceiveStop = (intent: "pause" | "cancel") => {
    if (!incomingProgressRef.current?.receiving || incomingStopIntentRef.current) return;
    const transport = webRtcTransportRef.current;
    incomingStopIntentRef.current = intent;
    setIncomingStopPending(intent);
    setRemoteFileStatus(intent === "pause" ? "파일 수신 일시중단 요청 중" : "파일 수신 취소 요청 중");
    if (!transport?.isControlReady() || !transport.sendControl("cancel-file-send")) {
      incomingStopIntentRef.current = null;
      setIncomingStopPending(null);
      setRemoteFileStatus(intent === "pause" ? "일시중단을 요청하지 못했습니다. 다시 시도해 주세요." : "취소를 요청하지 못했습니다. 다시 시도해 주세요.");
    }
  };

  const clearTerminalTransfers = () => {
    setTransferQueue((current) => {
      const retained = current.filter((item) => item.status === "queued" || item.status === "transferring" || item.status === "awaiting-receipt" || item.status === "paused");
      const retainedIds = new Set(retained.map((item) => item.id));
      for (const transferId of transferFilesRef.current.keys()) {
        if (!retainedIds.has(transferId)) {
          transferFilesRef.current.delete(transferId);
          resumeTransferIdsRef.current.delete(transferId);
          cancelledTransferIdsRef.current.delete(transferId);
          pausedTransferIdsRef.current.delete(transferId);
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
    setMobilePan({x: 0, y: 0});
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

  const hasTransferItems = transferQueue.length > 0 || Boolean(receivedFile) || Boolean(interruptedFile);

  return (
    <section
      ref={panelRef}
      className={`session-panel${mobileRemote ? " mobile-session" : ""}${isVisible ? "" : " session-panel-inactive"}${splitPanelClass}${isSessionFullscreen ? " session-fullscreen-active" : ""}${isSessionFullscreen && isFullscreenToolbarOpen ? " session-fullscreen-tools-open" : ""}${mobileToolsOpen ? " mobile-tools-open" : ""}`}
      style={mobileRemote && mobileHeight ? { height: mobileHeight, maxHeight: mobileHeight } : undefined}
      data-testid="remote-session-workspace"
      tabIndex={0}
      onBlur={handlePanelBlur}
      onFocusCapture={() => !isActive && onSelectSession(sessionId)}
      onKeyDown={handleKeyDown}
      onKeyUp={handleKeyUp}
      onPointerDownCapture={() => !isActive && onSelectSession(sessionId)}
    >
      {sessionTabsBar}
      {needsManualReconnect && isVisible && <div className="modal-backdrop" onKeyDown={event => event.stopPropagation()} onKeyUp={event => event.stopPropagation()}>
        <section className="modal-panel compact-modal" role="dialog" aria-modal="true" aria-label="원격 연결 끊김">
          <h2>원격 연결이 끊겼습니다</h2>
          <p>다른 기기에서 접속했거나 네트워크 연결이 종료됐습니다.</p>
          {reconnectError && <p role="alert">{reconnectError}</p>}
          <div className="button-row">
            <button type="button" className="secondary-button" onClick={onShowDeviceList}>장비 목록</button>
            <button type="button" className="primary-button" disabled={reconnectBusy} onClick={() => void reconnectSession()}><RotateCcw size={16} />{reconnectBusy ? "재접속 중" : "재접속"}</button>
          </div>
        </section>
      </div>}
      <textarea
        ref={imeInputRef}
        className="remote-ime-input"
        data-remote-ime-input="true"
        readOnly={!remoteInputAvailable || (mobileRemote && !mobileKeyboardEnabled)}
        inputMode={!remoteInputAvailable || (mobileRemote && !mobileKeyboardEnabled) ? "none" : "text"}
        onBlur={() => { if (mobileRemote) setMobileKeyboardEnabled(false); }}
        aria-label="원격 키보드 입력"
        autoCapitalize="off"
        autoCorrect="off"
        spellCheck={false}
        onCompositionStart={handleImeCompositionStart}
        onCompositionUpdate={handleImeCompositionUpdate}
        onCompositionEnd={handleImeCompositionEnd}
        onInput={handleImeInput}
      />
      <DesktopRemoteKeyboardRecovery
        enabled={remoteInputAvailable && !mobileRemote}
        imeInputRef={imeInputRef}
        isLocalControlTarget={isEditableTarget}
        onKeyDown={handleKeyDown}
        onKeyUp={handleKeyUp}
        panelRef={panelRef}
      />
      <div className="remote-work-area remote-canvas-viewport" data-testid="remote-canvas-viewport">
          <div className="remote-screen connected">
          <div
            ref={remotePreviewRef}
            className={`remote-preview${mobileRemote ? " mobile-width-fit-preview" : ""}${portraitRemote ? " portrait-remote-preview" : ""}`}
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
                transform: mobileRemote ? `translate(${mobilePan.x}px, ${mobilePan.y}px) scale(${zoom})` : `scale(${zoom})`,
                transformOrigin: portraitRemote ? "center top" : "center center",
              }}
            />
            {mobileRemote && <MobileRemoteGesturePad
              canvas={canvasRef} viewport={remotePreviewRef}
              pointer={{dx: (mobilePointer.dx-mobileDisplayStart.dx)/Math.max(1,mobileDisplayEnd.dx-mobileDisplayStart.dx)*65535,
                dy: (mobilePointer.dy-mobileDisplayStart.dy)/Math.max(1,mobileDisplayEnd.dy-mobileDisplayStart.dy)*65535}} portrait={portraitRemote}
              touchpad={mobileInputMode === "touchpad" && isVisible && isActive ? {
                move: (x, y) => {
                  const rect = canvasRef.current?.getBoundingClientRect();
                  if (!rect || rect.width <= 0 || rect.height <= 0) return;
                  const previous = lastPointerPointRef.current;
                  const point = {dx: Math.round(Math.max(mobileDisplayStart.dx, Math.min(mobileDisplayEnd.dx, previous.dx+x/rect.width*(mobileDisplayEnd.dx-mobileDisplayStart.dx)))),
                    dy: Math.round(Math.max(mobileDisplayStart.dy, Math.min(mobileDisplayEnd.dy, previous.dy+y/rect.height*(mobileDisplayEnd.dy-mobileDisplayStart.dy))))};
                  lastPointerPointRef.current = point;
                  setMobilePointer(point);
                  onInputEvent(buildMouseCommand("move", point.dx, point.dy, 0));
                },
                button: (down) => {
                  const previous = lastPointerPointRef.current;
                  const point = {dx: Math.max(mobileDisplayStart.dx, Math.min(mobileDisplayEnd.dx, previous.dx)),
                    dy: Math.max(mobileDisplayStart.dy, Math.min(mobileDisplayEnd.dy, previous.dy))};
                  lastPointerPointRef.current = point;
                  setMobilePointer(point);
                  onInputEvent(buildMouseCommand(down ? "down" : "up", point.dx, point.dy, 0));
                },
                scroll: (delta) => {
                  const point = lastPointerPointRef.current;
                  onInputEvent(buildMouseCommand("wheel", point.dx, point.dy, 0, Math.round(delta)));
                },
              } : undefined}
              revision={`${zoom}:${mobilePan.x}:${mobilePan.y}`}
              onGesture={(dx, dy, factor) => {
                const canvas = canvasRef.current;
                const area = remotePreviewRef.current;
                if (!canvas || !area) return;
                const nextZoom = Math.max(0.25, Math.min(8, zoom * factor));
                const limitX = Math.max(0, (canvas.offsetWidth * nextZoom - area.clientWidth) / 2);
                const limitY = portraitRemote
                  ? Math.max(0, canvas.offsetHeight * nextZoom - Math.max(1, area.clientHeight - 80))
                  : Math.max(0, (canvas.offsetHeight * nextZoom - area.clientHeight) / 2);
                setZoom(nextZoom);
                setMobilePan(point => ({
                  x: Math.max(-limitX, Math.min(limitX, point.x + dx)),
                  y: Math.max(-limitY, Math.min(portraitRemote ? 0 : limitY, point.y + dy)),
                }));
              }}
            />}
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

          {remoteFileStatus && <div className="session-transfer-progress" role="status">{remoteFileStatus}</div>}
          {hasTransferItems && !transferPanelOpen && (
            <button
              className="session-transfer-queue-open"
              type="button"
              title="파일 전송 목록 열기"
              aria-label="파일 전송 목록 열기"
              onClick={() => setTransferPanelOpen(true)}
            >
              <FileUp size={18} />
            </button>
          )}
          {hasTransferItems && transferPanelOpen && (
            <aside className="session-transfer-queue" aria-label="파일 전송 목록">
              <div className="session-transfer-queue-heading">
                <strong>파일 전송</strong>
                {desktopDownloads && <button type="button" title={downloadFolder || "기본 다운로드 폴더 설정"} aria-label="기본 다운로드 폴더 설정" onClick={async () => {
                  try { setDownloadFolder(await invoke<string>("choose_viewer_download_folder")); } catch (error) { setSessionDataError(String(error)); }
                }}><SlidersHorizontal size={16} /></button>}
                {desktopDownloads && (
                  <button type="button" title="내 PC 받은 폴더 열기" aria-label="내 PC 받은 폴더 열기"
                    onClick={() => void invoke("open_viewer_download_folder").catch(error => setSessionDataError(String(error)))}>
                    <FolderOpen size={16} />
                  </button>
                )}
                <button
                  type="button"
                  title="완료 항목 정리"
                  aria-label="완료 항목 정리"
                  onClick={clearTerminalTransfers}
                >
                  <Trash2 size={14} />
                </button>
                <button
                  type="button"
                  title="파일 전송 목록 닫기"
                  aria-label="파일 전송 목록 닫기"
                  onClick={() => setTransferPanelOpen(false)}
                >
                  <X size={16} />
                </button>
              </div>
              {interruptedFile && <div className={`session-transfer-queue-item ${interruptedFile.receiving ? "" : "failed"}`}>
                <span><strong>{interruptedFile.filename}</strong><small>{interruptedFile.receiving ? (incomingStopPending === "pause" ? "일시중단 요청 중" : incomingStopPending === "cancel" ? "취소 요청 중" : "수신 중") : "수신 중단됨"} · {Math.min(99, Math.floor(interruptedFile.receivedBytes * 100 / Math.max(1, interruptedFile.totalBytes)))}% · {interruptedFile.receivedBytes} / {interruptedFile.totalBytes} bytes</small>
                  <progress aria-label="파일 수신 진행률" max={interruptedFile.totalBytes || 1} value={interruptedFile.receivedBytes} />
                </span>
                {interruptedFile.receiving ? <button type="button" aria-label="파일 수신 일시중단" title="현재 수신을 멈추고 받은 위치부터 이어받기" disabled={incomingStopPending !== null} onClick={() => requestIncomingReceiveStop("pause")}><Pause size={16} /></button> : <button type="button" aria-label="중단된 수신 이어받기" title={reverseResumeSupported ? "원격 PC에서 원본 파일을 다시 선택하여 이어받기" : "에이전트의 이어받기 지원이 확인되지 않았습니다"}
                  disabled={!isWebRtcConnectionReady || !reverseResumeSupported || remoteFileStatus === "원격 PC에서 파일 선택 중" || remoteFileStatus === "원격 파일 수신 중"}
                  onClick={async () => {
                    setRemoteFileStatus("원격 PC에서 파일 선택 중");
                    setTransferPanelOpen(true);
                    try {
                      const transport = webRtcTransportRef.current;
                      if (!transport?.isControlReady() || !transport.sendControl(`request-file-resume ${interruptedFile.transferId}`)) throw new Error("File control channel unavailable");
                    }
                    catch { setRemoteFileStatus("이어받기를 요청하지 못했습니다. 다시 시도해 주세요."); }
                  }}><RotateCcw size={16} /></button>}
                <button type="button" aria-label={interruptedFile.receiving ? "파일 수신 취소" : "중단된 수신 삭제"} title={interruptedFile.receiving ? "수신을 취소하고 받은 데이터를 삭제" : "중단된 수신 삭제"} disabled={incomingStopPending !== null} onClick={async () => {
                  if (interruptedFile.receiving) { requestIncomingReceiveStop("cancel"); return; }
                  try { await getReverseReceiver().discard(); incomingProgressRef.current = null; setInterruptedFile(null); }
                  catch { setSessionDataError("수신 임시 파일을 삭제하지 못했습니다."); }
                }}>{interruptedFile.receiving ? <X size={16} /> : <Trash2 size={16} />}</button>
              </div>}
              {receivedFile && (
                <div className="session-transfer-queue-item completed">
                  <span><strong>{receivedFile.filename}</strong><small>{nativeSaveState || (receivedDownloadRequested ? "다운로드 요청됨" : "수신 완료 · 저장 대기")}</small></span>
                  {desktopDownloads ? (nativeSaveState.startsWith("저장 실패") ? (
                    <button type="button" title="파일 저장 다시 시도" aria-label="파일 저장 다시 시도" onClick={() => void saveReceivedDesktopFile(receivedFile)}>
                      <RotateCcw size={16} />
                    </button>
                  ) : (
                    <button type="button" title="다운로드 받은 파일 열기" aria-label="다운로드 받은 파일 열기" disabled={!receivedSavedPath} onClick={() => {
                      void invoke("open_viewer_download_file", { path: receivedSavedPath }).catch(error => setSessionDataError(String(error)));
                    }}><ExternalLink size={16} /></button>
                  )) : (
                  <button type="button" title="받은 파일 저장" aria-label="받은 파일 저장" disabled={nativeSaveState.includes("저장 중")} onClick={async () => {
                    if (/\bWonRemoteViewer\/1\b/.test(navigator.userAgent)) {
                      const controller = new AbortController();
                      nativeSaveRef.current = controller;
                      setNativeSaveState("저장 중");
                      try {
                        const saved = await androidFileExporter.save(receivedFile, controller.signal);
                        if (!controller.signal.aborted) setNativeSaveState(saved ? "파일 저장 완료" : "저장 취소됨");
                      } catch {
                        if (!controller.signal.aborted) setNativeSaveState("저장 실패 · 다시 시도하세요");
                      } finally { if (nativeSaveRef.current === controller) nativeSaveRef.current = null; }
                      return;
                    }
                    const url = URL.createObjectURL(receivedFile.blob);
                    const link = document.createElement("a");
                    link.href = url; link.download = receivedFile.filename;
                    document.body.appendChild(link); link.click(); link.remove();
                    window.setTimeout(() => URL.revokeObjectURL(url), 1_000);
                    setReceivedDownloadRequested(true);
                  }}><Download size={16} /></button>)}
                  <button type="button" title="수신 항목 정리" aria-label="수신 항목 정리" disabled={nativeSaveState.includes("저장 중")} onClick={async () => {
                    try {
                      await reverseReceiverRef.current?.discard();
                      receivedFileRef.current = null; setReceivedSavedPath(""); setReceivedFile(null);
                    } catch { setSessionDataError("수신 임시 파일을 삭제하지 못했습니다."); }
                  }}><Trash2 size={16} /></button>
                </div>
              )}
              {transferQueue.map((item) => {
                const percent = getFileTransferPercent(item);
                const eta = getFileTransferEtaSeconds(item);
                const statusLabel = item.status === "queued" ? "대기"
                  : item.status === "awaiting-receipt" ? "원격 저장 확인 중"
                  : item.status === "paused" ? `일시중단됨 · ${percent}%`
                  : item.status === "transferring" ? `${percent}%${eta === null ? "" : ` · ${eta}초`}`
                    : item.status === "completed" ? "완료"
                      : item.status === "cancelled" ? "취소됨" : "실패";
                return (
                  <div className={`session-transfer-queue-item ${item.status}`} key={item.id}>
                    <span><strong>{item.fileName}</strong><small>{statusLabel}</small>{item.error && <small>{item.error}</small>}</span>
                    <span className="session-transfer-progress-track" aria-hidden="true">
                      <span className="session-transfer-progress-fill" style={{ width: `${percent}%` }} />
                    </span>
                    {(item.status === "queued" || item.status === "transferring") && (
                      <>
                        <button type="button" aria-label="파일 전송 일시중단" title="현재 위치에서 일시중단" onClick={() => pauseQueuedTransfer(item.id)}><Pause size={16} /></button>
                        <button type="button" aria-label="파일 전송 취소" title="전송 취소" onClick={() => cancelQueuedTransfer(item.id)}><X size={16} /></button>
                      </>
                    )}
                    {item.status === "paused" && (
                      <button type="button" aria-label="파일 전송 이어받기" title="중단된 위치부터 이어받기" onClick={() => retryQueuedTransfer(item.id)}><RotateCcw size={16} /></button>
                    )}
                    {(item.status === "failed" || item.status === "cancelled") && (
                      <button type="button" aria-label="재시도" title="파일 전송 재시도" onClick={() => retryQueuedTransfer(item.id)}><RotateCcw size={16} /></button>
                    )}
                  </div>
                );
              })}
            </aside>
          )}

          {preferenceSaveFailed && (
            <div className="error-banner" role="status">
              기기 설정을 저장하지 못했습니다. 현재 연결에는 적용되지만 다음 접속에는 유지되지 않을 수 있습니다.
            </div>
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

       {mobileRemote && isVisible && isActive && <MobileRemoteControls
        key={sessionId}
        connectionStatus={connectionStatus}
        deviceName={device.desktopName}
        touchpad={mobileInputMode === "touchpad"}
        toggleTouchpad={() => setMobileInputMode(mode => mode === "screen" ? "touchpad" : "screen")}
        send={onInputEvent}
        click={(button) => {
          const { dx, dy } = lastPointerPointRef.current;
          onInputEvent(buildMouseCommand("down", dx, dy, button));
          onInputEvent(buildMouseCommand("up", dx, dy, button));
        }}
        scroll={(delta) => {
          const { dx, dy } = lastPointerPointRef.current;
          onInputEvent(buildMouseCommand("wheel", dx, dy, 0, delta));
        }}
        keyboard={() => {
          if (document.activeElement === imeInputRef.current) {
            imeInputRef.current?.blur();
          } else {
            if (portraitRemote) setFitZoom();
            setMobileKeyboardEnabled(true);
            // Enable synchronously within this gesture before WebView requests IME.
            if (imeInputRef.current) {
              imeInputRef.current.readOnly = false;
              imeInputRef.current.inputMode = "text";
            }
            imeInputRef.current?.focus({ preventScroll: true });
          }
        }}
        zoom={(delta) => setZoom((value) => Math.max(0.25, Math.min(8, Number((value + delta).toFixed(2)))))}
        settings={() => setMobileToolsOpen((open) => !open)}
        settingsOpen={mobileToolsOpen}
        closeSettings={() => setMobileToolsOpen(false)}
      />}

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

      {mobileRemote && mobileToolsOpen && <button className="mobile-tools-backdrop" type="button" aria-label="설정 패널 닫기" onClick={() => setMobileToolsOpen(false)} />}
      <div className="session-actions session-actions-top remote-command-bar" data-testid="remote-command-bar">
        {mobileRemote && <div className="mobile-tools-heading"><strong>화면 및 도구</strong><button type="button" aria-label="도구 닫기" onClick={() => setMobileToolsOpen(false)}><X size={20} /></button></div>}
        <div className="session-command-identity">
          <button
            className="session-back-button"
            type="button"
            aria-label="장비 목록"
            title="현재 세션을 유지하고 장비 목록 열기"
            onClick={showDeviceList}
          >
            <LayoutDashboard size={17} />
            <span>장비 목록</span>
          </button>
          <div className="session-device-context" data-testid="remote-connection-status" role="status" aria-live="polite">
            <span className="session-live-dot" aria-hidden="true" />
            <div>
              <strong>{device.desktopName}</strong>
              <small>
                {device.storeName} · {connectionStatus}
              </small>
            </div>
          </div>
        </div>

        <div className="session-display-controls" data-testid="display-mode-controls" role="group" aria-label="원격 화면 표시 설정">
          <button type="button" title="원격 연결 새로고침" aria-label="원격 연결 새로고침"
            disabled={reconnectBusy || (!needsManualReconnect && !pictureError && rebootReconnectState === "idle")}
            onClick={() => { if (needsManualReconnect) void reconnectSession(); else { setRebootReconnectState("idle"); setWebRtcReconnectGeneration((value) => value + 1); } }}>
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
          <button className="secondary-button" type="button" onClick={handleSendClipboard} title="클립보드 동기화: 내 PC → 원격 PC" aria-label="클립보드 동기화: 내 PC → 원격 PC">
            <Clipboard size={17} />
            {mobileRemote && <span>클립보드 보내기</span>}
          </button>
          <details className="session-tool-menu" data-testid="secondary-tools" open={mobileRemote ? mobileToolsOpen : undefined} onToggle={async event => {
            if (!event.currentTarget.open || !isViewerFirebaseEnabled()) return;
            try {
              const receiver = getReverseReceiver();
              const restored = await receiver.restore();
              if (reverseReceiverRef.current !== receiver || !restored) return;
              if (restored.blob) {
                const ready = { id: restored.transferId, filename: restored.filename, blob: restored.blob };
                receivedFileRef.current = ready; setReceivedFile(ready); setInterruptedFile(null);
              } else {
                const progress = { ...restored, receiving: incomingProgressRef.current?.receiving === true };
                incomingProgressRef.current = progress; setInterruptedFile(progress);
              }
            } catch { setSessionDataError("받은 파일 목록을 복원하지 못했습니다."); }
          }}>
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
                    <span>내 PC → 원격 PC</span>
                  </button>
                  <button className="secondary-button" type="button" onClick={handleFetchClipboard} title="에이전트 복사 텍스트 가져오기">
                    <Clipboard size={17} />
                    <span>원격 PC → 내 PC</span>
                  </button>
                  <button className="secondary-button" type="button" onClick={() => fileInputRef.current?.click()}>
                    <FileUp size={17} />
                    <span>{`파일 전송 (${remoteFileLimitLabel()})`}</span>
                  </button>
                  <input multiple type="file" ref={fileInputRef} onChange={handleFileUpload} style={{ display: "none" }} />
                  {device?.platform !== "android" && (!/\bWonRemoteViewer\/1\b/.test(navigator.userAgent) || androidFileExporter.available()) && (
                    <button className="secondary-button" type="button" disabled={!isWebRtcConnectionReady || !reverseFileSupported || (Boolean(receivedFile) && !receivedDownloadRequested)} onClick={() => { setTransferPanelOpen(true); onInputEvent("request-file-send"); }} title={reverseFileSupported ? "원격 PC에서 보낼 파일 선택" : "연결된 에이전트의 파일 가져오기 지원이 확인되지 않았습니다"}>
                      <Download size={17} /><span>원격 파일 가져오기</span>
                    </button>
                  )}
                  {desktopDownloads && <button className="secondary-button" type="button" title={downloadFolder || "내 PC 기본 다운로드 폴더 설정"} onClick={async () => {
                    try { setDownloadFolder(await invoke<string>("choose_viewer_download_folder")); }
                    catch (error) { setSessionDataError(String(error)); }
                  }}><FolderOpen size={17} /><span>다운로드 폴더 설정</span></button>}
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
