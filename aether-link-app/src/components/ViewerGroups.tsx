import { useEffect, useRef, useState } from "react";
import { Folder, FolderPlus, Pencil, Trash2, X } from "lucide-react";
import type { ManagedDevice } from "../domain/types";
import { DEVICE_DRAG_TYPE } from "../domain/deviceOrganization";
import { GROUP_DRAG_TYPE } from "../domain/deviceListPreferences";
import { deleteViewerGroup, groupDeviceIds, saveViewerGroup, type ViewerGroup } from "../domain/viewerGroups";

export function ViewerGroups({groups, devices, selected, select, change}: {
  groups: ViewerGroup[]; devices: ManagedDevice[]; selected: string | null;
  select:(id:string | null)=>void; change:(groups:ViewerGroup[])=>void;
}) {
  const [draft, setDraft] = useState<ViewerGroup | null>(null);
  const [error, setError] = useState("");
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(()=>{if(draft) dialog.current?.showModal();},[draft]);
  const close = () => { setDraft(null); setError(""); };
  const edit = (group: ViewerGroup) => {setDraft({...group,deviceIds:[...group.deviceIds]}); setError("");};
  const add = (parentId: string | null) => edit({id:crypto.getRandomValues(new Uint32Array(4)).join("-"),name:"",parentId,deviceIds:[]});
  const rows = (parentId: string | null, depth = 0): React.ReactNode => groups.filter(g => g.parentId === parentId).map(group => {
    const ids = groupDeviceIds(groups,group.id);
    return <div key={group.id}>
      <div className="custom-group-row" style={{paddingLeft:Math.min(depth,8)*12}}>
        <button type="button" className={`group-button ${selected === group.id ? "active" : ""}`} onClick={()=>select(group.id)}
          onContextMenu={event=>{event.preventDefault();edit(group);}}
          onDragOver={event=>{if(event.dataTransfer.types.some(t=>[DEVICE_DRAG_TYPE,GROUP_DRAG_TYPE].includes(t))) event.preventDefault();}}
          onDrop={event=>{event.preventDefault();const deviceId=event.dataTransfer.getData(DEVICE_DRAG_TYPE); const store=event.dataTransfer.getData(GROUP_DRAG_TYPE);
            const additions=devices.filter(d=>d.id===deviceId || (store && d.storeName===store)).map(d=>d.id);
            if(additions.length) change(saveViewerGroup(groups,{...group,deviceIds:[...group.deviceIds,...additions]}));}}>
          <Folder size={16}/><span className="group-label"><strong>{group.name}</strong></span><b>{devices.filter(d=>ids.has(d.id)).length}</b>
        </button>
        <button type="button" className="custom-group-tool" title={`${group.name} 하위 그룹 생성`} aria-label={`${group.name} 하위 그룹 생성`} onClick={()=>add(group.id)}><FolderPlus size={15}/></button>
        <button type="button" className="custom-group-tool" title={`${group.name} 그룹 수정`} aria-label={`${group.name} 그룹 수정`} onClick={()=>edit(group)}><Pencil size={14}/></button>
      </div>{rows(group.id,depth+1)}
    </div>;
  });
  return <section className="sidebar-section" aria-label="사용자 그룹">
    <div className="sidebar-section-heading"><span>사용자 그룹</span><button type="button" className="custom-group-tool" title="대그룹 생성" aria-label="대그룹 생성" onClick={()=>add(null)}><FolderPlus size={17}/></button></div>
    <div className="group-list">{rows(null)}</div>
    {draft && <dialog ref={dialog} className="custom-group-dialog" aria-label="그룹 편집" onCancel={close} onClick={event=>{if(event.target===event.currentTarget)close();}}>
      <form className="modal-panel custom-group-editor" onMouseDown={event=>event.stopPropagation()}
        onKeyDown={event=>{if(event.key==="Escape"){event.stopPropagation();close();}}}
        onSubmit={event=>{event.preventDefault();try{change(saveViewerGroup(groups,draft));close();}catch(cause){setError(String(cause));}}}>
        <div className="section-heading"><h2>그룹 편집</h2><button type="button" className="custom-group-tool" aria-label="그룹 편집 닫기" onClick={close}><X size={18}/></button></div>
        <label>그룹 이름<input aria-label="그룹 이름" autoFocus required maxLength={100} value={draft.name} onChange={event=>setDraft({...draft,name:event.target.value})}/></label>
        <label>상위 그룹<select aria-label="상위 그룹" value={draft.parentId??""} onChange={event=>setDraft({...draft,parentId:event.target.value||null})}><option value="">없음 (대그룹)</option>{groups.filter(g=>g.id!==draft.id).map(g=><option key={g.id} value={g.id}>{g.name}</option>)}</select></label>
        <fieldset className="custom-group-members"><legend>소속 장비</legend>{devices.map(device=><label key={device.id}><input type="checkbox" checked={draft.deviceIds.includes(device.id)} onChange={event=>setDraft({...draft,deviceIds:event.target.checked?[...draft.deviceIds,device.id]:draft.deviceIds.filter(id=>id!==device.id)})}/><span>{device.storeName} · {device.deviceName}<small>{device.businessNumber} · {device.desktopName}</small></span></label>)}</fieldset>
        {error && <p className="error-text" role="alert">{error}</p>}
        <div className="modal-actions">{groups.some(g=>g.id===draft.id) && <button type="button" className="danger-button" onClick={()=>{change(deleteViewerGroup(groups,draft.id));if(selected===draft.id)select(null);close();}}><Trash2 size={15}/>그룹 삭제</button>}<button type="button" className="secondary-button" onClick={close}>취소</button><button type="submit" className="primary-button compact">저장</button></div>
      </form>
    </dialog>}
  </section>;
}
