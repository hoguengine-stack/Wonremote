import { useEffect, type RefObject } from "react";

type KeyboardHandler = (event: KeyboardEvent) => void | Promise<void>;

export function DesktopRemoteKeyboardRecovery({
  enabled,
  imeInputRef,
  isLocalControlTarget,
  onKeyDown,
  onKeyUp,
  panelRef,
}: {
  enabled: boolean;
  imeInputRef: RefObject<HTMLTextAreaElement | null>;
  isLocalControlTarget: (target: EventTarget | null) => boolean;
  onKeyDown: KeyboardHandler;
  onKeyUp: KeyboardHandler;
  panelRef: RefObject<HTMLElement | null>;
}) {
  useEffect(() => {
    if (!enabled) {
      return;
    }

    const eventBelongsToPanel = (event: KeyboardEvent) => {
      const panel = panelRef.current;
      return panel !== null && event.target instanceof Node && panel.contains(event.target);
    };
    const focusRemoteInput = () => {
      if (!isLocalControlTarget(document.activeElement)) {
        imeInputRef.current?.focus({ preventScroll: true });
      }
    };
    const handleWindowKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || eventBelongsToPanel(event) || isLocalControlTarget(event.target)) {
        return;
      }
      focusRemoteInput();
      void onKeyDown(event);
    };
    const handleWindowKeyUp = (event: KeyboardEvent) => {
      if (event.defaultPrevented || eventBelongsToPanel(event) || isLocalControlTarget(event.target)) {
        return;
      }
      void onKeyUp(event);
    };

    window.addEventListener("focus", focusRemoteInput);
    window.addEventListener("keydown", handleWindowKeyDown);
    window.addEventListener("keyup", handleWindowKeyUp);
    return () => {
      window.removeEventListener("focus", focusRemoteInput);
      window.removeEventListener("keydown", handleWindowKeyDown);
      window.removeEventListener("keyup", handleWindowKeyUp);
    };
  }, [enabled, imeInputRef, isLocalControlTarget, onKeyDown, onKeyUp, panelRef]);

  return null;
}
