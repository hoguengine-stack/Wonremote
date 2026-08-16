import { KeyRound, Plus, Trash2, UserRoundCheck, UserRoundX, X } from "lucide-react";
import { FormEvent, useEffect, useState } from "react";
import {
  createViewerAccount,
  deleteViewerAccount,
  listViewerAccounts,
  updateViewerAccount,
  type ViewerAccount,
} from "../firebase/viewerFirebase";

type Props = {
  onClose: () => void;
};

export function ViewerAccountManager({ onClose }: Props) {
  const [accounts, setAccounts] = useState<ViewerAccount[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [busyUid, setBusyUid] = useState("");
  const [error, setError] = useState("");

  const refresh = async () => {
    setIsLoading(true);
    try {
      setAccounts(await listViewerAccounts());
      setError("");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "계정 목록을 불러오지 못했습니다.");
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    void refresh();
  }, []);

  const handleCreate = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    setBusyUid("new");
    try {
      const displayName = String(data.get("displayName") ?? "").trim();
      await createViewerAccount({
        email: String(data.get("email") ?? ""),
        password: String(data.get("password") ?? ""),
        ...(displayName ? { displayName } : {}),
      });
      form.reset();
      await refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "계정을 만들지 못했습니다.");
    } finally {
      setBusyUid("");
    }
  };

  const handleToggle = async (account: ViewerAccount) => {
    setBusyUid(account.uid);
    try {
      await updateViewerAccount({ uid: account.uid, disabled: !account.disabled });
      await refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "계정 상태를 변경하지 못했습니다.");
    } finally {
      setBusyUid("");
    }
  };

  const handleResetPassword = async (account: ViewerAccount) => {
    const password = window.prompt(`${account.email}의 새 비밀번호를 입력하세요. (8자 이상)`);
    if (password === null) return;
    setBusyUid(account.uid);
    try {
      await updateViewerAccount({ uid: account.uid, password });
      setError("");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "비밀번호를 변경하지 못했습니다.");
    } finally {
      setBusyUid("");
    }
  };

  const handleDelete = async (account: ViewerAccount) => {
    if (!window.confirm(`${account.email} 계정을 삭제하시겠습니까?`)) return;
    setBusyUid(account.uid);
    try {
      await deleteViewerAccount(account.uid);
      await refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "계정을 삭제하지 못했습니다.");
    } finally {
      setBusyUid("");
    }
  };

  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={onClose}>
      <section className="modal-panel account-manager" role="dialog" aria-modal="true" aria-labelledby="account-manager-title" onMouseDown={(event) => event.stopPropagation()}>
        <header className="account-manager-header">
          <div>
            <span className="section-kicker">VIEWER ACCESS</span>
            <h2 id="account-manager-title">Viewer 계정 관리</h2>
          </div>
          <button className="icon-button" type="button" onClick={onClose} aria-label="닫기" title="닫기"><X size={18} /></button>
        </header>

        <form className="account-create-form" onSubmit={handleCreate}>
          <label>이메일<input name="email" type="email" autoComplete="off" required /></label>
          <label>표시 이름<input name="displayName" maxLength={80} /></label>
          <label>임시 비밀번호<input name="password" type="password" minLength={8} autoComplete="new-password" required /></label>
          <button type="submit" disabled={busyUid === "new"}><Plus size={16} />계정 추가</button>
        </form>

        {error && <p className="account-manager-error" role="alert">{error}</p>}
        <div className="account-list">
          {isLoading && <p className="account-list-empty">불러오는 중...</p>}
          {!isLoading && accounts.length === 0 && <p className="account-list-empty">등록된 Viewer 계정이 없습니다.</p>}
          {accounts.map((account) => (
            <div className="account-row" key={account.uid}>
              <div className="account-identity">
                <strong>{account.displayName || account.email}</strong>
                <span>{account.email}</span>
              </div>
              <span className={`account-status ${account.disabled ? "disabled" : "active"}`}>{account.disabled ? "사용 중지" : "사용 가능"}</span>
              <div className="account-actions">
                <button type="button" disabled={account.isAdmin || busyUid === account.uid} onClick={() => void handleResetPassword(account)} title="비밀번호 재설정"><KeyRound size={16} /></button>
                <button type="button" disabled={account.isAdmin || busyUid === account.uid} onClick={() => void handleToggle(account)} title={account.disabled ? "계정 활성화" : "계정 중지"}>{account.disabled ? <UserRoundCheck size={16} /> : <UserRoundX size={16} />}</button>
                <button className="danger" type="button" disabled={account.isAdmin || busyUid === account.uid} onClick={() => void handleDelete(account)} title="계정 삭제"><Trash2 size={16} /></button>
              </div>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}
