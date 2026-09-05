import {
  Activity,
  ClipboardCheck,
  Download,
  FileUp,
  Keyboard,
  LogIn,
  Maximize2,
  MonitorUp,
  RefreshCw,
  Smartphone,
  Unplug,
  Wifi,
} from "lucide-react";
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  closeSession,
  loginAdmin,
  openSession,
} from "../api/viewerApi";
import { sha256BlobHex } from "../domain/blobHash";
import { canTransferRemoteFile, remoteFileLimitLabel } from "../domain/fileTransferPolicy";
import {
  createIosProbeChecks,
  isIosLike,
  summarizeIosProbeChecks,
  updateIosProbeCheck,
  type IosProbeCheckId,
  type IosProbeStatus,
} from "../domain/iosCapabilityProbe";
import {
  buildMouseCommand,
  buildPasteTextCommand,
  mapCanvasPointToVirtualDesktopAbsolute,
} from "../domain/remoteControlCommands";
import type { ManagedDevice } from "../domain/types";
import type { RemoteTileFrame } from "../domain/webrtcFrameAssembly";
import {
  isViewerFirebaseEnabled,
  startFirebaseViewerWebRtcTransport,
  subscribeFirebaseDevices,
  subscribeViewerAuthState,
  type ViewerWebRtcTransport,
} from "../firebase/viewerFirebase";
import "./iosCapabilityProbe.css";

type ProbeMetrics = {
  sessionMs?: number;
  webRtcMs?: number;
  firstFrameMs?: number;
  backgroundMs?: number;
};

type RemoteTile = {
  x: number;
  y: number;
  w: number;
  h: number;
  data: string;
};

const STATUS_LABELS: Record<IosProbeStatus, string> = {
  pass: "통과",
  limited: "제한",
  fail: "실패",
  pending: "대기",
};

function detectStandalone(): boolean {
  return window.matchMedia("(display-mode: standalone)").matches
    || (navigator as Navigator & { standalone?: boolean }).standalone === true;
}

function initialChecks() {
  const clipboard = navigator.clipboard as unknown as Record<string, unknown> | undefined;
  return createIosProbeChecks({
    isIosDevice: isIosLike(navigator.userAgent, navigator.platform, navigator.maxTouchPoints),
    isSecureContext: window.isSecureContext,
    hasWebRtc: typeof RTCPeerConnection !== "undefined"
      && typeof RTCPeerConnection.prototype.createDataChannel === "function",
    hasPointerEvents: typeof PointerEvent !== "undefined",
    hasClipboardText: typeof clipboard?.readText === "function" && typeof clipboard?.writeText === "function",
    hasClipboardImage: typeof clipboard?.read === "function"
      && typeof clipboard?.write === "function"
      && typeof ClipboardItem !== "undefined",
    hasFileAccess: typeof File !== "undefined" && typeof FileReader !== "undefined",
    hasFullscreen: typeof document.documentElement.requestFullscreen === "function",
    isStandalone: detectStandalone(),
    hasServiceWorker: "serviceWorker" in navigator,
  });
}

export function IosCapabilityProbe() {
  const [checks, setChecks] = useState(initialChecks);
  const [authenticated, setAuthenticated] = useState(false);
  const [authResolved, setAuthResolved] = useState(false);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [loginBusy, setLoginBusy] = useState(false);
  const [devices, setDevices] = useState<ManagedDevice[]>([]);
  const [selectedDeviceId, setSelectedDeviceId] = useState("");
  const [connectionBusy, setConnectionBusy] = useState(false);
  const [sessionId, setSessionId] = useState("");
  const [transportState, setTransportState] = useState("연결 안 됨");
  const [diagnostic, setDiagnostic] = useState("");
  const [metrics, setMetrics] = useState<ProbeMetrics>({});
  const [imeValue, setImeValue] = useState("");
  const [imeEvents, setImeEvents] = useState<string[]>([]);
  const [clipboardText, setClipboardText] = useState("WonRemote iOS clipboard test");
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [fileProgress, setFileProgress] = useState(0);
  const [inputEnabled, setInputEnabled] = useState(false);
  const pageRef = useRef<HTMLElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const transportRef = useRef<ViewerWebRtcTransport | null>(null);
  const sessionIdRef = useRef("");
  const connectStartedAtRef = useRef(0);
  const firstFrameReceivedRef = useRef(false);
  const hiddenAtRef = useRef(0);
  const activePointerRef = useRef<number | null>(null);
  const lastPointerRef = useRef({ dx: 32768, dy: 32768 });
  const connectionGenerationRef = useRef(0);

  const updateCheck = useCallback((
    id: IosProbeCheckId,
    status: IosProbeStatus,
    detail: string,
  ) => {
    setChecks((current) => updateIosProbeCheck(current, id, status, detail));
  }, []);

  const summary = useMemo(() => summarizeIosProbeChecks(checks), [checks]);
  const selectedDevice = devices.find((device) => device.id === selectedDeviceId) ?? null;

  useEffect(() => {
    document.title = "WonRemote iOS 사전 검증";
    if (!("serviceWorker" in navigator) || !window.isSecureContext) return;
    void navigator.serviceWorker.register("/ios-probe-sw.js")
      .then(() => updateCheck("service-worker", "pass", "Service Worker 등록 완료"))
      .catch((error) => updateCheck(
        "service-worker",
        "fail",
        error instanceof Error ? error.message : "Service Worker 등록 실패",
      ));
  }, [updateCheck]);

  useEffect(() => {
    if (!isViewerFirebaseEnabled()) {
      setAuthResolved(true);
      setDiagnostic("Firebase 설정이 없어 실제 Agent 연결을 검사할 수 없습니다.");
      return;
    }
    return subscribeViewerAuthState(
      (hasSession) => {
        setAuthenticated(hasSession);
        setAuthResolved(true);
      },
      (error) => {
        setAuthenticated(false);
        setAuthResolved(true);
        setDiagnostic(error.message);
      },
    );
  }, []);

  useEffect(() => {
    if (!authenticated) {
      setDevices([]);
      return;
    }
    return subscribeFirebaseDevices(
      setDevices,
      (error) => setDiagnostic(error.message),
    );
  }, [authenticated]);

  useEffect(() => {
    if (devices.some((device) => device.id === selectedDeviceId)) return;
    setSelectedDeviceId(
      devices.find((device) => device.status === "online")?.id
        ?? devices[0]?.id
        ?? "",
    );
  }, [devices, selectedDeviceId]);

  useEffect(() => {
    const handleVisibility = () => {
      if (document.hidden) {
        hiddenAtRef.current = performance.now();
        return;
      }
      if (!hiddenAtRef.current) return;
      const backgroundMs = Math.round(performance.now() - hiddenAtRef.current);
      hiddenAtRef.current = 0;
      const connectionAlive = sessionIdRef.current
        ? transportRef.current?.isControlReady() === true
        : true;
      setMetrics((current) => ({ ...current, backgroundMs }));
      updateCheck(
        "background-resume",
        connectionAlive ? "pass" : "fail",
        sessionIdRef.current
          ? `${(backgroundMs / 1000).toFixed(1)}초 후 복귀, 제어 채널 ${connectionAlive ? "유지" : "종료"}`
          : `${(backgroundMs / 1000).toFixed(1)}초 후 정상 복귀, Agent 연결 후 재검사 필요`,
      );
    };
    document.addEventListener("visibilitychange", handleVisibility);
    return () => document.removeEventListener("visibilitychange", handleVisibility);
  }, [updateCheck]);

  useEffect(() => () => {
    connectionGenerationRef.current += 1;
    transportRef.current?.close();
    if (sessionIdRef.current) void closeSession(sessionIdRef.current).catch(() => undefined);
  }, []);

  const drawFrame = useCallback((frame: RemoteTileFrame) => {
    if (!sessionIdRef.current) return;
    const canvas = canvasRef.current;
    const width = Number(frame.width ?? 0);
    const height = Number(frame.height ?? 0);
    if (!canvas || width <= 0 || height <= 0 || frame.tiles.length === 0) return;
    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width;
      canvas.height = height;
    }
    const context = canvas.getContext("2d");
    if (!context) return;
    for (const tile of frame.tiles as RemoteTile[]) {
      const image = new Image();
      image.onload = () => {
        if (!sessionIdRef.current) return;
        context.drawImage(image, Number(tile.x) * 32, Number(tile.y) * 32, Number(tile.w), Number(tile.h));
        if (firstFrameReceivedRef.current) return;
        firstFrameReceivedRef.current = true;
        const firstFrameMs = Math.round(performance.now() - connectStartedAtRef.current);
        setMetrics((current) => ({ ...current, firstFrameMs }));
        updateCheck("first-frame", "pass", `연결 요청 후 ${firstFrameMs}ms`);
      };
      image.src = `data:image/jpeg;base64,${tile.data}`;
    }
  }, [updateCheck]);

  const disconnect = useCallback(async () => {
    connectionGenerationRef.current += 1;
    activePointerRef.current = null;
    setInputEnabled(false);
    const currentSessionId = sessionIdRef.current;
    sessionIdRef.current = "";
    transportRef.current?.close();
    transportRef.current = null;
    setSessionId("");
    setTransportState("연결 안 됨");
    if (currentSessionId) {
      await closeSession(currentSessionId).catch((error) => {
        setDiagnostic(error instanceof Error ? error.message : String(error));
      });
    }
  }, []);

  const connect = async () => {
    if (!selectedDevice || selectedDevice.status !== "online" || connectionBusy) return;
    await disconnect();
    setConnectionBusy(true);
    setDiagnostic("");
    setMetrics({});
    setFileProgress(0);
    firstFrameReceivedRef.current = false;
    connectStartedAtRef.current = performance.now();
    const generation = ++connectionGenerationRef.current;
    try {
      const result = await openSession(selectedDevice.id);
      if (generation !== connectionGenerationRef.current) {
        await closeSession(result.session.id).catch(() => undefined);
        return;
      }
      const sessionMs = Math.round(performance.now() - connectStartedAtRef.current);
      sessionIdRef.current = result.session.id;
      setSessionId(result.session.id);
      setMetrics({ sessionMs });
      setTransportState("WebRTC 협상 중");
      const transport = await startFirebaseViewerWebRtcTransport(result.session.id, {
        onFrame: drawFrame,
        onState: (state) => {
          if (generation !== connectionGenerationRef.current) return;
          setTransportState(state);
          if (state === "webrtc-open") {
            const webRtcMs = Math.round(performance.now() - connectStartedAtRef.current);
            setMetrics((current) => ({ ...current, webRtcMs }));
            updateCheck("agent-session", "pass", `제어·화면 채널 ${webRtcMs}ms`);
          }
        },
        onDiagnostic: setDiagnostic,
        onError: (error) => {
          if (generation !== connectionGenerationRef.current) return;
          setDiagnostic(error.message);
          updateCheck("agent-session", "fail", error.message);
        },
      });
      if (generation !== connectionGenerationRef.current) {
        transport.close();
        return;
      }
      transportRef.current = transport;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setDiagnostic(message);
      updateCheck("agent-session", "fail", message);
      await disconnect();
    } finally {
      setConnectionBusy(false);
    }
  };

  const handleLogin = async (event: React.FormEvent) => {
    event.preventDefault();
    if (loginBusy) return;
    setLoginBusy(true);
    setDiagnostic("");
    try {
      await loginAdmin(email, password);
      setPassword("");
    } catch (error) {
      setDiagnostic(error instanceof Error ? error.message : String(error));
    } finally {
      setLoginBusy(false);
    }
  };

  const addImeEvent = (name: string, value = "") => {
    setImeEvents((current) => [`${name}${value ? `: ${value}` : ""}`, ...current].slice(0, 8));
  };

  const testClipboardWrite = async () => {
    try {
      await navigator.clipboard.writeText(clipboardText);
      updateCheck("clipboard-text", "pass", "사용자 조작으로 텍스트 쓰기 성공");
    } catch (error) {
      updateCheck("clipboard-text", "fail", error instanceof Error ? error.message : String(error));
    }
  };

  const testClipboardRead = async () => {
    try {
      const value = await navigator.clipboard.readText();
      setClipboardText(value);
      updateCheck("clipboard-text", "pass", `텍스트 읽기 성공 (${value.length}자)`);
    } catch (error) {
      updateCheck("clipboard-text", "limited", error instanceof Error ? error.message : String(error));
    }
  };

  const testClipboardImage = async () => {
    if (!selectedFile || selectedFile.type !== "image/png") return;
    try {
      await navigator.clipboard.write([new ClipboardItem({ "image/png": selectedFile })]);
      updateCheck("clipboard-image", "pass", `PNG 쓰기 성공 (${selectedFile.size.toLocaleString()} bytes)`);
    } catch (error) {
      updateCheck("clipboard-image", "limited", error instanceof Error ? error.message : String(error));
    }
  };

  const readClipboardImage = async () => {
    const clipboard = navigator.clipboard as Clipboard & { read?: () => Promise<ClipboardItems> };
    try {
      const items = await clipboard.read?.();
      const png = items?.some((item) => item.types.includes("image/png")) === true;
      updateCheck(
        "clipboard-image",
        png ? "pass" : "limited",
        png ? "PNG 읽기 성공" : "현재 클립보드에 PNG가 없거나 읽을 수 없음",
      );
    } catch (error) {
      updateCheck("clipboard-image", "limited", error instanceof Error ? error.message : String(error));
    }
  };

  const toggleFullscreen = async () => {
    try {
      if (document.fullscreenElement) {
        await document.exitFullscreen();
        updateCheck("fullscreen", "pass", "전체화면 진입·종료 성공");
      } else if (pageRef.current?.requestFullscreen) {
        await pageRef.current.requestFullscreen();
        updateCheck("fullscreen", "pass", "Fullscreen API 진입 성공");
      } else if (detectStandalone()) {
        updateCheck("fullscreen", "pass", "홈 화면 standalone 모드 사용 중");
      } else {
        updateCheck("fullscreen", "limited", "Fullscreen API 없음, 홈 화면 앱으로 검사 필요");
      }
    } catch (error) {
      updateCheck("fullscreen", "limited", error instanceof Error ? error.message : String(error));
    }
  };

  const sendImeText = () => {
    if (!imeValue || transportRef.current?.isControlReady() !== true) return;
    const sent = transportRef.current.sendControl(buildPasteTextCommand(imeValue));
    updateCheck("ime", sent ? "pass" : "fail", sent ? "조합 문자열 원격 전송 성공" : "원격 전송 실패");
  };

  const sendSelectedFile = async () => {
    const transport = transportRef.current;
    if (!selectedFile || !transport?.isControlReady() || !canTransferRemoteFile(selectedFile.size)) return;
    setFileProgress(0);
    try {
      const sent = await transport.sendFile({
        file: selectedFile,
        filename: selectedFile.name,
        fileSha256: await sha256BlobHex(selectedFile),
        transferId: `ios-probe-${Date.now()}`,
        onProgress: (receivedBytes, totalBytes) => {
          setFileProgress(Math.round((receivedBytes / Math.max(1, totalBytes)) * 100));
        },
      });
      updateCheck(
        "remote-file",
        sent ? "pass" : "fail",
        sent ? `${selectedFile.name} 전송 완료` : "WebRTC 파일 채널이 열리지 않음",
      );
    } catch (error) {
      updateCheck("remote-file", "fail", error instanceof Error ? error.message : String(error));
    }
  };

  const sendSelectedPngToAgentClipboard = async () => {
    const transport = transportRef.current;
    if (!selectedFile || selectedFile.type !== "image/png" || !transport?.isControlReady()) return;
    try {
      const sent = await transport.sendFile({
        file: selectedFile,
        filename: "wonremote-ios-clipboard.png",
        fileSha256: await sha256BlobHex(selectedFile),
        transferId: `ios-clipboard-${Date.now()}`,
        purpose: "clipboard-image",
        mimeType: "image/png",
      });
      updateCheck(
        "remote-clipboard-image",
        sent ? "pass" : "fail",
        sent ? "PNG를 Agent 클립보드로 전송 완료" : "WebRTC 파일 채널이 열리지 않음",
      );
    } catch (error) {
      updateCheck("remote-clipboard-image", "fail", error instanceof Error ? error.message : String(error));
    }
  };

  const mapPointer = (clientX: number, clientY: number) => {
    const canvas = canvasRef.current;
    if (!canvas || !selectedDevice) return null;
    const rect = canvas.getBoundingClientRect();
    const activeDisplay = selectedDevice.displays?.find(
      (display) => display.index === (selectedDevice.activeDisplayIndex ?? 0),
    );
    return mapCanvasPointToVirtualDesktopAbsolute(
      clientX,
      clientY,
      rect,
      activeDisplay,
      selectedDevice.displays,
    );
  };

  const sendPointer = (type: "down" | "move" | "up", clientX: number, clientY: number) => {
    const point = mapPointer(clientX, clientY) ?? lastPointerRef.current;
    lastPointerRef.current = point;
    return transportRef.current?.sendControl(buildMouseCommand(type, point.dx, point.dy, 0)) === true;
  };

  const releasePointer = useCallback(() => {
    if (activePointerRef.current === null) return;
    activePointerRef.current = null;
    const point = lastPointerRef.current;
    transportRef.current?.sendControl(buildMouseCommand("up", point.dx, point.dy, 0));
  }, []);

  useEffect(() => {
    window.addEventListener("pointerup", releasePointer);
    window.addEventListener("pointercancel", releasePointer);
    return () => {
      window.removeEventListener("pointerup", releasePointer);
      window.removeEventListener("pointercancel", releasePointer);
    };
  }, [releasePointer]);

  const downloadReport = () => {
    const report = {
      capturedAt: new Date().toISOString(),
      userAgent: navigator.userAgent,
      platform: navigator.platform,
      standalone: detectStandalone(),
      metrics,
      checks,
    };
    const url = URL.createObjectURL(new Blob([JSON.stringify(report, null, 2)], { type: "application/json" }));
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `wonremote-ios-check-${Date.now()}.json`;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  return (
    <main className="ios-probe" ref={pageRef}>
      <header className="ios-probe-header">
        <div className="ios-probe-brand">
          <span className="ios-probe-logo"><Smartphone size={19} /></span>
          <div>
            <strong>WonRemote iOS 사전 검증</strong>
            <span>{navigator.platform} · touch {navigator.maxTouchPoints}</span>
          </div>
        </div>
        <button className="ios-probe-icon-button" type="button" onClick={downloadReport} title="결과 저장">
          <Download size={18} />
        </button>
      </header>

      <section className="ios-probe-summary" aria-label="검사 요약">
        <span className="pass">통과 <strong>{summary.pass}</strong></span>
        <span className="limited">제한 <strong>{summary.limited}</strong></span>
        <span className="fail">실패 <strong>{summary.fail}</strong></span>
        <span className="pending">대기 <strong>{summary.pending}</strong></span>
      </section>

      <section className="ios-probe-section">
        <div className="ios-probe-section-title">
          <Activity size={18} />
          <h1>기능 판정</h1>
        </div>
        <div className="ios-probe-checks">
          {checks.map((check) => (
            <div className="ios-probe-check" key={check.id}>
              <span className={`ios-probe-status ${check.status}`}>{STATUS_LABELS[check.status]}</span>
              <div>
                <strong>{check.label}</strong>
                <span>{check.detail}</span>
              </div>
            </div>
          ))}
        </div>
      </section>

      <section className="ios-probe-section">
        <div className="ios-probe-section-title">
          <MonitorUp size={18} />
          <h2>실제 Agent 연결</h2>
        </div>
        {!authResolved ? (
          <p className="ios-probe-muted">로그인 상태 확인 중</p>
        ) : !authenticated ? (
          <form className="ios-probe-login" onSubmit={handleLogin}>
            <input
              autoComplete="username"
              inputMode="email"
              placeholder="Viewer 이메일"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
            />
            <input
              autoComplete="current-password"
              placeholder="비밀번호"
              type="password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
            />
            <button type="submit" disabled={loginBusy || !email || !password}>
              <LogIn size={17} /> 로그인
            </button>
          </form>
        ) : (
          <div className="ios-probe-connect-row">
            <select value={selectedDeviceId} onChange={(event) => setSelectedDeviceId(event.target.value)}>
              {devices.map((device) => (
                <option value={device.id} key={device.id}>
                  {device.status === "online" ? "온라인" : "오프라인"} · {device.storeName} · {device.desktopName}
                </option>
              ))}
            </select>
            <button
              type="button"
              disabled={!selectedDevice || selectedDevice.status !== "online" || connectionBusy}
              onClick={() => void connect()}
            >
              <Wifi size={17} /> 연결
            </button>
            <button type="button" disabled={!sessionId} onClick={() => void disconnect()}>
              <Unplug size={17} /> 종료
            </button>
          </div>
        )}

        <div className="ios-probe-connection-state">
          <strong>{transportState}</strong>
          <span>
            세션 {metrics.sessionMs ?? "-"}ms · WebRTC {metrics.webRtcMs ?? "-"}ms · 첫 화면 {metrics.firstFrameMs ?? "-"}ms
          </span>
        </div>
        {diagnostic && <p className="ios-probe-error">{diagnostic}</p>}

        <div className="ios-probe-remote">
          <canvas
            ref={canvasRef}
            onContextMenu={(event) => event.preventDefault()}
            onPointerDown={(event) => {
              if (!inputEnabled || transportRef.current?.isControlReady() !== true) return;
              event.preventDefault();
              event.currentTarget.setPointerCapture(event.pointerId);
              activePointerRef.current = event.pointerId;
              sendPointer("down", event.clientX, event.clientY);
            }}
            onPointerMove={(event) => {
              if (!inputEnabled || activePointerRef.current !== event.pointerId) return;
              event.preventDefault();
              sendPointer("move", event.clientX, event.clientY);
            }}
            onPointerUp={(event) => {
              if (activePointerRef.current !== event.pointerId) return;
              event.preventDefault();
              const sent = sendPointer("up", event.clientX, event.clientY);
              activePointerRef.current = null;
              updateCheck(
                "remote-pointer",
                sent ? "pass" : "fail",
                sent ? "pointer down/move/up 전송 완료" : "제어 채널 전송 실패",
              );
            }}
            aria-label="원격 화면 터치 검사"
          />
          {!metrics.firstFrameMs && <span>원격 화면 대기</span>}
        </div>
        <label className="ios-probe-toggle">
          <input
            type="checkbox"
            checked={inputEnabled}
            disabled={!sessionId}
            onChange={(event) => setInputEnabled(event.target.checked)}
          />
          원격 터치 전송
        </label>
      </section>

      <section className="ios-probe-section">
        <div className="ios-probe-section-title">
          <Keyboard size={18} />
          <h2>한글 IME</h2>
        </div>
        <textarea
          rows={3}
          placeholder="한글을 조합해 입력"
          value={imeValue}
          onChange={(event) => {
            setImeValue(event.target.value);
            addImeEvent("input", event.target.value);
          }}
          onCompositionStart={() => addImeEvent("compositionstart")}
          onCompositionUpdate={(event) => {
            addImeEvent("compositionupdate", event.data);
            updateCheck("ime", "pass", `실시간 조합 감지: ${event.data || "(빈 값)"}`);
          }}
          onCompositionEnd={(event) => addImeEvent("compositionend", event.data)}
          onBeforeInput={(event) => addImeEvent("beforeinput", event.nativeEvent.inputType)}
        />
        <div className="ios-probe-actions">
          <button type="button" disabled={!imeValue || transportRef.current?.isControlReady() !== true} onClick={sendImeText}>
            원격에 전송
          </button>
          <button type="button" onClick={() => { setImeValue(""); setImeEvents([]); }}>지우기</button>
        </div>
        <output className="ios-probe-event-log">{imeEvents.join("\n") || "입력 이벤트 대기"}</output>
      </section>

      <section className="ios-probe-section">
        <div className="ios-probe-section-title">
          <ClipboardCheck size={18} />
          <h2>클립보드·파일</h2>
        </div>
        <input value={clipboardText} onChange={(event) => setClipboardText(event.target.value)} />
        <div className="ios-probe-actions">
          <button type="button" onClick={() => void testClipboardWrite()}>텍스트 쓰기</button>
          <button type="button" onClick={() => void testClipboardRead()}>텍스트 읽기</button>
        </div>
        <label className="ios-probe-file-picker">
          <FileUp size={18} />
          <span>{selectedFile ? selectedFile.name : `파일 선택 · 최대 ${remoteFileLimitLabel()}`}</span>
          <input
            type="file"
            onChange={(event) => {
              const file = event.target.files?.[0] ?? null;
              setSelectedFile(file);
              setFileProgress(0);
              if (file) {
                updateCheck(
                  "file-access",
                  canTransferRemoteFile(file.size) ? "pass" : "fail",
                  `${file.name} · ${file.size.toLocaleString()} bytes`,
                );
              }
            }}
          />
        </label>
        <div className="ios-probe-actions">
          <button type="button" disabled={selectedFile?.type !== "image/png"} onClick={() => void testClipboardImage()}>
            PNG 클립보드 쓰기
          </button>
          <button type="button" onClick={() => void readClipboardImage()}>
            PNG 클립보드 읽기
          </button>
        </div>
        <div className="ios-probe-actions">
          <button
            type="button"
            disabled={selectedFile?.type !== "image/png" || transportRef.current?.isControlReady() !== true}
            onClick={() => void sendSelectedPngToAgentClipboard()}
          >
            PNG를 Agent 클립보드로
          </button>
          <button
            type="button"
            disabled={!selectedFile || transportRef.current?.isControlReady() !== true || !canTransferRemoteFile(selectedFile.size)}
            onClick={() => void sendSelectedFile()}
          >
            Agent로 전송
          </button>
        </div>
        {fileProgress > 0 && (
          <div className="ios-probe-progress" aria-label={`파일 전송 ${fileProgress}%`}>
            <span style={{ width: `${fileProgress}%` }} />
          </div>
        )}
      </section>

      <section className="ios-probe-section ios-probe-last-section">
        <div className="ios-probe-section-title">
          <Maximize2 size={18} />
          <h2>화면·백그라운드</h2>
        </div>
        <div className="ios-probe-actions">
          <button type="button" onClick={() => void toggleFullscreen()}>전체화면 검사</button>
          <button type="button" onClick={() => window.location.reload()}>
            <RefreshCw size={16} /> 재검사
          </button>
        </div>
        <p className="ios-probe-muted">
          표시 모드 {detectStandalone() ? "standalone" : "browser"} · 마지막 백그라운드 {metrics.backgroundMs ?? "-"}ms
        </p>
      </section>
    </main>
  );
}
