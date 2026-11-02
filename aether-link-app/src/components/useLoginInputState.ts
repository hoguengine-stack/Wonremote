import {useCallback,useEffect,useRef,useState,type KeyboardEvent} from "react";
import {invoke} from "@tauri-apps/api/core";

type InputMode="ko"|"en"|"other"|"unknown";
export function useLoginInputState(){
  const [capsLock,setCapsLock]=useState<boolean|null>(null),[inputMode,setInputMode]=useState<InputMode>("unknown"),[composing,setComposing]=useState(false);
  const isComposing=useRef(false),live=useRef(false),epoch=useRef(0),pending=useRef(false),queued=useRef(false);
  const refresh=useCallback(function refresh(){
    if(!live.current||!(window as any).__TAURI_INTERNALS__)return;
    const request=++epoch.current;
    if(pending.current){queued.current=true;return;}
    pending.current=true;
    void invoke<{capsLock:boolean|null;inputMode:InputMode}>("get_login_input_state").then(value=>{
      if(!live.current||request!==epoch.current||!value||typeof value!=="object")return;
      setCapsLock(typeof value.capsLock==="boolean"?value.capsLock:null);
      setInputMode(["ko","en","other","unknown"].includes(value.inputMode)?value.inputMode:"unknown");
    },()=>{if(live.current&&request===epoch.current)setInputMode("unknown");}).finally(()=>{
      pending.current=false;
      if(queued.current&&live.current){queued.current=false;refresh();}
    });
  },[]);
  useEffect(()=>{
    live.current=true;refresh();window.addEventListener("focus",refresh);
    return()=>{live.current=false;epoch.current++;queued.current=false;window.removeEventListener("focus",refresh);};
  },[refresh]);
  function key(event:KeyboardEvent){
    setCapsLock(event.getModifierState("CapsLock"));
    if(event.key==="Enter"&&(event.repeat||event.nativeEvent.isComposing||isComposing.current))event.preventDefault();
    if(event.type==="keyup"&&(/^(CapsLock|HangulMode|Alt|Shift|Control|Meta)$/.test(event.key)||["Lang1","AltRight"].includes(event.code)))refresh();
  }
  return {capsLock,inputMode,composing,isComposing,refresh,handlers:{
    onFocusCapture:refresh,onKeyDown:key,onKeyUp:key,
    onCompositionStart:()=>{isComposing.current=true;setComposing(true);refresh();},
    onCompositionEnd:()=>{isComposing.current=false;setComposing(false);refresh();},
  }};
}
