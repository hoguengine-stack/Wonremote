export const CAPTURE_DIAGNOSTIC_LIMIT = 16 * 1024;

export function appendCaptureDiagnostic(tail: string, chunk: string): string {
  return (tail + chunk).slice(-CAPTURE_DIAGNOSTIC_LIMIT);
}
