import { useState } from "react";
import { Check, Pencil, Plus, X } from "lucide-react";
import { DEVICE_TAG_MAX_COUNT, DEVICE_TAG_MAX_LENGTH } from "../domain/agentRegistry";

interface TagPreset { name: string; color: string }
const STORAGE_KEY = "wonremote-device-tag-presets";
const MAX_PRESETS = 40;
const NEW_TAG: TagPreset = {name: "", color: "#19776a"};

function readPresets(): TagPreset[] {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "[]");
    return Array.isArray(value) ? value.filter((item): item is TagPreset => item && typeof item.name === "string"
      && !!item.name.trim() && item.name.length <= DEVICE_TAG_MAX_LENGTH && !item.name.includes(",")
      && /^#[0-9a-f]{6}$/i.test(item.color)).slice(0, MAX_PRESETS) : [];
  } catch { return []; }
}

export function DeviceTagPresets({value, add}: {value: string; add: (name: string) => void}) {
  const [presets, setPresets] = useState(readPresets);
  const [draft, setDraft] = useState<(TagPreset & { original?: string }) | null>(null);
  const [error, setError] = useState("");
  const selected = new Set(value.split(",").map(tag=>tag.trim().toLocaleLowerCase()).filter(Boolean));
  const edit = (tag?: TagPreset) => {setError(""); setDraft(tag ? {...tag,original:tag.name} : NEW_TAG);};
  const save = () => {
    if (!draft) return;
    const name = draft.name.trim();
    if (!name || name.includes(",")) { setError("쉼표 없이 태그 이름을 입력해 주세요."); return; }
    if (presets.some(tag=>tag.name !== draft.original && tag.name.toLocaleLowerCase() === name.toLocaleLowerCase())) {
      setError("이미 저장된 태그입니다."); return;
    }
    const tag = {name, color: draft.color};
    const next = draft.original ? presets.map(item=>item.name === draft.original ? tag : item) : [...presets,tag];
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
      setPresets(next); setDraft(null); setError("");
    } catch { setError("이 PC에 태그를 저장하지 못했습니다."); }
  };
  return <section className="device-tag-presets" aria-label="태그 편집">
    <div className="device-tag-presets-heading"><strong>태그 편집</strong><button type="button" className="custom-group-tool" disabled={presets.length>=MAX_PRESETS} aria-label="자주 쓰는 태그 만들기" title="자주 쓰는 태그 만들기" onClick={()=>edit()}><Plus size={15}/></button></div>
    <div className="device-tag-preset-list">{presets.map(tag=>{
      const applied = selected.has(tag.name.toLocaleLowerCase());
      return <span key={tag.name} className="device-tag-preset">
        <button type="button" disabled={applied || selected.size>=DEVICE_TAG_MAX_COUNT} onClick={()=>add(tag.name)} aria-label={`${tag.name} 태그 추가`}>
          <i style={{backgroundColor:tag.color}} aria-hidden="true"/><span>{tag.name}</span>{applied && <Check size={12}/>}</button>
        <button type="button" className="custom-group-tool" onClick={()=>edit(tag)} aria-label={`${tag.name} 태그 편집`} title={`${tag.name} 태그 편집`}><Pencil size={13}/></button>
      </span>;
    })}</div>
    {draft && <div className="device-tag-preset-form">
      <input aria-label="태그 이름" maxLength={DEVICE_TAG_MAX_LENGTH} value={draft.name} onChange={event=>setDraft({...draft,name:event.target.value})}
        onKeyDown={event=>{if(event.key==="Enter" && !event.nativeEvent.isComposing){event.preventDefault();save();}}}/>
      <input aria-label="태그 색상" type="color" value={draft.color} onChange={event=>setDraft({...draft,color:event.target.value})}/>
      <button type="button" className="custom-group-tool" aria-label="태그 편집 저장" title="태그 편집 저장" onClick={save}><Check size={16}/></button>
      <button type="button" className="custom-group-tool" aria-label="태그 편집 취소" title="태그 편집 취소" onClick={()=>{setDraft(null);setError("");}}><X size={16}/></button>
    </div>}
    {error && <p className="error-text" role="alert">{error}</p>}
  </section>;
}
