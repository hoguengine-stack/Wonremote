import { expect, it } from "vitest";
import { createDiagnosticReport, nativeDiagnosticExportUrl } from "./diagnosticReport";
import type { ManagedDevice } from "./types";

it("hands off the exact preview only to an advertised native export handler", () => {
  const report = JSON.stringify({schemaVersion:1,presence:"online"},null,2);
  expect(nativeDiagnosticExportUrl(report,"Chrome Android")).toBeNull();
  const url = new URL(nativeDiagnosticExportUrl(report,"Chrome Android WonRemoteViewer/1")!);
  expect(url.protocol).toBe("wonremote-diagnostics:");
  expect(url.searchParams.get("report")).toBe(report);
  expect(nativeDiagnosticExportUrl(report,"WonRemoteViewer/10")).toBeNull();
});

it("exports useful telemetry without free-form credentials, device identifiers or clipboard", () => {
  const device = { id: "SECRET", notes: "SECRET", connectionCode: "SECRET", desktopName: "SECRET", password: "SECRET", clipboard: "SECRET", version: "0.1.93", status: "online", lastSeenAt: "2026-09-14T00:00:00Z", streamDiagnostics: { rtcState: "ready", running: true, bufferedAmount: 120, rtcError: "Bearer SECRET", lastError: "SECRET" }, controlDiagnostics: { win32ErrorCode: 5, win32ErrorMessage: "SECRET" }, updateError: "SECRET" } as unknown as ManagedDevice;
  const report = createDiagnosticReport(device, "0.1.93");
  expect(JSON.stringify(report)).not.toContain("SECRET");
  expect(report.screen).toMatchObject({ connection: "ready", running: true, bufferedBytes: 120, hasConnectionError: true });
  expect(report.windows.errorCode).toBe(5);
});

it("does not export arbitrary strings smuggled into typed fields", () => {
  const report = createDiagnosticReport({ version: "SECRET", status: "SECRET", streamDiagnostics: { rtcState: "SECRET", bufferedAmount: "SECRET" } } as unknown as ManagedDevice, "SECRET");
  expect(JSON.stringify(report)).not.toContain("SECRET");
});
