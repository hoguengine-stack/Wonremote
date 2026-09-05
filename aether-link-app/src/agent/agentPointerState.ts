export type AgentMouseButton = "left" | "middle" | "right";

export interface AgentPointerState {
  lastDx: number;
  lastDy: number;
  pressedButtons: Set<AgentMouseButton>;
}

export function createAgentPointerState(): AgentPointerState {
  return {
    lastDx: 32768,
    lastDy: 32768,
    pressedButtons: new Set<AgentMouseButton>(),
  };
}

export function recordSuccessfulPointerAction(action: string, state: AgentPointerState): void {
  const buttonMatch = /^mouse-(down|up)\s+(-?\d+)\s+(-?\d+)\s+(left|middle|right)$/.exec(action.trim());
  if (buttonMatch) {
    state.lastDx = Number(buttonMatch[2]);
    state.lastDy = Number(buttonMatch[3]);
    const button = buttonMatch[4] as AgentMouseButton;
    if (buttonMatch[1] === "down") {
      state.pressedButtons.add(button);
    } else {
      state.pressedButtons.delete(button);
    }
    return;
  }

  const pointerMatch = /^(?:move|mouse-wheel)\s+(-?\d+)\s+(-?\d+)(?:\s+-?\d+)?$/.exec(action.trim());
  if (pointerMatch) {
    state.lastDx = Number(pointerMatch[1]);
    state.lastDy = Number(pointerMatch[2]);
  }
}

export function recordPendingPointerAction(action: string, state: AgentPointerState): void {
  const match = /^mouse-down\s+(-?\d+)\s+(-?\d+)\s+(left|middle|right)$/.exec(action.trim());
  if (!match) {
    return;
  }
  state.lastDx = Number(match[1]);
  state.lastDy = Number(match[2]);
  state.pressedButtons.add(match[3] as AgentMouseButton);
}

export function pointerReleaseActions(state: AgentPointerState): string[] {
  return [...state.pressedButtons]
    .reverse()
    .map((button) => `mouse-up ${state.lastDx} ${state.lastDy} ${button}`);
}
