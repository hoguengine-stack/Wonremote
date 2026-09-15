import { useLayoutEffect, useRef, useState } from "react";
import type { RefObject } from "react";
import { MousePointer2 } from "lucide-react";
import { MobileTouchpad } from "./MobileTouchpad";

export function MobileRemoteGesturePad({ canvas, viewport, revision, onGesture, portrait = true, pointer, touchpad }: {
  touchpad?: {move: (x: number, y: number) => void; button: (down: boolean) => void; scroll: (delta: number) => void};
  canvas: RefObject<HTMLCanvasElement | null>;
  viewport: RefObject<HTMLDivElement | null>;
  revision: string;
  portrait?: boolean;
  pointer?: {dx: number; dy: number};
  onGesture: (dx: number, dy: number, factor: number) => void;
}) {
  const [bounds, setBounds] = useState({width: 0, height: 0, left: 0, top: 0, right: 0, bottom: 0, imageWidth: 0, imageHeight: 0});
  const points = useRef(new Map<number, {x: number; y: number}>());
  useLayoutEffect(() => {
    const measure = () => {
      const area = viewport.current?.getBoundingClientRect();
      const image = canvas.current?.getBoundingClientRect();
      if (area && image) setBounds({width: area.width, height: area.height,
        left: image.left-area.left, top: image.top-area.top, right: image.right-area.left,
        bottom: image.bottom-area.top, imageWidth: image.width, imageHeight: image.height});
    };
    const observer = new ResizeObserver(measure);
    if (canvas.current) observer.observe(canvas.current);
    if (viewport.current) observer.observe(viewport.current);
    measure();
    return () => observer.disconnect();
  }, [canvas, viewport, revision, portrait]);
  const geometry = () => {
    const [a, b] = [...points.current.values()];
    return b ? {x: (a.x+b.x)/2, y: (a.y+b.y)/2, distance: Math.hypot(a.x-b.x, a.y-b.y)}
      : {x: a.x, y: a.y, distance: 0};
  };
  const left = Math.max(0, Math.min(bounds.width, bounds.left));
  const right = Math.max(left, Math.min(bounds.width, bounds.right));
  const top = Math.max(0, Math.min(bounds.height, bounds.top));
  const bottom = Math.max(top, Math.min(bounds.height, bounds.bottom));
  const regions = [
    {left: 0, top: 0, width: bounds.width, height: top},
    {left: 0, top: bottom, width: bounds.width, height: bounds.height-bottom},
    {left: 0, top, width: left, height: bottom-top},
    {left: right, top, width: bounds.width-right, height: bottom-top},
  ];
  return <div className="mobile-gesture-pad" aria-label="화면 이동 및 확대 축소"
    onPointerDown={event => {
      event.preventDefault(); event.stopPropagation();
      if (points.current.size >= 2) return;
      points.current.set(event.pointerId, {x: event.clientX, y: event.clientY});
      event.currentTarget.setPointerCapture(event.pointerId);
    }}
    onPointerMove={event => {
      if (!points.current.has(event.pointerId)) return;
      event.preventDefault(); event.stopPropagation();
      const before = geometry();
      points.current.set(event.pointerId, {x: event.clientX, y: event.clientY});
      const after = geometry();
      onGesture(after.x-before.x, after.y-before.y, before.distance > 0 ? after.distance/before.distance : 1);
    }}
    onPointerUp={event => {
      event.stopPropagation(); points.current.delete(event.pointerId);
      if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    }}
    onPointerCancel={() => points.current.clear()}
    onLostPointerCapture={event => points.current.delete(event.pointerId)}
    onContextMenu={event => event.preventDefault()}
  >
    {touchpad ? <MobileTouchpad {...touchpad}/> : regions.map((region, index) => <div key={index} className="mobile-gesture-region" style={region} />)}
    {pointer && <MousePointer2 className="mobile-remote-pointer" aria-label="원격 포인터" size={24}
      style={{left: bounds.left + pointer.dx/65535*bounds.imageWidth-3,
        top: bounds.top + pointer.dy/65535*bounds.imageHeight-3}} />}
  </div>;
}
