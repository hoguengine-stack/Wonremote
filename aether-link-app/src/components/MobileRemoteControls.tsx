import { useEffect, useRef, useState } from "react";
import { ArrowDown, ArrowUp, Keyboard, MousePointer2, Pin, Settings2, ZoomIn, ZoomOut } from "lucide-react";

const keyGroups = {
  "이동": ["Esc", "Tab", "Insert", "Delete", "Home", "End", "PageUp", "PageDown", "Left", "Up", "Down", "Right", "Enter", "Backspace"],
  "F1–F12": Array.from({ length: 12 }, (_, i) => `F${i + 1}`),
  "단축키": ["Ctrl+C", "Ctrl+V", "Ctrl+X", "Ctrl+A", "Ctrl+Z", "Alt+Tab", "Win+D", "Win+E"],
};

const pinnedKeysStorage = "wonremote-pinned-keys";
const availableKeys = Object.values(keyGroups).flat();
function readPinnedKeys(): string[] {
  try {
    const saved: unknown = JSON.parse(localStorage.getItem(pinnedKeysStorage) ?? "null");
    if (Array.isArray(saved)) return [...new Set(saved.filter((key): key is string =>
      typeof key === "string" && availableKeys.includes(key)))].slice(0, 6);
  } catch { /* Unavailable storage must not prevent remote controls from opening. */ }
  return ["Alt+Tab", "Win+D", "Esc"];
}

export function useMobileRemoteHeight(enabled: boolean) {
  const [height, setHeight] = useState<number>();
  useEffect(() => {
    if (!enabled) return;
    const viewport = window.visualViewport;
    const resize = () => {
      const portrait = window.screen.orientation?.type
        ? window.screen.orientation.type.startsWith("portrait")
        : window.screen.height >= window.screen.width;
      setHeight(portrait ? (viewport?.height ?? window.innerHeight) : undefined);
    };
    resize();
    viewport?.addEventListener("resize", resize);
    window.addEventListener("resize", resize);
    return () => {
      viewport?.removeEventListener("resize", resize);
      window.removeEventListener("resize", resize);
    };
  }, [enabled]);
  return height;
}

export function MobileRemoteControls({ send, click, scroll, keyboard, zoom, settings, settingsOpen = false, closeSettings, touchpad = false, toggleTouchpad, connectionStatus, deviceName }: {
  connectionStatus?: string;
  deviceName?: string;
  touchpad?: boolean;
  toggleTouchpad?: () => void;
  send: (command: string) => unknown;
  click: (button: 0 | 2) => void;
  scroll: (delta: number) => void;
  keyboard: () => void;
  zoom: (delta: number) => void;
  settings: () => void;
  settingsOpen?: boolean;
  closeSettings?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [pinned, setPinned] = useState(readPinnedKeys);
  const [editingPins, setEditingPins] = useState(false);
  const [pinError, setPinError] = useState(false);
  const togglePin = (key: string) => {
    const next = pinned.includes(key) ? pinned.filter((item) => item !== key) : [...pinned, key].slice(0, 6);
    setPinned(next);
    try {
      localStorage.setItem(pinnedKeysStorage, JSON.stringify(next));
      setPinError(false);
    } catch { setPinError(true); }
  };
  const [group, setGroup] = useState<keyof typeof keyGroups>("이동");
  const [held, setHeld] = useState<string[]>([]);
  const heldRef = useRef<string[]>([]);
  const sendRef = useRef(send);
  sendRef.current = send;
  const release = () => {
    for (const key of heldRef.current) sendRef.current(`key-up ${key}`);
    heldRef.current = [];
    setHeld([]);
  };
  useEffect(() => { if (settingsOpen) { release(); setOpen(false); } }, [settingsOpen]);
  useEffect(() => {
    const hide = () => { if (document.hidden) release(); };
    window.addEventListener("blur", release);
    document.addEventListener("visibilitychange", hide);
    return () => {
      window.removeEventListener("blur", release);
      document.removeEventListener("visibilitychange", hide);
      release();
    };
  }, []);
  const toggle = (key: string) => {
    const down = !heldRef.current.includes(key);
    send(`key-${down ? "down" : "up"} ${key}`);
    heldRef.current = down ? [...heldRef.current, key] : heldRef.current.filter((item) => item !== key);
    setHeld([...heldRef.current]);
  };
  const press = (chord: string) => {
    const keys = chord.split("+").filter((key) => !heldRef.current.includes(key));
    for (const key of keys) send(`key-down ${key}`);
    for (const key of [...keys].reverse()) send(`key-up ${key}`);
  };
  const touchButton = useRef<HTMLButtonElement | null>(null);
  return <div className="mobile-remote-controls"
    onPointerDown={(event) => {
      event.preventDefault();
      const button = (event.target as Element).closest("button");
      if (button?.getAttribute("aria-label") !== "키보드") {
        const input = document.activeElement;
        if (input instanceof HTMLTextAreaElement && input.dataset.remoteImeInput === "true") input.blur();
      }
      if (event.pointerType === "touch") {
        touchButton.current = (event.target as Element).closest("button");
      }
    }}
    onPointerUp={(event) => {
      if (event.pointerType !== "touch") return;
      const button = touchButton.current;
      touchButton.current = null;
      event.preventDefault();
      if (button && button === (event.target as Element).closest("button")) button.click();
    }}
    onPointerCancel={() => { touchButton.current = null; }}
    onClickCapture={(event) => {
      // Touch is activated on pointerup; ignore the browser's compatibility click.
      if ((event.nativeEvent as PointerEvent).pointerType === "touch") {
        event.preventDefault();
        event.stopPropagation();
      }
    }}>
    {connectionStatus && <div className="mobile-session-status" data-testid="mobile-connection-status" role="status" aria-live="polite">
      <span title={deviceName}>{deviceName}</span><strong>{connectionStatus}</strong>
    </div>}
    {open && <div className="mobile-key-panel" aria-label="Windows 키보드">
      <div className="mobile-key-modifiers">{["Ctrl", "Alt", "Shift", "Win"].map((key) =>
        <button key={key} type="button" aria-pressed={held.includes(key)} onClick={() => toggle(key)}>{key}</button>)}</div>
      <button type="button" title="고정 단축키 편집" aria-label="고정 단축키 편집" aria-pressed={editingPins} onClick={() => setEditingPins(!editingPins)}><Pin size={18}/></button>
      <div className="mobile-key-tabs" role="tablist">{Object.keys(keyGroups).map((key) =>
        <button key={key} role="tab" type="button" aria-selected={group === key} onClick={() => setGroup(key as keyof typeof keyGroups)}>{key}</button>)}</div>
      <div className="mobile-key-grid">{keyGroups[group].map((key) =>
        <button key={key} type="button" aria-pressed={editingPins ? pinned.includes(key) : undefined}
          disabled={editingPins && pinned.length >= 6 && !pinned.includes(key)}
          onClick={() => editingPins ? togglePin(key) : press(key)}>{key}{editingPins && pinned.includes(key) && <Pin size={12}/>}</button>)}</div>
    </div>}
    {pinError && <div role="status">단축키를 저장하지 못했습니다. 이번 접속에서만 유지됩니다.</div>}
    {(pinned.length > 0 || toggleTouchpad) && <div className="mobile-pinned-keys" role="toolbar" aria-label="고정 단축키">
      {toggleTouchpad && <button type="button" aria-label="터치패드 모드" aria-pressed={touchpad} onClick={toggleTouchpad}>{touchpad ? "터치패드" : "화면 이동"}</button>}
      {pinned.map((key) => <button type="button" key={key} onClick={() => press(key)}>{key}</button>)}
    </div>}
    <div className="mobile-touch-bar" role="toolbar" aria-label="원격 조작">
      <button type="button" title="좌클릭" aria-label="좌클릭" onClick={() => click(0)}><MousePointer2 size={20}/><small>L</small></button>
      <button type="button" title="우클릭" aria-label="우클릭" onClick={() => click(2)}><MousePointer2 size={20}/><small>R</small></button>
      <button type="button" title="위로 스크롤" aria-label="위로 스크롤" onClick={() => scroll(120)}><ArrowUp size={20}/></button>
      <button type="button" title="아래로 스크롤" aria-label="아래로 스크롤" onClick={() => scroll(-120)}><ArrowDown size={20}/></button>
      <button type="button" title="키보드" aria-label="키보드" onClick={keyboard}><Keyboard size={20}/></button>
      <button type="button" title="Windows 특수키" aria-label="Windows 특수키" aria-expanded={open} onClick={() => { closeSettings?.(); if (open) release(); setOpen(!open); }}>Fn</button>
      <button type="button" title="축소" aria-label="축소" onClick={() => zoom(-0.05)}><ZoomOut size={20}/></button>
      <button type="button" title="확대" aria-label="확대" onClick={() => zoom(0.05)}><ZoomIn size={20}/></button>
      <button type="button" title="화면 및 세션 설정" aria-label="화면 및 세션 설정" aria-expanded={settingsOpen} onClick={settings}><Settings2 size={20}/></button>
    </div>
  </div>;
}
