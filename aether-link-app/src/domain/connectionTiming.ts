// Process-local monotonic timings only: no payloads, identifiers or network calls.
type Stage = "connect-click" | "device-validated" | "command-dispatched" | "offer-sent" | "session-ready" | "command-received" | "command-acknowledged" | "capture-start" | "capture-first-frame" | "channel-open" | "frame-received" | "first-frame-sent" | "first-picture" | "failed";
const traces = new Map<string, { role: "viewer" | "agent"; start: number; stages: Set<Stage>; attempt: number }>();
let attempt = 0;
export function beginConnectionTiming(key: string, role: "viewer" | "agent"): void {
  if (traces.has(key)) return;
  if (traces.size >= 32) traces.delete(traces.keys().next().value!);
  traces.set(key, { role, start: performance.now(), stages: new Set(), attempt: ++attempt });
  markConnectionTiming(key, role === "viewer" ? "connect-click" : "command-received");
}
export function bindConnectionTiming(from: string, to: string): void {
  const trace = traces.get(from); traces.delete(from);
  if (trace) traces.set(to, trace);
}
export function markConnectionTiming(key: string, stage: Stage): void {
  const trace = traces.get(key);
  if (!trace || trace.stages.has(stage)) return;
  trace.stages.add(stage);
  // Deliberately exclude the map key, errors, SDP, device and frame contents.
  console.info(`[ConnectionTiming] ${JSON.stringify({ role: trace.role, attempt: trace.attempt, stage, elapsedMs: Math.round(Math.max(0, performance.now() - trace.start)) })}`);
  if (stage === "first-picture" || stage === "first-frame-sent" || stage === "failed") traces.delete(key);
}
