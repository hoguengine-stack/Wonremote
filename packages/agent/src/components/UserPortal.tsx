import React, { useState, useEffect, useRef } from 'react';
import { Button } from './Button';
import { WindowFrame } from './WindowFrame';
import { io, Socket } from 'socket.io-client';
import { getIceServers, getServerUrl, setServerUrl as saveServerUrl } from '@wonremote/shared';

interface UserPortalProps {
  onMinimize: () => void;
  isMinimized: boolean;
  onRestore: () => void;
  frameless?: boolean;
}

// Electron IPC 사용 (window.require로 불러와야 함)
const ipcRenderer = (window as any).require ? (window as any).require('electron').ipcRenderer : null;

const socket: Socket = io(getServerUrl(), {
  autoConnect: false,
  path: '/socket.io',
  transports: ['websocket', 'polling'],
  reconnection: true,
  reconnectionAttempts: Infinity,
  reconnectionDelay: 500,
  reconnectionDelayMax: 3000,
});

type AuthInfo = {
  id: string;
  desktopName: string;
  businessId: string;
  deviceName: string;
  allowRemote: 'YES' | 'NO';
  groupName?: string;
  installedAt?: string;
  os?: string;
  memo?: string;
};

const LS_ID = 'wr_desktop_name';
const LS_PW = 'wr_password';
const LS_AUTH = 'wr_auth_info';

// 소켓 클라이언트 초기화

// WebRTC 설정
const rtcConfig = {
  iceServers: getIceServers()
};

export const UserPortal: React.FC<UserPortalProps> = ({ onMinimize, isMinimized, onRestore, frameless = false }) => {
  const [isRegistered, setIsRegistered] = useState(false);
  const [formData, setFormData] = useState({ desktopName: '', password: '' });
  const [loading, setLoading] = useState(false);
  const [remoteStatus, setRemoteStatus] = useState<'IDLE' | 'CONNECTED'>('IDLE');
  const [serverUrlInput, setServerUrlInput] = useState(getServerUrl());
  const [isElevated, setIsElevated] = useState<boolean | null>(null);
  const [authInfo, setAuthInfo] = useState<AuthInfo | null>(null);
  
  const pcRef = useRef<RTCPeerConnection | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const videoSenderRef = useRef<RTCRtpSender | null>(null);
  const switchingRef = useRef(false);
  const authInfoRef = useRef<AuthInfo | null>(null);

  // --- 자동 로그인 체크 ---
  useEffect(() => {
      const savedId = localStorage.getItem(LS_ID);
      const savedPw = localStorage.getItem(LS_PW);
      
      if (savedId && savedPw) {
          console.log("자동 로그인 시도:", savedId);
          setFormData({ desktopName: savedId, password: savedPw });
          // 자동 로그인 함수 실행
          doLogin(savedId, savedPw);
      }
  }, []);

  useEffect(() => {
    (async () => {
      try {
        if (!ipcRenderer) return setIsElevated(null);
        const ok = await ipcRenderer.invoke('agent-is-elevated');
        setIsElevated(!!ok);
      } catch {
        setIsElevated(null);
      }
    })();
  }, []);

  useEffect(() => {
    authInfoRef.current = authInfo;
  }, [authInfo]);

  // 로그인 로직 분리 (수동/자동 공용)
  const doLogin = async (id: string, pw: string) => {
    setLoading(true);
    try {
      const res = await fetch(`${getServerUrl()}/api/auth`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id, password: pw })
      });
      const json = await res.json();
      if (!json?.success) throw new Error(json?.error || 'auth failed');

      const info: AuthInfo = json.data;
      setIsRegistered(true);
      setAuthInfo(info);
      setFormData({ desktopName: id, password: pw });

      localStorage.setItem(LS_ID, id);
      localStorage.setItem(LS_PW, pw);
      localStorage.setItem(LS_AUTH, JSON.stringify(info));

      socket.connect();

      if (socket.connected) {
        emitRegister(info);
      } else {
        socket.once('connect', () => emitRegister(info));
      }
    } catch (e) {
      localStorage.removeItem(LS_ID);
      localStorage.removeItem(LS_PW);
      localStorage.removeItem(LS_AUTH);
      alert("인증 정보가 올바르지 않습니다.");
    } finally {
      setLoading(false);
    }
  };

  const emitRegister = async (info: AuthInfo) => {
    socket.emit('register_device', {
        id: info.desktopName,
        desktopName: info.desktopName,
        businessId: info.businessId,
        deviceName: info.deviceName,
        allowRemote: info.allowRemote,
        groupName: info.groupName,
        installedAt: info.installedAt,
        os: info.os,
        memo: info.memo,
        width: window.screen.width,
        height: window.screen.height,
    });

    // 모니터 목록/주모니터 전송
    if (ipcRenderer) {
        try {
            const displays: any[] = await ipcRenderer.invoke('get-displays');
            socket.emit('agent_displays', {
                displays,
                activeDisplayId: displays?.find?.((d: any) => d.primary)?.id ?? displays?.[0]?.id ?? null,
            });
        } catch (e) {
            console.error(e);
        }
    }
  };

  const switchDisplay = async (displayId: number) => {
    if (!ipcRenderer) return;
    if (switchingRef.current) return;

    switchingRef.current = true;
    try {
      // 1) Electron main에 선호 모니터 설정
      await ipcRenderer.invoke('set-preferred-display', displayId);

      // 2) 아직 세션(화면송출) 중이 아니면: 다음 연결 때 적용만 하고 종료
      const pc = pcRef.current;
      if (!pc || remoteStatus !== 'CONNECTED') return;

      // 3) 새 화면 스트림 얻기(메인에서 자동 승인 + 지정 모니터 선택)
      const stream = await navigator.mediaDevices.getDisplayMedia({
        video: {
          width: { ideal: 1920 },
          height: { ideal: 1080 },
          frameRate: { max: 30 },
        },
        audio: false,
      });

      const newTrack = stream.getVideoTracks()[0];
      const sender = videoSenderRef.current;
      if (sender && newTrack) {
        await sender.replaceTrack(newTrack);
      }

      // 4) 기존 스트림 정리
      streamRef.current?.getTracks().forEach((t) => t.stop());
      streamRef.current = stream;

      // 5) 서버에 activeDisplayId/해상도 갱신
      const settings = newTrack.getSettings();
      let displays: any[] = [];
      try {
        displays = await ipcRenderer.invoke('get-displays');
      } catch {}

      socket.emit('update_device_display', {
        width: settings.width ?? window.screen.width,
        height: settings.height ?? window.screen.height,
        displays,
        activeDisplayId: displayId,
      });
    } catch (e) {
      console.error('switchDisplay failed:', e);
    } finally {
      switchingRef.current = false;
    }
  };

  useEffect(() => {
    const onConnect = () => {
      if (!isRegistered) return;
      const info = authInfoRef.current;
      if (info) {
        emitRegister(info);
        return;
      }
      const raw = localStorage.getItem(LS_AUTH);
      if (!raw) return;
      try {
        const parsed = JSON.parse(raw);
        if (parsed?.desktopName) emitRegister(parsed);
      } catch {}
    };

    socket.on('connect', onConnect);
    return () => socket.off('connect', onConnect);
  }, [isRegistered]);

  useEffect(() => {
    // 1. 관리자가 원격 접속을 요청함 (시작점)
    socket.on('start_remote_session', async (data) => {
      console.log('원격 접속 요청 받음. 관리자 ID:', data.adminId);
      setRemoteStatus('CONNECTED');
      if (ipcRenderer) {
        ipcRenderer.send('remote-session-status', { active: true });
        ipcRenderer.send('window-hide');
      } else {
        onRestore();
      }

      // 기존 연결이 있다면 종료
      if (pcRef.current) pcRef.current.close();

      // 새 연결 생성
      const pc = new RTCPeerConnection(rtcConfig);
      pcRef.current = pc;

      // ICE Candidate 발견 시 전송
      pc.onicecandidate = (event) => {
        if (event.candidate) {
            socket.emit('ice_candidate', { targetSocketId: data.adminId, candidate: event.candidate });
        }
      };

      try {
          // 화면 공유 요청 (Electron 메인 프로세스에서 자동 승인됨)
          const stream = await navigator.mediaDevices.getDisplayMedia({ 
              video: {
                  width: { ideal: 1920 },
                  height: { ideal: 1080 },
                  frameRate: { max: 30 }
              }, 
              audio: false 
          });
          
          // ★ 실제 해상도 서버에 업데이트 (마우스 좌표 정확도 향상)
          const track = stream.getVideoTracks()[0];
          const settings = track.getSettings();

          let displays: any[] = [];
          try {
            displays = ipcRenderer ? await ipcRenderer.invoke('get-displays') : [];
          } catch (e) {
            console.error('get-displays failed:', e);
          }

          const w = settings.width ?? window.screen.width;
          const h = settings.height ?? window.screen.height;

          // 공유 화면에 가장 근접한 모니터 추정
          let activeDisplayId: number | undefined = undefined;
          if (Array.isArray(displays) && displays.length > 0) {
            let best = displays[0];
            let bestScore = Number.POSITIVE_INFINITY;
            for (const d of displays) {
              const pw = Math.round(d.bounds.width * (d.scaleFactor || 1));
              const ph = Math.round(d.bounds.height * (d.scaleFactor || 1));
              const score = Math.abs(pw - w) + Math.abs(ph - h);
              if (score < bestScore) { best = d; bestScore = score; }
            }
            activeDisplayId = best?.id;
          }

          socket.emit('update_device_display', {
              width: w,
              height: h,
              displays,
              activeDisplayId
          });

          // stream 저장
          streamRef.current?.getTracks().forEach((t) => t.stop());
          streamRef.current = stream;

          // 비디오 트랙만 add + sender 저장
          const videoTrack = stream.getVideoTracks()[0];
          if (videoTrack) {
            const sender = pc.addTrack(videoTrack, stream);
            videoSenderRef.current = sender;
          }

          // Offer 생성 및 전송
          const offer = await pc.createOffer();
          await pc.setLocalDescription(offer);
          socket.emit('offer', { targetSocketId: data.adminId, sdp: offer });

          // 공유 중지 버튼 눌렀을 때 처리
          stream.getVideoTracks()[0].onended = () => {
              handleDisconnect();
          };
      } catch (err) {
          console.error('화면 공유 실패:', err);
          setRemoteStatus('IDLE');
          if (ipcRenderer) {
            ipcRenderer.send('remote-session-status', { active: false });
          }
      }
    });

    // 2. 관리자가 Answer를 보냄
    socket.on('answer', async (data) => {
        if (pcRef.current) {
            await pcRef.current.setRemoteDescription(new RTCSessionDescription(data.sdp));
        }
    });

    // 3. ICE Candidate 교환
    socket.on('ice_candidate', async (data) => {
        if (pcRef.current) {
            await pcRef.current.addIceCandidate(new RTCIceCandidate(data.candidate));
        }
    });

    // ping 요청 → 응답
    socket.on('ping_request', ({ t, fromAdmin }) => {
        socket.emit('pong_device', { adminSocketId: fromAdmin, t });
    });

    // 클립보드 동기화
    socket.on('clipboard_set', async ({ text }) => {
      try { ipcRenderer?.send('clipboard-set-text', text ?? ''); } catch {}
    });

    socket.on('clipboard_get', async ({ fromAdmin }) => {
      let text = '';
      try { text = await ipcRenderer?.invoke('clipboard-get-text'); } catch {}
      socket.emit('clipboard_text', { adminSocketId: fromAdmin, text });
    });

    // 입력 잠금
    socket.on('set_input_lock', ({ enabled }) => {
      ipcRenderer?.send('set-input-lock', !!enabled);
    });

    // 4. 원격 제어 명령 수신 (마우스/키보드)
    socket.on('remote_control', async (data) => {
        if (data?.action === 'set_display') {
            const id = Number(data?.displayId);
            if (Number.isFinite(id)) {
                await switchDisplay(id);
            }
            return;
        }

        // Electron에게 명령 전달 (진짜 마우스 움직이기)
        if (ipcRenderer) {
            ipcRenderer.send('remote_control', data);
        }
    });

    // 5. 파일 데이터 수신 (청크 단위)
    socket.on('file_transfer_chunk', (data) => {
        const { fileName, fileData, isLast, offset } = data;
        
        if (ipcRenderer) {
            // Electron 메인 프로세스에 파일 쓰기 요청 (append 모드)
            ipcRenderer.send('write-file-chunk', { fileName, fileData, isLast, offset });
        }
    });

    return () => {
      socket.off('start_remote_session');
      socket.off('answer');
      socket.off('ice_candidate');
      socket.off('ping_request');
      socket.off('clipboard_set');
      socket.off('clipboard_get');
      socket.off('set_input_lock');
      socket.off('remote_control');
      socket.off('file_transfer_chunk');
      if (pcRef.current) pcRef.current.close();
    };
  }, [onRestore]);

  const handleRegister = (e: React.FormEvent) => {
    e.preventDefault();
    doLogin(formData.desktopName, formData.password);
  };

  const handleSaveServerUrl = () => {
    const next = serverUrlInput.trim();
    if (!next) return;
    saveServerUrl(next);
    window.location.reload();
  };

  const handleDisconnect = () => {
      socket.disconnect();
      setIsRegistered(false);
      setRemoteStatus('IDLE');
      setFormData({ desktopName: '', password: '' });
      setAuthInfo(null);
      
      // 로그아웃 시 저장된 정보 삭제 (선택 사항: 자동 로그인을 끄려면 삭제)
      localStorage.removeItem(LS_ID);
      localStorage.removeItem(LS_PW);
      localStorage.removeItem(LS_AUTH);

      if (pcRef.current) {
          pcRef.current.close();
          pcRef.current = null;
      }
      if (ipcRenderer) {
          ipcRenderer.send('remote-session-status', { active: false });
      }
  };

  const handleMinimize = () => {
      if (ipcRenderer) {
          ipcRenderer.send('window-hide');
      } else {
          onMinimize(); // 웹 모드일 때 (기존 동작)
      }
  };

  const handleBackground = () => {
      if (ipcRenderer) {
          ipcRenderer.send('window-hide');
      } else {
          onMinimize();
      }
  };

  if (isMinimized) {
    return null;
  }

  // Active Window View
  return (
    <WindowFrame 
      title="WonRemote 에이전트" 
      width="w-[360px]" 
      height="h-[520px]"
      onMinimize={handleMinimize}
      onClose={handleBackground} // 닫기 누르면 백그라운드(트레이)로
      frameless={frameless}
    >
      {isRegistered ? (
        <div className="h-full bg-slate-50 flex flex-col">
          {/* Header Section with Background */}
          <div className="bg-gradient-to-b from-indigo-600 to-indigo-800 p-6 text-center text-white relative overflow-hidden shrink-0">
             <div className="absolute top-0 right-0 w-32 h-32 bg-white opacity-5 rounded-full -mr-10 -mt-10 pointer-events-none"></div>
             
             <div className="relative z-10">
                <div className="mb-2 font-medium opacity-90 tracking-wide text-xs">SYSTEM STATUS</div>
                <div className="relative w-24 h-24 mx-auto flex items-center justify-center">
                    <div className="w-16 h-16 bg-white rounded-full flex items-center justify-center shadow-lg relative z-10">
                         <svg className="w-8 h-8 text-indigo-600" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                             <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5.636 18.364a9 9 0 010-12.728m12.728 0a9 9 0 010 12.728m-9.9-2.829a5 5 0 010-7.07m7.072 0a5 5 0 010 7.07M13 12a1 1 0 11-2 0 1 1 0 012 0z" />
                         </svg>
                    </div>
                    <div className="absolute top-1 right-1 w-4 h-4 bg-green-400 border-2 border-indigo-700 rounded-full z-20"></div>
                </div>
                <h2 className="text-xl font-bold mt-3">원격 연결 대기 중</h2>
                <p className="text-indigo-200 text-xs">관리자의 접속을 모니터링하고 있습니다</p>
             </div>
          </div>

          {/* Body Section */}
          <div className="flex-1 px-4 py-4 flex flex-col">
              <div className="bg-white rounded-xl shadow-sm border border-slate-200 p-5 flex flex-col items-center">
                  <span className="text-xs font-bold text-gray-400 uppercase tracking-widest mb-1">DESKTOP - NAME</span>
                  <div className="text-2xl font-mono font-bold text-gray-800 bg-slate-50 px-4 py-2 rounded-lg border border-slate-200 w-full text-center tracking-widest">
                      {formData.desktopName}
                  </div>
                  
                  <div className="w-full h-px bg-gray-100 my-4"></div>
                  
                  <div className="w-full space-y-2">
                      <div className="flex justify-between items-center text-xs">
                          <span className="text-gray-500">에이전트 버전</span>
                          <span className="font-medium text-gray-700">v2.1.0</span>
                      </div>
                      <div className="flex justify-between items-center text-xs">
                          <span className="text-gray-500">보안 프로토콜</span>
                          <span className="font-medium text-green-600 flex items-center gap-1">
                              <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z" /></svg>
                              활성화됨
                          </span>
                      </div>
                  </div>
              </div>

              {/* Actions */}
              <div className="mt-auto pt-4 space-y-2">
                  <Button 
                      onClick={handleBackground}
                      className="w-full bg-white text-gray-600 border border-gray-200 hover:bg-gray-50 hover:text-gray-900 shadow-sm"
                  >
                      <span className="flex items-center justify-center gap-2">
                          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" /></svg>
                          백그라운드 실행 (트레이)
                      </span>
                  </Button>
                  
                  <button 
                      onClick={handleDisconnect}
                      className="w-full text-xs text-red-400 hover:text-red-600 py-2 transition-colors underline decoration-red-200 underline-offset-2"
                  >
                      연결 종료 및 로그아웃
                  </button>
              </div>
          </div>
        </div>
      ) : (
        <div className="h-full bg-white flex flex-col">
          <div className="p-8 pb-4 flex flex-col items-center">
             <div className="w-16 h-16 bg-gradient-to-br from-indigo-500 to-purple-600 rounded-xl flex items-center justify-center shadow-lg mb-4 text-white">
                 <span className="font-bold text-2xl">WR</span>
             </div>
             <h2 className="text-xl font-bold text-gray-900">WonRemote</h2>
             <p className="text-gray-500 text-xs mt-1">Enterprise Remote Management</p>
          </div>

          <form onSubmit={handleRegister} className="px-8 py-2 flex-1 flex flex-col gap-4">
            <div>
              <label className="block text-[10px] font-bold text-gray-400 mb-1 uppercase tracking-wider">DESKTOP - NAME</label>
              <div className="relative">
                  <span className="absolute left-3 top-2.5 text-gray-400">
                    <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 21V5a2 2 0 00-2-2H7a2 2 0 00-2 2v16m14 0h2m-2 0h-5m-9 0H3m2 0h5M9 7h1m-1 4h1m4-4h1m-1 4h1m-5 10v-5a1 1 0 011-1h2a1 1 0 011 1v5m-4 0h4" /></svg>
                  </span>
                  <input
                    type="text"
                    required
                    placeholder="3600602052-01"
                    className="w-full pl-9 pr-3 py-2.5 border border-gray-200 bg-gray-50 rounded-lg text-sm focus:ring-2 focus:ring-indigo-500 focus:bg-white transition-all outline-none"
                    value={formData.desktopName}
                    onChange={(e) => setFormData({...formData, desktopName: e.target.value})}
                  />
              </div>
            </div>

            <div>
              <label className="block text-[10px] font-bold text-gray-400 mb-1 uppercase tracking-wider">Access Password</label>
              <div className="relative">
                  <span className="absolute left-3 top-2.5 text-gray-400">
                    <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z" /></svg>
                  </span>
                  <input
                    type="password"
                    required
                    placeholder="사업자번호 마지막 5자리"
                    className="w-full pl-9 pr-3 py-2.5 border border-gray-200 bg-gray-50 rounded-lg text-sm focus:ring-2 focus:ring-indigo-500 focus:bg-white transition-all outline-none"
                    value={formData.password}
                    onChange={(e) => setFormData({...formData, password: e.target.value})}
                  />
              </div>
            </div>

            <details className="text-xs text-gray-500">
              <summary className="cursor-pointer select-none">서버 설정</summary>
              <div className="mt-2 flex gap-2">
                <input
                  type="text"
                  className="flex-1 px-3 py-2 border border-gray-200 bg-gray-50 rounded-lg text-xs focus:ring-2 focus:ring-indigo-500 focus:bg-white transition-all outline-none"
                  value={serverUrlInput}
                  onChange={(e) => setServerUrlInput(e.target.value)}
                />
                <button
                  type="button"
                  onClick={handleSaveServerUrl}
                  className="px-3 py-2 rounded-lg bg-gray-100 text-gray-700 text-xs border border-gray-200 hover:bg-gray-200"
                >
                  저장
                </button>
              </div>
            </details>
            {isElevated === false && (
              <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 8 }}>
                <span style={{ fontSize: 12, color: '#b45309' }}>
                  관리자 권한 아님(일부 제어 제한)
                </span>
                <button
                  type="button"
                  onClick={async () => {
                    try { await ipcRenderer?.invoke('agent-relaunch-elevated'); } catch {}
                  }}
                  style={{ fontSize: 12, padding: '6px 10px', borderRadius: 8 }}
                >
                  관리자 권한으로 재시작
                </button>
              </div>
            )}

            <div className="mt-auto mb-6">
                <Button type="submit" className="w-full bg-indigo-600 hover:bg-indigo-700 shadow-md py-3" isLoading={loading}>
                시스템 연결 시작
                </Button>
                <p className="text-[10px] text-gray-400 text-center mt-3 leading-tight">
                    WonRemote 서버에 안전하게 연결합니다.<br/>
                    초기 비밀번호는 관리자에게 문의하세요.
                </p>
            </div>
          </form>
        </div>
      )}
    </WindowFrame>
  );
};
