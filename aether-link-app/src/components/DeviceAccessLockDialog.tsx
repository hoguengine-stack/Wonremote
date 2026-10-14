import { useEffect, useRef, useState, type FormEvent } from "react";
import { LockKeyhole, X } from "lucide-react";
import type { ManagedDevice } from "../domain/types";
import { requestFirebaseDeviceAccess } from "../firebase/viewerFirebase";

export interface DeviceUnlockChoice { password: string; durationMinutes?: number; lockVersion?: string }
const unlockDurations = [[15, "15분간"], [60, "1시간"], [180, "3시간"], [480, "8시간"], [720, "12시간"]] as const;

export function DeviceAccessLockDialog({device, connect, onPassword, onSaved, onClose}: {
  device: ManagedDevice;
  connect?: boolean;
  onPassword?: (choice: DeviceUnlockChoice) => void;
  onSaved?: (enabled: boolean, version: string) => void;
  onClose: () => void;
}) {
  const [password, setPassword] = useState("");
  const [durationMinutes, setDurationMinutes] = useState(15);
  const [nextPassword, setNextPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [reset, setReset] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const controller = useRef<AbortController | null>(null);
  const input = useRef<HTMLInputElement | null>(null);
  const requiresPassword = connect || device.accessLocked || reset;
  useEffect(() => {
    const previous = document.activeElement;
    input.current?.focus();
    return () => { controller.current?.abort(); if (previous instanceof HTMLElement) previous.focus(); };
  }, []);
  useEffect(() => {
    const escape = (event: KeyboardEvent) => { if (event.key === "Escape" && !busy) onClose(); };
    window.addEventListener("keydown", escape); return () => window.removeEventListener("keydown", escape);
  }, [onClose, busy]);
  async function submit(event: FormEvent, disable = false) {
    event.preventDefault();
    if (busy) return;
    if (connect) {
      if (!unlockDurations.some(([minutes]) => minutes === durationMinutes)) { setError("잠금 해제 유지시간을 선택하세요."); return; }
      onPassword?.({password, durationMinutes}); return;
    }
    if (!disable && (nextPassword.length < 4 || nextPassword.length > 64 || nextPassword !== confirmation)) {
      setError(nextPassword !== confirmation ? "새 비밀번호가 일치하지 않습니다." : "비밀번호는 4~64자로 입력하세요."); return;
    }
    const abort = new AbortController(); controller.current = abort;
    setBusy(true); setError("");
    try {
      const result = await requestFirebaseDeviceAccess(device.id, disable ? "disable" : reset ? "reset" : "set", {password, ...(disable ? {} : {newPassword:nextPassword})}, "", abort.signal);
      if (!abort.signal.aborted) { setPassword(""); setNextPassword(""); setConfirmation(""); onSaved?.(!disable, result.version); onClose(); }
    } catch (cause) { if (!abort.signal.aborted) setError(cause instanceof Error ? cause.message : "잠금 설정을 저장하지 못했습니다."); }
    finally { if (!abort.signal.aborted) setBusy(false); }
  }
  return <div className="modal-backdrop" role="presentation" onMouseDown={() => { if (!busy) onClose(); }}>
    <section className="modal-panel device-access-dialog" role="dialog" aria-modal="true" aria-labelledby="device-access-title" onMouseDown={event => event.stopPropagation()} onKeyDown={event => {
      if (event.key !== "Tab") return;
      const controls = [...event.currentTarget.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), select:not(:disabled)')];
      const first = controls[0], last = controls[controls.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    }}>
      <div className="section-heading"><h2 id="device-access-title"><LockKeyhole size={20}/> {connect ? "잠금 장비 접속" : reset ? "접속 비밀번호 재설정" : "원격 접속 잠금"}</h2>
        <button type="button" className="secondary-button" aria-label="잠금 창 닫기" disabled={busy} onClick={onClose}><X size={18}/></button></div>
      <p>{device.storeName} · {device.desktopName}</p>
      <form onSubmit={event => void submit(event)}>
        <fieldset disabled={busy}>
          {requiresPassword && <label>{reset ? "관리자 비밀번호" : "접속 비밀번호"}<input ref={input} aria-label={reset ? "관리자 비밀번호" : "접속 비밀번호"} type="password" value={password} maxLength={64} required autoComplete="off" onChange={event => {setPassword(event.target.value); setError("");}}/></label>}
          {connect && <label>이 PC의 잠금 해제 유지시간<select value={durationMinutes} onChange={event => setDurationMinutes(Number(event.target.value))}>
            {unlockDurations.map(([minutes, label]) => <option key={minutes} value={minutes}>{label}</option>)}
          </select></label>}
          {!connect && <><label>새 비밀번호<input ref={requiresPassword ? undefined : input} type="password" value={nextPassword} minLength={4} maxLength={64} required autoComplete="new-password" onChange={event => setNextPassword(event.target.value)}/></label>
            <label>새 비밀번호 확인<input type="password" value={confirmation} maxLength={64} required autoComplete="new-password" onChange={event => setConfirmation(event.target.value)}/></label></>}
        </fieldset>
        {error && <p className="form-error" role="alert">{error}</p>}
        <div className="modal-actions">
          {device.accessLocked && !connect && !reset && <button type="button" className="secondary-button" disabled={busy || !password} onClick={event => void submit(event, true)}>잠금 해제</button>}
          {device.accessLocked && !connect && <button type="button" className="secondary-button" disabled={busy} onClick={() => {setReset(!reset); setPassword(""); setError("");}}>{reset ? "비밀번호로 변경" : "비밀번호 분실"}</button>}
          <button type="submit" className="primary-button" disabled={busy}>{busy ? "처리 중" : connect ? "접속" : reset ? "재설정" : "잠금 저장"}</button>
        </div>
      </form>
    </section>
  </div>;
}
