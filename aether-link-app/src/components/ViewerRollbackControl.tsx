import React, { useRef, useState } from "react";
import { createPortal } from "react-dom";
import { RotateCcw } from "lucide-react";
import { isHigherVersion } from "../domain/versioning";

export function ViewerRollbackControl({ currentVersion, restore, agentName }: { currentVersion: string; restore: (version: string) => Promise<void>; agentName?: string }) {
  const title = agentName ? "에이전트 이전 버전 복구" : "뷰어 이전 버전 복구";
  const dialog = useRef<HTMLDialogElement>(null);
  const busy = useRef(false);
  const [version, setVersion] = useState("");
  const [confirmed, setConfirmed] = useState(false);
  const [status, setStatus] = useState("");
  const [submitted, setSubmitted] = useState(false);
  const valid = /^(0|[1-9]\d{0,5})\.(0|[1-9]\d{0,5})\.(0|[1-9]\d{0,5})$/.test(version) && isHigherVersion(currentVersion, version);
  return <>
    <button className="viewer-update-button" type="button" title={title} aria-label={title} onClick={() => dialog.current?.showModal()}><RotateCcw size={16} /><span>버전 복구</span></button>
    {createPortal(<dialog ref={dialog} aria-label={title} onMouseDown={event => event.stopPropagation()} onKeyDown={event => event.stopPropagation()} style={{ maxWidth: "min(420px, calc(100% - 32px))", borderRadius: 8, padding: 24, border: "1px solid #cbd5df", color: "#263444" }}>
      <form onSubmit={async event => {
        event.preventDefault();
        event.stopPropagation();
        if (!valid || !confirmed || busy.current || submitted) return;
        busy.current = true; setSubmitted(true); setStatus("복구 요청 중");
        try { await restore(version); setStatus(agentName ? "복구 요청됨 · 자동 업데이트 중지 · 세션 종료 후 실행" : "복구 요청됨 · 검증 후 뷰어가 재시작됩니다."); }
        catch (error) { setStatus(error instanceof Error ? error.message : "복구 요청 실패"); setSubmitted(false); }
        finally { busy.current = false; }
      }}>
        <h2>{title}</h2>
        {agentName && <p>대상 PC: {agentName}</p>}
        <p>현재 버전: {currentVersion}</p>
        <label>복구할 버전 <input aria-label="복구할 버전" value={version} disabled={submitted} placeholder="0.1.90" onChange={event => { setVersion(event.target.value); setConfirmed(false); }} /></label>
        <p>{agentName ? "이 PC의 자동 업데이트를 중지하고 원격 세션 종료 후 에이전트를 복구합니다." : "현재 뷰어가 종료됩니다."} 이전 버전에서는 일부 기능이나 설정을 사용할 수 없을 수 있습니다.</p>
        <label style={{ display: "flex", alignItems: "center", gap: 8 }}><input style={{ width: 18, height: 18, flexShrink: 0, margin: 0 }} type="checkbox" checked={confirmed} disabled={submitted} onChange={event => setConfirmed(event.target.checked)} />{agentName ? "자동 업데이트 중지와 에이전트 이전 버전 설치에 동의합니다." : "이전 버전 설치와 뷰어 재시작에 동의합니다."}</label>
        <p role="status">{status}</p>
        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
          <button className="secondary-button" type="button" onClick={() => dialog.current?.close()}>닫기</button>
          <button className="primary-button" type="submit" disabled={!valid || !confirmed || submitted}>복구 실행</button>
        </div>
      </form>
    </dialog>, document.body)}
  </>;
}
