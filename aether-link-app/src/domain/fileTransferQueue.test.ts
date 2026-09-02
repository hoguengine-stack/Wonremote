import { describe, expect, it } from "vitest";
import {
  appendFileTransferQueueItems,
  cancelFileTransfer,
  completeFileTransfer,
  createFileTransferQueueItem,
  failFileTransfer,
  getFileTransferEtaSeconds,
  getFileTransferPercent,
  markFileTransferTransferring,
  updateFileTransferProgress,
} from "./fileTransferQueue";

describe("file transfer queue item", () => {
  it("supports immutable create, progress, completion, percent, and ETA", () => {
    const queued = createFileTransferQueueItem({ id: "transfer-1", fileName: "report.zip", totalBytes: 1_000 });
    const transferring = markFileTransferTransferring(queued, 250);
    const progress = updateFileTransferProgress(transferring, 500, 250);
    const completed = completeFileTransfer(progress);

    expect(queued).toMatchObject({ id: "transfer-1", fileName: "report.zip", totalBytes: 1_000, sentBytes: 0, status: "queued" });
    expect(transferring.status).toBe("transferring");
    expect(progress).toMatchObject({ sentBytes: 500, speedBytesPerSecond: 250 });
    expect(getFileTransferPercent(progress)).toBe(50);
    expect(getFileTransferEtaSeconds(progress)).toBe(2);
    expect(completed).toMatchObject({ sentBytes: 1_000, status: "completed" });
    expect(getFileTransferPercent(completed)).toBe(100);
    expect(getFileTransferEtaSeconds(completed)).toBe(0);
  });

  it("clamps progress and exposes terminal failure/cancel states without mutating the source", () => {
    const queued = createFileTransferQueueItem({ id: "transfer-2", fileName: "payload.bin", totalBytes: 100 });
    const progress = updateFileTransferProgress(queued, 500, 0);
    const failed = failFileTransfer(progress, "network error");
    const cancelled = cancelFileTransfer(progress);

    expect(progress).toMatchObject({ sentBytes: 100, status: "transferring", speedBytesPerSecond: 0 });
    expect(getFileTransferPercent(progress)).toBe(100);
    expect(getFileTransferEtaSeconds(progress)).toBe(0);
    expect(failed).toMatchObject({ status: "failed", error: "network error" });
    expect(cancelled).toMatchObject({ status: "cancelled" });
    expect(queued).toMatchObject({ sentBytes: 0, status: "queued" });
  });

  it("keeps every active transfer when a new batch is appended and only trims terminal history", () => {
    const completed = completeFileTransfer(createFileTransferQueueItem({ id: "done", fileName: "done.bin", totalBytes: 1 }));
    const queued = createFileTransferQueueItem({ id: "queued", fileName: "queued.bin", totalBytes: 2 });
    const transferring = markFileTransferTransferring(createFileTransferQueueItem({ id: "active", fileName: "active.bin", totalBytes: 3 }));
    const added = createFileTransferQueueItem({ id: "new", fileName: "new.bin", totalBytes: 4 });

    expect(appendFileTransferQueueItems([completed, queued, transferring], [added], 3).map((item) => item.id))
      .toEqual(["queued", "active", "new"]);
  });
});
