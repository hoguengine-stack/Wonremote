import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const projectRoot = process.cwd();

describe("stream performance mode integration", () => {
  const readBlock = (source: string, startMarker: string, endMarker: string) => {
    const start = source.indexOf(startMarker);
    const end = source.indexOf(endMarker, start);
    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    return source.slice(start, end);
  };

  it("connects the Viewer mode selector to the Agent capture profile", () => {
    const appSource = readFileSync(path.join(projectRoot, "src", "App.tsx"), "utf8");
    const agentSource = readFileSync(path.join(projectRoot, "src", "agent", "index.ts"), "utf8");

    expect(appSource).toContain("stream-mode-control");
    expect(appSource).toContain("buildSetStreamModeCommand");
    expect(agentSource).toContain('"--jpeg-quality"');
    expect(agentSource).toContain('"--max-merge-width"');
    expect(agentSource).toContain("currentStreamProfile.maxBufferedAmount");
  });

  it("persists the Viewer mode and sends the matching Agent command", () => {
    const appSource = readFileSync(path.join(projectRoot, "src", "App.tsx"), "utf8");
    const modeEffect = readBlock(appSource, "useEffect(() => {\n    if (!sessionId", "useEffect(() => {\n    pingStateRef.current");
    const selector = readBlock(appSource, "const selectStreamPerformanceMode", "// Recording");

    expect(selector).toContain('window.localStorage.setItem("wonremote-stream-performance-mode", mode)');
    expect(modeEffect).toContain("buildSetStreamModeCommand(streamPerformanceMode)");
    expect(modeEffect).toContain("onInputEvent(buildSetStreamModeCommand(streamPerformanceMode))");
  });

  it("does not let Visual Ping overwrite the user's stream mode", () => {
    const appSource = readFileSync(path.join(projectRoot, "src", "App.tsx"), "utf8");
    const pingBlock = readBlock(appSource, "const startVisualPing", "// Recording");
    const renderBlock = readBlock(appSource, "const measurePresentedPing", "const renderDeltaFrame");

    expect(pingBlock).toContain('onInputEvent("ping-color-change")');
    expect(renderBlock).not.toContain("onInputEvent(sleepCommand)");
  });

  it("applies the fast backpressure limit only to delta frames", () => {
    const agentSource = readFileSync(path.join(projectRoot, "src", "agent", "index.ts"), "utf8");
    const frameBlock = readBlock(agentSource, "const sendResult = USE_FIREBASE", "if (sendResult === \"sent\")");

    expect(frameBlock).toContain("framePayload.keyframe ? undefined : currentStreamProfile.maxBufferedAmount");
  });

  it("keeps benchmark comparison work out of the realtime capture loop", () => {
    const rustSource = readFileSync(
      path.join(projectRoot, "..", "aether-link-poc", "src", "main.rs"),
      "utf8",
    );
    const streamStart = rustSource.indexOf("async fn run_streaming_loop");
    const streamEnd = rustSource.indexOf("const MAX_INPUT_SERVER_ID_BYTES", streamStart);
    const streamBlock = rustSource.slice(streamStart, streamEnd);

    expect(streamStart).toBeGreaterThanOrEqual(0);
    expect(streamEnd).toBeGreaterThan(streamStart);
    expect(streamBlock).toContain("config.jpeg_quality");
    expect(streamBlock).toContain("config.max_merge_width");
    expect(streamBlock).not.toContain("before_jpeg_bytes");
    expect(streamBlock).not.toContain("[Tile Merge Stats]");
  });
});
