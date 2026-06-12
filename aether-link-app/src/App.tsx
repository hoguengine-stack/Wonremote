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
} from "lucide-react";
import React, { FormEvent, useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import {
  closeSession,
  connectAgent,
  connectByCode,
  fetchDevices,
  loginAdmin,
  openSession,
  recordInput,
  registerFirstRunAgent,
  fetchSessionStatus,
  sendChatMessage,
  fetchChatMessages,
  sendClipboardText,
  fetchClipboardText,
  uploadFile,
  fetchFiles,
  fetchConnectionHistory,
} from "./api/viewerApi";
import { isViewerFirebaseEnabled, subscribeFirebaseDevices } from "./firebase/viewerFirebase";
import { groupDevicesByStore } from "./domain/agentRegistry";
import {
  scheduleVisualPingPresentedMeasurement,
} from "./domain/visualPing";
import { getViewerVersion } from "./domain/versioning";
import { shouldNotifyUpdate, shouldReloadViewerForUpdate } from "./domain/updatePolicy";
import type {
  AgentConnectionInput,
  ManagedDevice,
  RemoteSession,
  ChatMessage,
  ClipboardData,
  TransferredFile,
  ConnectionHistoryEntry,
} from "./domain/types";

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

const emptyAgentForm: AgentConnectionInput = {
  businessNumber: "",
  password: "",
  storeName: "",
  deviceNumber: "",
  deviceName: "",
};

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
  const [loginError, setLoginError] = useState("");
  const [devices, setDevices] = useState<ManagedDevice[]>([]);
  const [session, setSession] = useState<RemoteSession | null>(null);
  const [agentForm, setAgentForm] = useState<AgentConnectionInput>(emptyAgentForm);
  const [agentError, setAgentError] = useState("");
  const [apiError, setApiError] = useState("");
  const [query, setQuery] = useState("");
  const [selectedStore, setSelectedStore] = useState("전체");
  const [inputLog, setInputLog] = useState<string[]>([]);
  const [updateAlert, setUpdateAlert] = useState<string | null>(null);

  // Viewer auto update check loop
  useEffect(() => {
    if (!isAuthenticated) return;
    const currentViewerVersion = getViewerVersion(import.meta.env);
    let active = true;

    const checkViewerUpdate = async () => {
      try {
        const response = await fetch("http://127.0.0.1:8787/api/update/check");
        if (!response.ok) return;
        const data = await response.json();

        if (active && shouldNotifyUpdate(data, currentViewerVersion)) {
          setUpdateAlert(data.latestVersion);
          if (shouldReloadViewerForUpdate(data, currentViewerVersion)) {
            setTimeout(() => {
              window.location.reload();
            }, 1500);
          }
        }
      } catch (e) {
        // ignore
      }
    };

    void checkViewerUpdate();
    const interval = setInterval(() => void checkViewerUpdate(), 4000);
    return () => {
      active = false;
      clearInterval(interval);
    };
  }, [isAuthenticated]);


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
          setInputLog((prev) => [`${new Date().toLocaleTimeString()} 접속 승인 완료`, ...prev]);
        }
      } catch (error) {
        if (active) {
          setSession(null);
          setInputLog((prev) => [`${new Date().toLocaleTimeString()} 접속 거절 또는 종료됨`, ...prev]);
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

  async function handleAgentConnect(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (agentForm.password.trim() !== "1234") {
      setAgentError("Agent 비밀번호가 올바르지 않습니다.");
      return;
    }

    try {
      const result = await connectAgent(agentForm);
      setDevices(result.devices);
      setSession(result.session);
      setInputLog(result.inputLog);
      setAgentError("");
      setApiError("");
    } catch (error) {
      setAgentError(error instanceof Error ? error.message : "Agent 접속 실패");
    }
  }

  async function handleConnectCodeConnect(code: string) {
    try {
      const result = await connectByCode(code);
      setSession(result.session);
      setInputLog(result.inputLog);
      setAgentError("");
      setApiError("");
    } catch (error) {
      setAgentError(error instanceof Error ? error.message : "접속 코드 연결 실패");
    }
  }

  async function markInput(action: string) {
    if (!session) {
      return;
    }
    try {
      setInputLog(await recordInput(session.id, action));
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
      setInputLog([]);
      setApiError("");
    } catch (error) {
      setApiError(error instanceof Error ? error.message : "세션 종료 실패");
    }
  }

  if (!isAuthenticated) {
    return <LoginScreen error={loginError} onSubmit={handleLogin} />;
  }

  return (
    <div className="app-shell">
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
          <div className="brand-mark">A</div>
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
            >
              <CircleDot size={16} />
              <span>{group.storeName}</span>
              <b>{group.devices.length}</b>
            </button>
          ))}
        </div>

        <button className="logout-button" type="button" onClick={() => setIsAuthenticated(false)}>
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
            <AgentConnectForm
              error={agentError}
              form={agentForm}
              onChange={setAgentForm}
              onSubmit={handleAgentConnect}
              onConnectCodeSubmit={handleConnectCodeConnect}
            />
            <DeviceTable
              devices={filteredDevices}
              activeDeviceId={session?.deviceId ?? ""}
              onConnect={async (device) => {
                try {
                  const result = await openSession(device.id);
                  setSession(result.session);
                  setInputLog(result.inputLog);
                  setApiError("");
                } catch (error) {
                  setApiError(error instanceof Error ? error.message : "세션 연결 실패");
                }
              }}
            />
            <ConnectionHistorySection />
          </section>

          <RemoteSessionPanel
            device={activeDevice}
            sessionId={session?.id ?? ""}
            session={session}
            inputLog={inputLog}
            onInputEvent={(action) => void markInput(action)}
            onCloseSession={handleCloseSession}
          />
        </section>
      </main>
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
  const [businessNumber, setBusinessNumber] = useState("");
  const [password, setPassword] = useState("");
  const [apiUrl, setApiUrl] = useState("http://127.0.0.1:8787");
  const [installId] = useState(getOrCreateAgentInstallId);
  const [registeredDevice, setRegisteredDevice] = useState<ManagedDevice | null>(null);
  const [registeredConfig, setRegisteredConfig] = useState<any | null>(null);
  const [error, setError] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);

  useEffect(() => {
    if ((window as any).__TAURI_INTERNALS__) {
      invoke<any>("get_agent_config").then((config: any) => {
        if (config && config.registeredDeviceId) {
          setRegisteredConfig(config);
        }
      });
    }
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
        apiUrl,
      });
      setRegisteredDevice(result.device);
      setError("");

      const configData = {
        businessNumber: result.device.businessNumber,
        installId,
        registeredDeviceId: result.device.id,
        version: getViewerVersion(import.meta.env),
        apiUrl,
      };

      if ((window as any).__TAURI_INTERNALS__) {
        await invoke("save_agent_config", {
          config: configData
        });
      } else {
        setRegisteredConfig(configData);
      }
    } catch (submissionError) {
      setError(submissionError instanceof Error ? submissionError.message : "Agent 등록 실패");
    } finally {
      setIsSubmitting(false);
    }
  }

  if (registeredConfig) {
    return (
      <main className="login-screen agent-screen">
        <div className="login-panel agent-panel" style={{ maxWidth: "450px" }}>
          <div className="login-badge" style={{ background: "rgba(16, 185, 129, 0.2)", color: "#10b981" }}>
            <Monitor size={20} />
            <span>Active Agent</span>
          </div>
          <h1>Agent 가동 중</h1>
          <div className="agent-result" style={{ background: "rgba(16, 185, 129, 0.1)", border: "1px solid rgba(16, 185, 129, 0.2)", padding: "16px", borderRadius: "8px", display: "flex", flexDirection: "column", gap: "8px", width: "100%", boxSizing: "border-box" }}>
            <div>
              <span style={{ color: "#94a3b8", fontSize: "12px" }}>서버 주소:</span>
              <strong style={{ display: "block", color: "#fff" }}>{registeredConfig.apiUrl}</strong>
            </div>
            <div>
              <span style={{ color: "#94a3b8", fontSize: "12px" }}>등록 장비 ID:</span>
              <strong style={{ display: "block", color: "#fff" }}>{registeredConfig.registeredDeviceId}</strong>
            </div>
            <div>
              <span style={{ color: "#94a3b8", fontSize: "12px" }}>사업자번호:</span>
              <strong style={{ display: "block", color: "#fff" }}>{registeredConfig.businessNumber}</strong>
            </div>
            <div>
              <span style={{ color: "#94a3b8", fontSize: "12px" }}>설치 식별자:</span>
              <code style={{ display: "block", color: "#818cf8", fontSize: "11px" }}>{registeredConfig.installId}</code>
            </div>
          </div>
          <p style={{ color: "#94a3b8", fontSize: "13px", textAlign: "center", margin: "16px 0" }}>
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
            style={{ background: "#10b981" }}
          >
            <span>에이전트 재시작</span>
          </button>
        </div>
      </main>
    );
  }

  return (
    <main className="login-screen agent-screen">
      <form className="login-panel agent-panel" onSubmit={handleFirstRun}>
        <div className="login-badge">
          <Monitor size={20} />
          <span>Agent</span>
        </div>
        <h1>Agent 최초 실행</h1>
        <label>
          서버 주소
          <input
            onChange={(event) => setApiUrl(event.target.value)}
            placeholder="http://127.0.0.1:8787"
            value={apiUrl}
          />
        </label>
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
        <button className="primary-button" disabled={isSubmitting} type="submit">
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

function AgentConnectForm({
  error,
  form,
  onChange,
  onSubmit,
  onConnectCodeSubmit,
}: {
  error: string;
  form: AgentConnectionInput;
  onChange: (next: AgentConnectionInput) => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
  onConnectCodeSubmit: (code: string) => void;
}) {
  const [activeTab, setActiveTab] = useState<"form" | "code">("form");
  const [connectCode, setConnectCode] = useState("");

  function update<K extends keyof AgentConnectionInput>(key: K, value: AgentConnectionInput[K]) {
    onChange({ ...form, [key]: value });
  }

  const handleCodeSubmit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    onConnectCodeSubmit(connectCode);
  };

  return (
    <div className="agent-form-container" style={{ display: "flex", flexDirection: "column", gap: "12px", background: "var(--card-bg, #1e1e2e)", padding: "16px", borderRadius: "8px", border: "1px solid var(--border-color, #2d2d3f)", marginBottom: "16px" }}>
      <div style={{ display: "flex", borderBottom: "1px solid #2d2d3f", paddingBottom: "8px", gap: "16px" }}>
        <button
          type="button"
          onClick={() => setActiveTab("form")}
          style={{
            background: "none",
            border: "none",
            color: activeTab === "form" ? "#818cf8" : "#94a3b8",
            fontWeight: "bold",
            cursor: "pointer",
            borderBottom: activeTab === "form" ? "2px solid #818cf8" : "none",
            paddingBottom: "4px"
          }}
        >
          계정 정보로 등록/접속
        </button>
        <button
          type="button"
          onClick={() => setActiveTab("code")}
          style={{
            background: "none",
            border: "none",
            color: activeTab === "code" ? "#818cf8" : "#94a3b8",
            fontWeight: "bold",
            cursor: "pointer",
            borderBottom: activeTab === "code" ? "2px solid #818cf8" : "none",
            paddingBottom: "4px"
          }}
        >
          접속 코드로 즉시 연결
        </button>
      </div>

      {activeTab === "form" ? (
        <form className="agent-form" onSubmit={onSubmit} style={{ padding: 0, border: "none", background: "none" }}>
          <div className="section-heading" style={{ margin: 0, paddingBottom: "12px" }}>
            <h2>계정 정보 입력</h2>
            <button className="primary-button compact" type="submit" title="접속">
              <PlugZap size={17} />
              <span>접속</span>
            </button>
          </div>
          <div className="form-grid">
            <label>
              사업자번호 <input
                value={form.businessNumber}
                onChange={(event) => update("businessNumber", event.target.value)}
                placeholder="000-00-00000"
              />
            </label>
            <label>
              Agent 비밀번호
              <input
                value={form.password}
                onChange={(event) => update("password", event.target.value)}
                type="password"
              />
            </label>
            <label>
              업장명 <input value={form.storeName} onChange={(event) => update("storeName", event.target.value)} />
            </label>
            <label>
              장비 번호
              <input
                value={form.deviceNumber}
                onChange={(event) => update("deviceNumber", event.target.value)}
              />
            </label>
            <label className="wide-field">
              장비명 <input value={form.deviceName} onChange={(event) => update("deviceName", event.target.value)} />
            </label>
          </div>
          {error && <p className="error-text">{error}</p>}
        </form>
      ) : (
        <form onSubmit={handleCodeSubmit} style={{ display: "flex", flexDirection: "column", gap: "12px" }}>
          <div className="section-heading" style={{ margin: 0, paddingBottom: "12px" }}>
            <h2>접속 코드 입력</h2>
            <button className="primary-button compact" type="submit" title="연결">
              <PlugZap size={17} />
              <span>연결</span>
            </button>
          </div>
          <label style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
            6자리 접속 코드
            <input
              value={connectCode}
              onChange={(event) => setConnectCode(event.target.value)}
              placeholder="384 102"
              style={{
                fontSize: "18px",
                textAlign: "center",
                fontWeight: "bold",
                letterSpacing: "2px",
                padding: "10px",
                borderRadius: "6px",
                border: "1px solid #2d2d3f",
                background: "#0f0f1a",
                color: "#fff"
              }}
            />
          </label>
          {error && <p className="error-text">{error}</p>}
        </form>
      )}
    </div>
  );
}

function DeviceTable({
  activeDeviceId,
  devices,
  onConnect,
}: {
  activeDeviceId: string;
  devices: ManagedDevice[];
  onConnect: (device: ManagedDevice) => void;
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
        {devices.map((device) => (
          <div className="table-row" key={device.id}>
            <span className="status-pill">{device.status}</span>
            <span>{device.storeName}</span>
            <span>
              <b>{device.deviceNumber}</b>
              <small>{device.deviceName}</small>
            </span>
            <span>{device.desktopName}</span>
            <button
              className={activeDeviceId === device.id ? "icon-button active" : "icon-button"}
              type="button"
              title="접속"
              onClick={() => onConnect(device)}
            >
              <PlugZap size={16} />
            </button>
          </div>
        ))}
        {devices.length === 0 && <div className="empty-row">등록된 장비가 없습니다.</div>}
      </div>
    </section>
  );
}

function RemoteSessionPanel({
  device,
  sessionId,
  session,
  inputLog,
  onInputEvent,
  onCloseSession,
}: {
  device: ManagedDevice | null;
  sessionId: string;
  session: RemoteSession | null;
  inputLog: string[];
  onInputEvent: (action: string) => void;
  onCloseSession: () => void;
}) {
  const canvasRef = React.useRef<HTMLCanvasElement | null>(null);
  const [latencyReport, setLatencyReport] = useState<string>("");
  const [pingState, setPingState] = useState<{ start: number } | null>(null);

  // Phase 3 states
  const mediaRecorderRef = React.useRef<MediaRecorder | null>(null);
  const recordedChunksRef = React.useRef<Blob[]>([]);
  const [isRecording, setIsRecording] = useState(false);
  const [chatMessages, setChatMessages] = useState<ChatMessage[]>([]);
  const [chatInput, setChatInput] = useState("");
  const [isClipboardSyncOn, setIsClipboardSyncOn] = useState(false);
  const [isChatOpen, setIsChatOpen] = useState(false);
  const fileInputRef = React.useRef<HTMLInputElement | null>(null);

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
      } catch (e) {
        // ignore
      }
    };

    const intervalId = setInterval(() => void pollData(), 1500);
    return () => {
      active = false;
      clearInterval(intervalId);
    };
  }, [device, sessionId, session, isClipboardSyncOn]);

  // Stream Frame drawing
  useEffect(() => {
    if (!device || !sessionId || !session || session.state !== "connected") {
      return;
    }

    let active = true;
    const pollTiles = async () => {
      try {
        const response = await fetch(`http://127.0.0.1:8787/api/sessions/${sessionId}/tiles`);
        if (!response.ok) return;
        const data = await response.json();

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
          let loadedCount = 0;
          for (const tile of data.tiles) {
            const img = new Image();
            img.onload = () => {
              if (active) {
                ctx.drawImage(img, tile.x * 32, tile.y * 32, tile.w, tile.h);
              }
              loadedCount++;

              if (loadedCount === data.tiles.length) {
                if (pingState) {
                  scheduleVisualPingPresentedMeasurement({
                    requestAnimationFrame: (callback) =>
                      requestAnimationFrame(() => {
                        if (active) {
                          callback();
                        }
                      }),
                    startedAtMs: pingState.start,
                    readPixel: () => {
                      const imgData = ctx.getImageData(5, 5, 1, 1).data;
                      return { r: imgData[0], g: imgData[1], b: imgData[2] };
                    },
                    nowMs: () => performance.now(),
                    onPresented: ({ latencyMs, sleepCommand }) => {
                      if (!active) return;
                      setLatencyReport(`E2E Latency: ${latencyMs.toFixed(1)}ms`);
                      setPingState(null);

                      if (sleepCommand === "set-sleep 100") {
                        console.log(`Latency ${latencyMs.toFixed(1)}ms > 150ms. Switching to low FPS (sleep 100ms)`);
                      }
                      onInputEvent(sleepCommand);
                    },
                  });
                }
              }
            };
            img.src = `data:image/jpeg;base64,${tile.data}`;
          }
        }
      } catch (e) {
        // ignore
      }
    };

    void pollTiles();

    const intervalId = setInterval(() => {
      void pollTiles();
    }, 100);

    return () => {
      active = false;
      clearInterval(intervalId);
    };
  }, [device, sessionId, pingState, session]);

  const handleCanvasClick = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const rect = canvas.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;

    const dx = Math.floor((x / rect.width) * 65535);
    const dy = Math.floor((y / rect.height) * 65535);

    onInputEvent(`click ${dx} ${dy}`);
  };

  const startVisualPing = () => {
    setPingState({ start: performance.now() });
    onInputEvent("ping-color-change");
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
      const text = await navigator.clipboard.readText();
      if (text && sessionId) {
        await sendClipboardText(sessionId, text, "viewer");
        alert("클립보드 텍스트가 에이전트로 전송되었습니다.");
      }
    } catch (err) {
      alert("클립보드 권한이 없거나 데이터가 비어있습니다.");
    }
  };

  const handleFetchClipboard = async () => {
    try {
      const clips = await fetchClipboardText(sessionId);
      if (clips.length > 0) {
        const lastClip = clips[clips.length - 1];
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
  const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file || !sessionId) return;

    if (file.size > 10 * 1024 * 1024) {
      alert("10MB 이하의 파일만 전송 가능합니다.");
      return;
    }

    const reader = new FileReader();
    reader.onload = async () => {
      const base64 = (reader.result as string).split(",")[1];
      try {
        await uploadFile(sessionId, file.name, base64);
        alert(`파일 "${file.name}" 전송이 완료되었습니다.`);
      } catch (err) {
        alert("파일 전송 실패: " + (err instanceof Error ? err.message : err));
      }
    };
    reader.readAsDataURL(file);
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
            에이전트 접속 승인 대기 중...
          </div>
          <p style={{ color: "#94a3b8", fontSize: "14px", textAlign: "center", maxWidth: "300px" }}>
            보안상 원격 접속 제어를 위해 에이전트 CLI 또는 웹 창에서 '승인(Y)'을 수락해야 연동이 개시됩니다.
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

  return (
    <section className="session-panel" style={{ display: "flex", flexDirection: "column", position: "relative" }}>
      <div className="section-heading">
        <h2>원격 세션 (실시간 스트림)</h2>
        <span>{device.desktopName}</span>
      </div>

      <div style={{ display: "flex", flex: 1, gap: "16px", minHeight: "450px" }}>
        {/* 원격 스크린 영역 */}
        <div className="remote-screen connected" style={{ display: "flex", flexDirection: "column", flex: 1, overflow: "hidden" }}>
          <div className="remote-titlebar">
            <span>{device.deviceName}</span>
            <span>{device.businessNumber}</span>
            {latencyReport && (
              <span className="status-pill" style={{ marginLeft: "auto", background: "rgba(99, 102, 241, 0.2)", color: "#818cf8" }}>
                {latencyReport}
              </span>
            )}
          </div>
          <div className="remote-preview" style={{ padding: 0, overflow: "hidden", display: "flex", alignItems: "center", justifyContent: "center", flex: 1 }}>
            <canvas
              ref={canvasRef}
              onClick={handleCanvasClick}
              style={{ width: "100%", height: "auto", display: "block", cursor: "crosshair" }}
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
      <div className="session-actions" style={{ display: "flex", flexWrap: "wrap", gap: "8px", marginTop: "12px", alignItems: "center" }}>
        <button className="secondary-button" type="button" onClick={startVisualPing}>
          <MousePointerClick size={17} />
          <span>Visual Ping 측정</span>
        </button>
        <button className="secondary-button" type="button" onClick={() => onInputEvent("keypress A")}>
          <Keyboard size={17} />
          <span>키 입력 A</span>
        </button>
        <button className="secondary-button" type="button" onClick={() => onInputEvent("switch-monitor 0")} title="0번 모니터로 화면 전환">
          <Monitor size={17} />
          <span>모니터 0</span>
        </button>
        <button className="secondary-button" type="button" onClick={() => onInputEvent("switch-monitor 1")} title="1번 모니터로 화면 전환">
          <Monitor size={17} />
          <span>모니터 1</span>
        </button>

        {/* 3단계 기능들 */}
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
          <span>파일 전송 (10MB)</span>
        </button>
        <input
          type="file"
          ref={fileInputRef}
          onChange={handleFileUpload}
          style={{ display: "none" }}
        />

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

      <div className="input-log">
        {inputLog.map((line, idx) => (
          <div key={idx}>{line}</div>
        ))}
      </div>
    </section>
  );
}
