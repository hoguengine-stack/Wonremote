export function sessionIdFromStartStreamCommand(
  action: string,
  input: { deviceId: string; firebaseEnabled: boolean },
): string | null {
  const match = /^start-stream(?:\s+(.+))?$/.exec(action.trim());
  if (!match) {
    return null;
  }
  const explicitSessionId = match[1]?.trim();
  if (explicitSessionId) {
    return explicitSessionId;
  }
  return input.firebaseEnabled ? null : `session-${input.deviceId}`;
}

export function stopStreamTargetFromCommand(action: string): string | undefined | null {
  const match = /^stop-stream(?:\s+(.+))?$/.exec(action.trim());
  if (!match) {
    return null;
  }
  return match[1]?.trim() || undefined;
}

export function shouldStopActiveSession(
  activeSessionId: string | null,
  requestedSessionId: string | undefined,
  firebaseEnabled: boolean,
): boolean {
  if (!activeSessionId) {
    return false;
  }
  if (requestedSessionId) {
    return requestedSessionId === activeSessionId;
  }
  return !firebaseEnabled;
}

export function currentSessionId(
  activeSessionId: string | null,
  input: { deviceId: string; firebaseEnabled: boolean },
): string | null {
  if (activeSessionId) {
    return activeSessionId;
  }
  return input.firebaseEnabled ? null : `session-${input.deviceId}`;
}

export interface AgentStreamGenerationState {
  activeSessionId: string | null;
  captureGeneration: number;
  sessionGeneration: number;
}

export function beginAgentCaptureGeneration(
  state: AgentStreamGenerationState,
  sessionId: string,
): AgentStreamGenerationState & { sessionChanged: boolean } {
  const sessionChanged = state.activeSessionId !== sessionId;
  return {
    activeSessionId: sessionId,
    captureGeneration: state.captureGeneration + 1,
    sessionGeneration: state.sessionGeneration + (sessionChanged ? 1 : 0),
    sessionChanged,
  };
}

export function endAgentSessionGeneration(
  state: AgentStreamGenerationState,
): AgentStreamGenerationState {
  return {
    activeSessionId: null,
    captureGeneration: state.captureGeneration + 1,
    sessionGeneration: state.sessionGeneration + 1,
  };
}
