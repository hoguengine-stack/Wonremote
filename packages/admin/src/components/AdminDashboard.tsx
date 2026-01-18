import React, { useState, useEffect, useRef } from 'react';
import { Device, getServerUrl } from '@wonremote/shared';
import { Button } from './Button';
import { WindowFrame } from './WindowFrame';
import CustomerTable from './CustomerTable';
import { io } from 'socket.io-client';

const socket = io(getServerUrl(), {
  autoConnect: true,
  path: '/socket.io',
  transports: ['websocket', 'polling'],
});

export const AdminDashboard: React.FC<{onLogout: () => void}> = ({onLogout}) => {
  const electronClipboard = (window as any).require ? (window as any).require('electron').clipboard : null;
  const [searchQuery, setSearchQuery] = useState('');
  const [groupFilter, setGroupFilter] = useState('ALL');
  const [activeDevice, setActiveDevice] = useState<Device | null>(null);
  const [isConnected, setIsConnected] = useState(false);
  const [openMenu, setOpenMenu] = useState<'keys' | 'power' | null>(null);
  const [realDevices, setRealDevices] = useState<Device[]>([]);
  const [isVideoReady, setIsVideoReady] = useState(false);
  const [selectedDisplayId, setSelectedDisplayId] = useState<number | null>(null);
  const [pingMs, setPingMs] = useState<number | null>(null);
  const [inputLock, setInputLock] = useState(false);
  const [zoom, setZoom] = useState(1);
  const [isControlPaused, setIsControlPaused] = useState(false);
  
  const pcRef = useRef<RTCPeerConnection | null>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const viewWrapRef = useRef<HTMLDivElement>(null);
  const candidatesQueue = useRef<RTCIceCandidateInit[]>([]);
  const activeDeviceRef = useRef<Device | null>(null);
  const pressedKeysRef = useRef<Set<string>>(new Set());
  const pressedButtonsRef = useRef<Set<number>>(new Set());
  const lastPointerRef = useRef<{
    xn: number;
    yn: number;
    displayId: number | null;
    streamWidth: number;
    streamHeight: number;
    x: number;
    y: number;
  } | null>(null);
  const moveRafRef = useRef<number | null>(null);

  // --- 파일 전송 상태 ---
  const [showFileTransfer, setShowFileTransfer] = useState(false);
  const [transferProgress, setTransferStatus] = useState({ 
      status: 'IDLE', fileName: '', fileSize: 0, progress: 0, speed: '', timeLeft: '' 
  });
  const fileInputRef = useRef<HTMLInputElement>(null);
  const transferStartRef = useRef<number>(0);
  const transferLastBytesRef = useRef<number>(0);
  const powerConfirmRef = useRef<{ [key: string]: boolean }>({});
  // ✅ 재부팅 감시(2분) + 자동 재연결
  const RECONNECT_WATCH_MS = 120_000;
  const reconnectWatchRef = useRef<{
    deviceId: string;
    startedAt: number;
    stage: 'ARMED' | 'OFFLINE_SEEN';
  } | null>(null);

  useEffect(() => {
    activeDeviceRef.current = activeDevice;
  }, [activeDevice]);

  useEffect(() => {
    socket.on('device_list_update', (devices: Device[]) => {
      setRealDevices(devices);

      const current = activeDeviceRef.current;
      if (!current) return;

      const updated = devices.find(d => d.id === current.id);

      const w = reconnectWatchRef.current;
      const watching =
        !!w &&
        w.deviceId === current.id &&
        (Date.now() - w.startedAt) <= RECONNECT_WATCH_MS;

      if (!updated) {
        // 목록에서 사라짐
        if (watching) {
          reconnectWatchRef.current = { ...w!, stage: 'OFFLINE_SEEN' };
          handleDisconnect({ keepActiveDevice: true });
          return;
        }
        alert("장비 연결 끊김");
        handleDisconnect();
        return;
      }

      // 장비가 존재함
      setActiveDevice(prev => ({ ...prev!, ...updated }));

      if (updated.status === 'OFFLINE') {
        if (watching) {
          reconnectWatchRef.current = { ...w!, stage: 'OFFLINE_SEEN' };
          handleDisconnect({ keepActiveDevice: true });
          return;
        }
        alert("사용자 연결 종료");
        handleDisconnect();
        return;
      }

      // ONLINE 복귀
      if (watching && w!.stage === 'OFFLINE_SEEN') {
        reconnectWatchRef.current = null;
        setTimeout(() => handleConnect(updated), 600);
      }
    });

    // ★ 영상 수신 로직 (무조건 현재 활성 장비와 연결)
    socket.on('offer', async (data) => {
        console.log('Offer 수신');
        setIsVideoReady(false);
        
        // Sender ID를 찾지 말고, 내가 접속을 시도한 그 장비(activeDevice)라고 확신하고 연결
        const peerSocketId = data?.fromSocketId || activeDeviceRef.current?.socketId;
        if (!peerSocketId) {
            console.error('Offer received but peer socket id is missing:', data);
            return;
        }
        console.log('Offer sender:', data?.fromSocketId, 'replyTo:', peerSocketId);

        if (pcRef.current) {
            pcRef.current.close();
            pcRef.current = null;
        }

        const pc = new RTCPeerConnection({
            iceServers: [{ urls: 'stun:stun.l.google.com:19302' }]
        });
        pcRef.current = pc;

        pc.ontrack = (event) => {
            if (videoRef.current) {
                videoRef.current.srcObject = event.streams[0];
                videoRef.current.play().catch(e => console.error(e));
                setIsVideoReady(true);
            }
        };

        await pc.setRemoteDescription(new RTCSessionDescription(data.sdp));

        while (candidatesQueue.current.length > 0) {
            await pc.addIceCandidate(new RTCIceCandidate(candidatesQueue.current.shift()!));
        }

        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        socket.emit('answer', { targetSocketId: peerSocketId, sdp: answer });

        pc.onicecandidate = (event) => {
            if (event.candidate) {
                socket.emit('ice_candidate', { targetSocketId: peerSocketId, candidate: event.candidate });
            }
        };
    });

    socket.on('ice_candidate', async (data) => {
        if (pcRef.current && pcRef.current.remoteDescription) {
            await pcRef.current.addIceCandidate(new RTCIceCandidate(data.candidate));
        } else {
            candidatesQueue.current.push(data.candidate);
        }
    });

    socket.on('disconnect', () => {
        if (isConnected) {
            alert("서버 연결 끊김");
            handleDisconnect();
        }
    });

    return () => {
      socket.off('device_list_update');
      socket.off('offer');
      socket.off('ice_candidate');
      socket.off('disconnect');
      if (pcRef.current) pcRef.current.close();
    };
  }, [isConnected]);

  useEffect(() => {
    if (!activeDevice) return;
    const displays = activeDevice.displays || [];
    const primary = displays.find((d) => d.primary)?.id ?? (displays[0]?.id ?? null);
    setSelectedDisplayId(activeDevice.activeDisplayId ?? primary ?? null);
  }, [activeDevice?.socketId]);

  // ping ms 측정
  useEffect(() => {
    if (!activeDevice?.socketId) return;
    const interval = setInterval(() => {
      socket.emit('ping_device', { targetSocketId: activeDevice.socketId, t: Date.now() });
    }, 1000);

    const onPong = ({ t }: any) => {
      const ms = Date.now() - Number(t);
      if (Number.isFinite(ms)) setPingMs(ms);
    };
    socket.on('pong_device', onPong);

    return () => {
      clearInterval(interval);
      socket.off('pong_device', onPong);
    };
  }, [activeDevice?.socketId]);

  const getClipboardText = async () => {
    if (electronClipboard) return String(electronClipboard.readText() || '');
    try {
      return String(await navigator.clipboard.readText());
    } catch {
      return '';
    }
  };

  // 로컬 클립보드 -> 원격 자동 동기화
  useEffect(() => {
    if (!activeDevice?.socketId) return;
    let lastText = '';
    let stopped = false;

    const syncOnce = async () => {
      if (stopped) return;
      const text = await getClipboardText();
      if (text !== lastText) {
        lastText = text;
        socket.emit('clipboard_set', { targetSocketId: activeDevice.socketId, text });
      }
    };

    const onCopy = () => {
      syncOnce().catch(() => {});
    };

    const interval = setInterval(() => {
      syncOnce().catch(() => {});
    }, 1000);

    window.addEventListener('copy', onCopy);
    window.addEventListener('cut', onCopy);

    return () => {
      stopped = true;
      clearInterval(interval);
      window.removeEventListener('copy', onCopy);
      window.removeEventListener('cut', onCopy);
    };
  }, [activeDevice?.socketId]);

  useEffect(() => {
    const t = setInterval(() => {
      const w = reconnectWatchRef.current;
      if (!w) return;
      if ((Date.now() - w.startedAt) > RECONNECT_WATCH_MS) {
        reconnectWatchRef.current = null;
        alert('자동 재연결 실패(2분 초과). 장비 목록에서 다시 연결하세요.');
      }
    }, 1000);

    return () => clearInterval(t);
  }, []);

  useEffect(() => {
    const onBlur = () => {
      releaseAllButtons();
      releaseAllKeys();
    };

    const onMouseUp = (e: MouseEvent) => {
      if (!pressedButtonsRef.current.size) return;
      const last = lastPointerRef.current;
      if (!last) return;
      if (pressedButtonsRef.current.has(e.button)) {
        pressedButtonsRef.current.delete(e.button);
        emitMouse(last, 'mouseup', { button: e.button });
      }
    };

    window.addEventListener('blur', onBlur);
    window.addEventListener('mouseup', onMouseUp);
    return () => {
      window.removeEventListener('blur', onBlur);
      window.removeEventListener('mouseup', onMouseUp);
    };
  }, []);

  useEffect(() => {
    if (!isControlPaused) return;
    releaseAllButtons();
    releaseAllKeys();
  }, [isControlPaused]);

  // --- 이벤트 핸들러 ---
  const getPointerPayload = (e: React.MouseEvent<HTMLVideoElement>) => {
    const device = activeDeviceRef.current;
    const videoEl = videoRef.current;
    if (!videoEl || !device) return null;

    const rect = videoEl.getBoundingClientRect();

    // Use actual stream resolution first to keep mapping accurate.
    const streamWidth = videoEl.videoWidth || device.width || rect.width;
    const streamHeight = videoEl.videoHeight || device.height || rect.height;

    const elementAspect = rect.width / rect.height;
    const streamAspect = streamWidth / streamHeight;

    let displayWidth = rect.width;
    let displayHeight = rect.height;
    let offsetX = 0;
    let offsetY = 0;

    if (elementAspect > streamAspect) {
      displayWidth = rect.height * streamAspect;
      offsetX = (rect.width - displayWidth) / 2;
    } else if (elementAspect < streamAspect) {
      displayHeight = rect.width / streamAspect;
      offsetY = (rect.height - displayHeight) / 2;
    }

    const localX = e.clientX - rect.left - offsetX;
    const localY = e.clientY - rect.top - offsetY;

    if (localX < 0 || localY < 0 || localX > displayWidth || localY > displayHeight) {
      return null;
    }

    const normX = localX / displayWidth;
    const normY = localY / displayHeight;

    const displayId = selectedDisplayId ?? (device as any)?.activeDisplayId ?? null;
    const display = device.displays?.find((d: any) => d.id === displayId) || device.displays?.[0];
    const scale = display?.scaleFactor || 1;

    const x = display
      ? Math.round((display.bounds.x + normX * display.bounds.width) * scale)
      : Math.round(normX * streamWidth);

    const y = display
      ? Math.round((display.bounds.y + normY * display.bounds.height) * scale)
      : Math.round(normY * streamHeight);

    const payload = {
      xn: normX,
      yn: normY,
      displayId,
      x,
      y,
      streamWidth,
      streamHeight,
    };

    lastPointerRef.current = { xn: normX, yn: normY, displayId, streamWidth, streamHeight, x, y };
    return payload;
  };

  const emitMouse = (payload: any, type: string, extras?: any) => {
    const device = activeDeviceRef.current;
    if (!device) return;
    socket.emit('remote_control', {
      targetSocketId: device.socketId,
      action: 'mouse',
      type,
      ...payload,
      ...extras,
    });
  };

  const handleMouseEvent = (e: React.MouseEvent<HTMLVideoElement>, type: string) => {
    if (isControlPaused) return;
    e.preventDefault();
    const payload = getPointerPayload(e);
    if (!payload) return;
    if (type === 'mousedown') pressedButtonsRef.current.add(e.button);
    if (type === 'mouseup') pressedButtonsRef.current.delete(e.button);
    emitMouse(payload, type, {
      button: type === 'wheel' ? 0 : e.button,
      deltaY: type === 'wheel' ? (e as any).deltaY : 0,
    });
  };

  const handleMouseMove = (e: React.MouseEvent<HTMLVideoElement>) => {
    if (isControlPaused) return;
    const payload = getPointerPayload(e);
    if (!payload) return;
    if (moveRafRef.current != null) return;
    moveRafRef.current = requestAnimationFrame(() => {
      moveRafRef.current = null;
      const last = lastPointerRef.current;
      if (!last) return;
      emitMouse(last, 'mousemove');
    });
  };

  const sendKeyEvent = (type: 'keydown' | 'keyup', key: string) => {
    const device = activeDeviceRef.current;
    if (!device) return;
    socket.emit('remote_control', {
      targetSocketId: device.socketId,
      action: 'keyboard',
      type,
      key,
    });
  };

  const releaseAllKeys = () => {
    const device = activeDeviceRef.current;
    if (!device) return;
    pressedKeysRef.current.clear();
    socket.emit('remote_control', {
      targetSocketId: device.socketId,
      action: 'key_release_all',
    });
  };

  const releaseAllButtons = () => {
    const last = lastPointerRef.current;
    if (!last) return;
    const buttons = Array.from(pressedButtonsRef.current.values());
    pressedButtonsRef.current.clear();
    for (const btn of buttons) {
      emitMouse(last, 'mouseup', { button: btn });
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (isControlPaused) return;
    const device = activeDeviceRef.current;
    if (!device || !isConnected) return;
    if (e.repeat) return;

    if (e.ctrlKey && (e.key === 'Escape' || e.key === 'Esc')) {
      e.preventDefault();
      sendKeyEvent('keydown', 'winleft');
      sendKeyEvent('keyup', 'winleft');
      return;
    }

    if (e.ctrlKey && (e.key === 'v' || e.key === 'V')) {
      e.preventDefault();
      getClipboardText().then((text) => {
        socket.emit('clipboard_set', { targetSocketId: device.socketId, text });
        socket.emit('remote_control', { targetSocketId: device.socketId, action: 'paste' });
      }).catch(() => {});
      return;
    }

    if (!e.ctrlKey && !e.altKey && !e.metaKey && e.key.length === 1) {
      e.preventDefault();
      socket.emit('remote_control', { targetSocketId: device.socketId, action: 'paste_text', text: e.key });
      return;
    }

    pressedKeysRef.current.add(e.key);
    sendKeyEvent('keydown', e.key);
  };

  const handleKeyUp = (e: React.KeyboardEvent) => {
    if (isControlPaused) return;
    const device = activeDeviceRef.current;
    if (!device || !isConnected) return;
    if (!pressedKeysRef.current.has(e.key)) return;
    pressedKeysRef.current.delete(e.key);
    sendKeyEvent('keyup', e.key);
  };

  const handleConnect = (device: Device) => {
    if (device.allowRemote !== 'YES' || device.status === 'BLOCKED') {
      alert('원격 접속이 허용되지 않습니다.');
      return;
    }
    reconnectWatchRef.current = {
      deviceId: device.id,
      startedAt: Date.now(),
      stage: 'ARMED',
    };

    setIsControlPaused(false);
    setActiveDevice(device);
    setIsConnected(true);
    socket.emit('request_connection', device.id);
  };

  const handleDisconnect = (opts?: { keepActiveDevice?: boolean }) => {
    setIsControlPaused(false);
    releaseAllButtons();
    releaseAllKeys();
    setIsConnected(false);
    if (!opts?.keepActiveDevice) setActiveDevice(null);
    setIsVideoReady(false);
    if (pcRef.current) { pcRef.current.close(); pcRef.current = null; }
  };

  const handleSystemAction = (action: string) => {
    setOpenMenu(null);
    if (!activeDevice) return;
    // 재시작/종료는 2회 클릭 확인
    if (action === 'restart' || action === 'shutdown') {
        const armed = powerConfirmRef.current[action];
        if (!armed) {
            powerConfirmRef.current = { ...powerConfirmRef.current, [action]: true };
            setTimeout(() => {
                powerConfirmRef.current = { ...powerConfirmRef.current, [action]: false };
            }, 5000);
            alert('한 번 더 클릭하면 실행됩니다.');
            return;
        }
    }
    // ✅ 재시작이면: 재부팅 감시 시작(2분)
    if (action === 'restart') {
      reconnectWatchRef.current = {
        deviceId: activeDevice.id,
        startedAt: Date.now(),
        stage: 'ARMED',
      };
    }
    socket.emit('remote_control', {
        targetSocketId: activeDevice.socketId,
        action: 'system',
        command: action
    });
    powerConfirmRef.current = { ...powerConfirmRef.current, [action]: false };
  };

  const handleServerConfig = () => {
    const current = localStorage.getItem('wr_server_url') || getServerUrl();
    const next = window.prompt('서버 주소', current);
    if (next && next.trim()) {
      localStorage.setItem('wr_server_url', next.trim());
      window.location.reload();
    }
  };

  const closeFileTransfer = () => {
      setShowFileTransfer(false);
      setTransferStatus({ status: 'IDLE', fileName: '', fileSize: 0, progress: 0, speed: '', timeLeft: '' });
  };

  const setFit = () => setZoom(1);
  const set100 = () => {
    if (!viewWrapRef.current || !activeDevice) return;
    const r = viewWrapRef.current.getBoundingClientRect();
    const sw = activeDevice.width || r.width;
    const sh = activeDevice.height || r.height;
    const fitScale = Math.min(r.width / sw, r.height / sh);
    if (fitScale > 0) setZoom(1 / fitScale);
  };
  const zoomIn = () => setZoom((z) => Math.min(8, z * 1.1));
  const zoomOut = () => setZoom((z) => Math.max(0.2, z / 1.1));

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file || !activeDevice) return;
    
    e.target.value = ''; // input 리셋
    setShowFileTransfer(true);
    setTransferStatus({ status: 'UPLOADING', fileName: file.name, fileSize: file.size, progress: 0, speed: '계산 중...', timeLeft: '...' });
    transferStartRef.current = Date.now();
    transferLastBytesRef.current = 0;

    const CHUNK_SIZE = 1024 * 64; 
    let offset = 0;
    const reader = new FileReader();
    
    reader.onload = (e) => {
        if (e.target?.result) {
            socket.emit('file_transfer_chunk', {
                targetSocketId: activeDevice.socketId,
                fileName: file.name,
                fileData: e.target.result,
                isLast: offset + CHUNK_SIZE >= file.size,
                offset: offset
            });

            offset += CHUNK_SIZE;
            const percent = Math.min(100, Math.round((offset / file.size) * 100));
            const elapsedSec = Math.max(0.1, (Date.now() - transferStartRef.current) / 1000);
            const speedBytes = offset / elapsedSec;
            const remaining = Math.max(0, file.size - offset);
            const timeLeftSec = speedBytes > 0 ? remaining / speedBytes : 0;

            setTransferStatus(prev => ({ 
                ...prev, 
                progress: percent,
                speed: `${(speedBytes / 1024).toFixed(1)} KB/s`,
                timeLeft: `${Math.ceil(timeLeftSec)}초`
            }));

            if (offset < file.size) {
                const slice = file.slice(offset, offset + CHUNK_SIZE);
                reader.readAsArrayBuffer(slice);
            } else {
                setTransferStatus(prev => ({ ...prev, status: 'COMPLETED', timeLeft: '완료', progress: 100 }));
            }
        }
    };
    reader.readAsArrayBuffer(file.slice(0, CHUNK_SIZE));
  };

  const groups = Array.from(new Set(realDevices.map(d => (d.groupName || '').trim()).filter(Boolean))).sort();
  const filteredDevicesBase = searchQuery
    ? realDevices.filter(d =>
        d.businessId.includes(searchQuery) ||
        (d.deviceName || '').includes(searchQuery) ||
        (d.desktopName || '').includes(searchQuery)
      )
    : realDevices;
  const filteredDevices =
    groupFilter === 'ALL'
      ? filteredDevicesBase
      : filteredDevicesBase.filter(d => (d.groupName || '') === groupFilter);
  const formatSize = (bytes: number) => { if(bytes===0) return '0 B'; const k=1024; const i=Math.floor(Math.log(bytes)/Math.log(k)); return parseFloat((bytes/Math.pow(k,i)).toFixed(2))+' '+['B','KB','MB','GB'][i]; };
  
  const getStatusText = (status: string) => {
      switch(status) { case 'ONLINE': return '온라인'; case 'OFFLINE': return '오프라인'; default: return status; }
  }

  // --- 화면 렌더링 ---
  if (isConnected && activeDevice) {
    return (
      <div className="flex flex-col h-full bg-gray-900" tabIndex={0} onKeyDown={handleKeyDown} onKeyUp={handleKeyUp}>
        {/* 상단 툴바 */}
        <div className="bg-gray-800 border-b border-gray-700 p-2 flex items-center justify-between text-white relative z-50">
           <div className="flex items-center gap-3">
             <div className="flex items-center gap-2 px-2 border-r border-gray-700 pr-4">
               <span className="w-2 h-2 bg-green-500 rounded-full animate-pulse"></span>
               <div className="flex flex-col leading-none">
                   <span className="font-bold text-xs">{activeDevice.deviceName || activeDevice.desktopName || activeDevice.id}</span>
                   <div className="flex gap-2 text-[10px] text-gray-400 font-mono">
                     <span>{activeDevice.ipAddress}</span>
                     <span>{activeDevice.width}x{activeDevice.height}</span>
                   </div>
               </div>
             </div>
             
             <div className="flex gap-1">
               {/* 숨겨진 파일 입력 */}
               <input type="file" ref={fileInputRef} style={{ display: 'none' }} onChange={handleFileChange} />
               
               {/* 툴바 버튼들 복구 */}
               <ToolbarButton icon={<svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" /><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" /></svg>} label="서비스" onClick={() => handleSystemAction('services.msc')} />
               <ToolbarButton icon={<svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 002 2h2a2 2 0 002-2z" /></svg>} label="작업관리자" onClick={() => handleSystemAction('taskmgr')} />
               <ToolbarButton icon={<svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 9l3 3-3 3m5 0h3M5 20h14a2 2 0 002-2V6a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z" /></svg>} label="CMD" onClick={() => handleSystemAction('cmd')} />
               <ToolbarButton icon={<svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z" /></svg>} label="탐색기" onClick={() => handleSystemAction('explorer')} />
               <ToolbarButton icon={<svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12h6m-6 4h6m-6-8h6M5 8h.01M5 12h.01M5 16h.01M3 6h18a2 2 0 012 2v10a2 2 0 01-2 2H3a2 2 0 01-2-2V8a2 2 0 012-2z" /></svg>} label="장치관리자" onClick={() => handleSystemAction('devmgmt.msc')} />
               
               <div className="w-px h-6 bg-gray-600 mx-1"></div>

               {/* 제어 메뉴 */}
               <div className="relative">
                    <ToolbarButton icon={<svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 6V4m0 2a2 2 0 100 4m0-4a2 2 0 110 4m-6 8a2 2 0 100-4m0 4a2 2 0 110-4m0 4v2m0-6V4m6 6v10m6-2a2 2 0 100-4m0 4a2 2 0 110-4m0 4v2m0-6V4" /></svg>} label="제어" active={openMenu === 'keys'} onClick={() => setOpenMenu(openMenu === 'keys' ? null : 'keys')} hasDropdown />
                    {openMenu === 'keys' && (
                    <div className="absolute top-full left-0 mt-1 w-56 bg-white text-gray-800 rounded shadow-xl py-1 text-xs border border-gray-200">
                        <div className="px-3 py-1 text-[10px] font-bold text-gray-400 uppercase tracking-wider">빠른 실행</div>
                        <MenuItem label="서비스" shortcut="services.msc" onClick={() => handleSystemAction('services.msc')} />
                        <MenuItem label="작업 관리자" shortcut="taskmgr" onClick={() => handleSystemAction('taskmgr')} />
                        <MenuItem label="CMD" shortcut="cmd" onClick={() => handleSystemAction('cmd')} />
                        <MenuItem label="탐색기" shortcut="explorer" onClick={() => handleSystemAction('explorer')} />
                    </div>
                    )}
               </div>

               <ToolbarButton icon={<svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 7h12m0 0l-4-4m4 4l-4 4m0 6H4m0 0l4 4m-4-4l4-4" /></svg>} label="파일전송" onClick={() => fileInputRef.current?.click()} className="bg-indigo-700 hover:bg-indigo-600" />
             </div>
           </div>
           
            <div className="flex gap-2 items-center">
             {activeDevice?.displays?.length ? (
               <div className="flex items-center gap-2 text-xs text-gray-200">
                 <span className="px-2 py-1 rounded bg-gray-700">
                   {activeDevice.displays.length >= 2 ? `듀얼(${activeDevice.displays.length})` : `싱글`}
                 </span>
                 <select
                   className="bg-gray-700 text-gray-100 border border-gray-600 rounded px-2 py-1"
                   value={selectedDisplayId ?? ''}
                   onChange={(e) => {
                     const id = Number(e.target.value);
                     setSelectedDisplayId(id);

                     if (activeDevice?.socketId) {
                       socket.emit('remote_control', {
                         targetSocketId: activeDevice.socketId,
                         action: 'set_display',
                         displayId: id,
                       });
                     }
                   }}
                 >
                   {activeDevice.displays.map((d: any, idx: number) => (
                     <option key={d.id} value={d.id}>
                       {`${idx + 1}번${d.primary ? '(주)' : ''}  ${Math.round(d.bounds.width * (d.scaleFactor || 1))}x${Math.round(d.bounds.height * (d.scaleFactor || 1))}`}
                     </option>
                   ))}
                 </select>
               </div>
             ) : null}
             <div className="text-xs text-gray-200 font-mono tabular-nums" style={{ minWidth: 72 }}>
               ping: {pingMs == null ? '-' : `${pingMs}ms`}
             </div>
             <button
               onClick={() => {
                 setOpenMenu(null);
                 setIsControlPaused((v) => !v);
               }}
               className={`p-1.5 rounded text-xs flex items-center gap-1 border transition-all ${
                 isControlPaused
                   ? 'bg-yellow-600 border-yellow-500 text-black'
                   : 'bg-gray-700 border-gray-600 text-white hover:bg-gray-600'
               }`}
               title={isControlPaused ? '제어 재개' : '제어 일시중지'}
             >
               {isControlPaused ? (
                 <svg className="w-4 h-4" viewBox="0 0 24 24" fill="currentColor">
                   <path d="M8 5v14l11-7L8 5z" />
                 </svg>
               ) : (
                 <svg className="w-4 h-4" viewBox="0 0 24 24" fill="currentColor">
                   <path d="M6 5h4v14H6V5zm8 0h4v14h-4V5z" />
                 </svg>
               )}
               <span>{isControlPaused ? '제어 재개' : '제어 일시중지'}</span>
             </button>
             <div className="relative">
                <button onClick={() => setOpenMenu(openMenu === 'power' ? null : 'power')} className={`p-1.5 rounded text-xs flex items-center gap-1 border transition-all ${openMenu === 'power' ? 'bg-red-700 border-red-500 text-white' : 'text-red-300 border-red-900 hover:bg-red-900/50 hover:text-white hover:border-red-500'}`}>
                    <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 10V3L4 14h7v7l9-11h-7z" /></svg><span>전원</span><svg className="w-3 h-3 ml-1" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" /></svg>
                </button>
                {openMenu === 'power' && (
                    <div className="absolute top-full right-0 mt-1 w-48 bg-white text-gray-800 rounded shadow-xl py-1 text-xs border border-gray-200">
                        <MenuItem label="화면 잠금" shortcut="C+A+Q" onClick={() => handleSystemAction('lock')} />
                        <MenuItem label="로그오프" shortcut="C+A+U" onClick={() => handleSystemAction('logoff')} />
                        <MenuItem label="재시작 (2회 클릭)" shortcut="C+A+End" onClick={() => handleSystemAction('restart')} />
                        <div className="border-t my-1"></div>
                        <MenuItem label="전원 끄기 (2회 클릭)" shortcut="C+A+P" danger onClick={() => handleSystemAction('shutdown')} />
                    </div>
                )}
             </div>
             <Button variant="danger" onClick={handleDisconnect} className="text-xs py-1 px-3">종료</Button>
           </div>
        </div>

        {/* 제어 보조 UI (배율/클립보드/입력 잠금) */}
        <div className="bg-gray-800 border-b border-gray-700 p-3 text-white text-xs flex flex-col gap-3">
          <div className="flex flex-wrap items-center gap-2">
            <span className="px-2 py-1 rounded bg-gray-700">배율</span>
            <button onClick={setFit} className="px-2 py-1 rounded bg-gray-700 text-white text-xs">Fit</button>
            <button onClick={set100} className="px-2 py-1 rounded bg-gray-700 text-white text-xs">100%</button>
            <button onClick={zoomOut} className="px-2 py-1 rounded bg-gray-700 text-white text-xs">-</button>
            <button onClick={zoomIn} className="px-2 py-1 rounded bg-gray-700 text-white text-xs">+</button>
            <span className="ml-2 text-gray-300">{`x${zoom.toFixed(2)}`}</span>
            <div className="ml-4 flex items-center gap-2">
              <span className="text-gray-300">사용자 입력 잠금</span>
              <button
                onClick={() => {
                  const next = !inputLock;
                  setInputLock(next);
                  socket.emit('set_input_lock', { targetSocketId: activeDevice.socketId, enabled: next });
                }}
                className={`px-2 py-1 rounded text-xs ${inputLock ? 'bg-red-600 text-white' : 'bg-gray-700 text-white'}`}
              >
                {inputLock ? '잠금 해제' : '잠금'}
              </button>
            </div>
          </div>

        </div>

        {/* Video Area */}
        <div className="flex-1 bg-black relative flex items-center justify-center overflow-hidden p-4">
           <div ref={viewWrapRef} className="relative shadow-2xl bg-gray-800 ring-1 ring-white/10 mx-auto" style={{ width: '100%', height: '100%', aspectRatio: `${activeDevice.width} / ${activeDevice.height}` }}>
              <div className="w-full h-full bg-black relative overflow-hidden group">
                 <video
                    ref={videoRef}
                    autoPlay
                    playsInline
                    muted
                    className="w-full h-full object-contain cursor-crosshair"
                    style={{ transform: `scale(${zoom})`, transformOrigin: 'center center' }}
                    onMouseDown={(e) => handleMouseEvent(e, 'mousedown')}
                    onMouseUp={(e) => handleMouseEvent(e, 'mouseup')}
                    onMouseMove={handleMouseMove}
                    onContextMenu={(e) => {
                      e.preventDefault();
                      handleMouseEvent(e, 'mousedown');
                      setTimeout(() => {
                        const last = lastPointerRef.current;
                        if (!last) return;
                        pressedButtonsRef.current.delete(2);
                        emitMouse(last, 'mouseup', { button: 2 });
                      }, 40);
                    }}
                    onWheel={(e) => handleMouseEvent(e as any, 'wheel')}
                 />
                 {!isVideoReady && (
                     <div className="absolute inset-0 flex flex-col items-center justify-center text-gray-500">
                         <div className="animate-spin rounded-full h-10 w-10 border-b-2 border-white mb-4"></div>
                         <p>화면 연결 중...</p>
                     </div>
                 )}
              </div>
           </div>
           
           {/* 파일 전송 모달 */}
           {showFileTransfer && (
             <div className="absolute inset-0 bg-black/50 backdrop-blur-sm flex items-center justify-center z-50">
               <div className="bg-white rounded-lg shadow-2xl w-[500px] overflow-hidden text-gray-900">
                 <div className="bg-indigo-600 p-3 flex justify-between items-center text-white">
                   <h3 className="font-semibold">파일 전송</h3>
                   <button onClick={closeFileTransfer}>✕</button>
                 </div>
                 <div className="p-6 space-y-4">
                    <div className="flex items-center gap-3">
                        <div className="w-10 h-10 bg-indigo-100 text-indigo-600 rounded-lg flex items-center justify-center">📄</div>
                        <div className="flex-1">
                            <div className="font-bold text-sm">{transferProgress.fileName || '파일 대기 중'}</div>
                            <div className="text-xs text-gray-500">{formatSize(transferProgress.fileSize)}</div>
                        </div>
                    </div>
                    
                    {/* 대기 상태 */}
                    {transferProgress.status === 'IDLE' && (
                        <div className="border-2 border-dashed border-gray-300 rounded-xl p-8 flex flex-col items-center justify-center text-gray-500 hover:bg-gray-50 transition-colors cursor-pointer" onClick={() => fileInputRef.current?.click()}>
                            <span className="font-medium">전송할 파일을 선택하세요</span>
                        </div>
                    )}

                    {/* 전송 중 상태 */}
                    {transferProgress.status !== 'IDLE' && (
                        <div className="relative pt-1">
                            <div className="flex justify-between mb-1">
                                <span className="text-xs font-semibold text-indigo-600">진행률</span>
                                <span className="text-xs font-semibold text-indigo-600">{transferProgress.progress}%</span>
                            </div>
                            <div className="overflow-hidden h-2 text-xs flex rounded bg-indigo-100">
                                <div style={{ width: `${transferProgress.progress}%` }} className="shadow-none flex flex-col text-center whitespace-nowrap text-white justify-center bg-indigo-500 transition-all duration-300"></div>
                            </div>
                            
                            <div className="flex justify-between mt-2 text-xs text-gray-500">
                                <span>{transferProgress.speed}</span>
                                <span>남은 시간: {transferProgress.timeLeft}</span>
                            </div>

                            {transferProgress.status === 'COMPLETED' && <div className="text-center text-green-600 font-bold text-sm mt-2">전송 완료!</div>}
                        </div>
                    )}
                 </div>
               </div>
             </div>
           )}
        </div>
      </div>
    );
  }

  // Dashboard View
  return (
    <WindowFrame title="WonRemote 관리자 콘솔" width="w-full" height="h-full" frameless onClose={onLogout}>
      <div className="p-6 h-full flex flex-col bg-gray-50">
        <h1 className="text-xl font-bold text-gray-900 mb-4">장비 관리</h1>
        <div className="flex gap-2 mb-4">
          <input type="text" placeholder="검색..." className="flex-1 px-3 py-2 border rounded text-sm" value={searchQuery} onChange={(e) => setSearchQuery(e.target.value)} />
          <select
            className="border rounded px-2 text-sm"
            value={groupFilter}
            onChange={(e) => setGroupFilter(e.target.value)}
          >
            <option value="ALL">전체 그룹</option>
            {groups.map(g => <option key={g} value={g}>{g}</option>)}
          </select>
          <Button className="bg-indigo-600">검색</Button>
          <Button variant="secondary" onClick={handleServerConfig}>서버 설정</Button>
        </div>
        <div className="flex-1 bg-white rounded border overflow-hidden shadow-sm flex flex-col mb-4">
          <div className="overflow-auto flex-1">
            <table className="w-full text-left text-sm">
              <thead className="bg-gray-100 text-gray-600 sticky top-0">
                <tr>
                  <th className="px-4 py-3">그룹</th>
                  <th className="px-4 py-3">장비명</th>
                  <th className="px-4 py-3">DESKTOP-NAME</th>
                  <th className="px-4 py-3">사업자번호</th>
                  <th className="px-4 py-3">접속여부</th>
                  <th className="px-4 py-3">상태</th>
                  <th className="px-4 py-3">OS</th>
                  <th className="px-4 py-3">메모</th>
                  <th className="px-4 py-3">마지막접속</th>
                  <th className="px-4 py-3 text-right">제어</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {filteredDevices.length === 0 ? (
                  <tr><td colSpan={10} className="text-center py-8 text-gray-400">접속 장비 없음</td></tr>
                ) : (
                  filteredDevices.map((device) => (
                    <tr key={device.id} className="hover:bg-gray-50 text-xs">
                      <td className="px-4 py-3">{device.groupName || '-'}</td>
                      <td className="px-4 py-3 font-bold">{device.deviceName || '-'}</td>
                      <td className="px-4 py-3">{device.desktopName || device.id}</td>
                      <td className="px-4 py-3">{device.businessId}</td>
                      <td className="px-4 py-3">{device.allowRemote}</td>
                      <td className="px-4 py-3">
                        <span className={`inline-block w-2 h-2 rounded-full mr-2 ${device.status === 'ONLINE' ? 'bg-green-500' : device.status === 'BLOCKED' ? 'bg-red-500' : 'bg-gray-400'}`}></span>
                        {device.status}
                      </td>
                      <td className="px-4 py-3">{device.os || '-'}</td>
                      <td className="px-4 py-3">{device.memo || '-'}</td>
                      <td className="px-4 py-3">{device.lastSeen || '-'}</td>
                      <td className="px-4 py-3 text-right">
                        <button 
                          onClick={() => handleConnect(device)}
                          disabled={device.status !== 'ONLINE' || device.allowRemote !== 'YES'}
                          className={`px-3 py-1 rounded text-white text-xs ${device.status !== 'ONLINE' || device.allowRemote !== 'YES' ? 'bg-gray-300' : 'bg-indigo-600 hover:bg-indigo-700'}`}
                        >
                          원격 접속
                        </button>
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </div>
        <div className="bg-white rounded border overflow-hidden shadow-sm"><CustomerTable /></div>
      </div>
    </WindowFrame>
  );
};

const ToolbarButton: React.FC<{ icon: React.ReactNode, label: string, onClick?: () => void, className?: string, active?: boolean, hasDropdown?: boolean }> = ({ icon, label, onClick, className = '', active, hasDropdown }) => (
    <button onClick={onClick} className={`p-1.5 rounded text-xs flex flex-col items-center gap-1 min-w-[50px] relative hover:bg-gray-700 text-gray-300 hover:text-white ${active ? 'bg-gray-700 text-white' : ''} ${className}`}>
        {icon}
        <span className="flex items-center gap-0.5">{label} {hasDropdown && <svg className="w-2 h-2 opacity-70" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" /></svg>}</span>
    </button>
);

const MenuItem: React.FC<{ label: string, shortcut?: string, onClick: () => void, danger?: boolean }> = ({ label, shortcut, onClick, danger }) => (
    <button onClick={onClick} className={`w-full text-left px-4 py-2 hover:bg-gray-100 flex justify-between items-center group ${danger ? 'text-red-600 hover:bg-red-50' : 'text-gray-700'}`}>
        <span>{label}</span>
        {shortcut && <span className="text-gray-400 text-[10px] bg-gray-100 border px-1 rounded group-hover:bg-white">{shortcut}</span>}
    </button>
);
