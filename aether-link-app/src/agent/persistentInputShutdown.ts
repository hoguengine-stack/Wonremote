import { recordSuccessfulInjectAction } from "./agentCommandActions";
import {
  pointerReleaseActions,
  recordSuccessfulPointerAction,
  type AgentPointerState,
} from "./agentPointerState";

export interface ClosableInputInjector {
  close: (reason: string) => void;
  inject: (action: string) => Promise<void>;
}

export interface AgentPressedInputState {
  pointer: AgentPointerState;
  pressedKeys: Set<string>;
}

export async function releasePressedInput(
  injector: ClosableInputInjector,
  state: AgentPressedInputState,
  warn: (message: string) => void = console.warn,
): Promise<void> {
  const releaseActions = [
    ...[...state.pressedKeys].reverse().map((key) => `key-up ${key}`),
    ...pointerReleaseActions(state.pointer),
  ];
  try {
    for (const action of releaseActions) {
      try {
        await injector.inject(action);
        recordSuccessfulInjectAction(action, state.pressedKeys);
        recordSuccessfulPointerAction(action, state.pointer);
      } catch (error) {
        try {
          warn(
            `[Input shutdown] ${action} failed: ${error instanceof Error ? error.message : error}`,
          );
        } catch {
          // Shutdown must continue even if diagnostics fail.
        }
      }
    }
  } finally {
    state.pressedKeys.clear();
    state.pointer.pressedButtons.clear();
  }
}

export async function releasePressedInputAndClose(
  injector: ClosableInputInjector,
  state: AgentPressedInputState,
  reason: string,
  warn: (message: string) => void = console.warn,
): Promise<void> {
  try {
    await releasePressedInput(injector, state, warn);
  } finally {
    injector.close(reason);
  }
}
