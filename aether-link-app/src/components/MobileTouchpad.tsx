import { useEffect, useRef } from "react";

export function MobileTouchpad({ move, button, scroll }: {
  move: (x: number, y: number) => void;
  button: (down: boolean) => void;
  scroll: (delta: number) => void;
}) {
  const points = useRef(new Map<number, {x: number; y: number}>());
  const state = useRef({x: 0, y: 0, start: 0, moved: false, multi: false, dragging: false, lastTap: -Infinity});
  const buttonRef = useRef(button);
  buttonRef.current = button;
  const cancel = () => {
    if (state.current.dragging) buttonRef.current(false);
    state.current.dragging = false;
    state.current.lastTap = -Infinity;
    points.current.clear();
  };
  useEffect(() => {
    const hidden = () => { if (document.hidden) cancel(); };
    window.addEventListener("blur", cancel);
    document.addEventListener("visibilitychange", hidden);
    return () => {
      window.removeEventListener("blur", cancel);
      document.removeEventListener("visibilitychange", hidden);
      cancel();
    };
  }, []);
  return <div className="mobile-touchpad-surface" aria-label="원격 터치패드"
    onContextMenu={e => e.preventDefault()}
    onPointerDown={e => {
      e.preventDefault(); e.stopPropagation();
      if (points.current.size >= 2) return;
      const s = state.current;
      if (points.current.size === 0) {
        const now = performance.now();
        s.dragging = now - s.lastTap < 350 && Math.hypot(e.clientX-s.x,e.clientY-s.y) < 28;
        s.x = e.clientX; s.y = e.clientY; s.start = now; s.moved = false; s.multi = false;
        if (s.dragging) button(true);
      } else {
        s.multi = true; s.lastTap = -Infinity;
        if (s.dragging) { button(false); s.dragging = false; }
      }
      points.current.set(e.pointerId, {x:e.clientX,y:e.clientY});
      e.currentTarget.setPointerCapture(e.pointerId);
    }}
    onPointerMove={e => {
      const p = points.current.get(e.pointerId);
      if (!p) return;
      e.preventDefault(); e.stopPropagation();
      const dx=e.clientX-p.x, dy=e.clientY-p.y;
      points.current.set(e.pointerId,{x:e.clientX,y:e.clientY});
      const s=state.current;
      if (Math.hypot(e.clientX-s.x,e.clientY-s.y)>5) s.moved=true;
      if (points.current.size===2) { if (dy) scroll(-dy*2); }
      else if (!s.multi && (dx || dy)) move(dx,dy);
    }}
    onPointerUp={e => {
      e.preventDefault(); e.stopPropagation();
      if (!points.current.delete(e.pointerId)) return;
      const s=state.current;
      if (points.current.size===0) {
        if (s.dragging) { button(false); s.dragging=false; s.lastTap=-Infinity; }
        else if (!s.multi && !s.moved && performance.now()-s.start<300) {
          button(true); button(false); s.lastTap=performance.now();
        } else s.lastTap=-Infinity;
      }
      if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
    }}
    onPointerCancel={cancel}
    onLostPointerCapture={e => { if (points.current.has(e.pointerId)) cancel(); }} />;
}
