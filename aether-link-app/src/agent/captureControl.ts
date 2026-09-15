import type { Writable } from "node:stream";

export type CaptureControlInput = Pick<Writable, "destroyed" | "writableEnded" | "write" | "on" | "off">;

export function observeCaptureControlErrors(
  input: CaptureControlInput,
  onFailure: (error: Error) => void,
): () => void {
  const handleError = (error: Error) => onFailure(error);
  input.on("error", handleError);
  return () => input.off("error", handleError);
}

export function writeCaptureControl(
  input: CaptureControlInput | null | undefined,
  command: string,
  onFailure: (error: Error) => void,
): boolean {
  if (!input || input.destroyed || input.writableEnded) {
    return false;
  }

  try {
    input.write(command, (error) => {
      if (error) {
        onFailure(error);
      }
    });
    return true;
  } catch (error) {
    onFailure(error instanceof Error ? error : new Error(String(error)));
    return false;
  }
}
