import { describe, expect, it } from "vitest";
import {
  appendFileTransferQueueItems,
  awaitFileTransferReceipt,
  cancelFileTransfer,
  completeFileTransfer,
  createFileTransferQueueItem,
  failFileTransfer,
  getFileTransferEtaSeconds,
  getFileTransferPercent,
  markFileTransferTransferring,
  pauseFileTransfer,
  updateFileTransferProgress,
} from "./fileTransferQueue";

describe("file transfer queue item", () => {
  it("awaits remote confirmation and preserves early receipt or cancellation", () => {
    const item=createFileTransferQueueItem({id:"a",fileName:"a.txt",totalBytes:10});
    const pending=awaitFileTransferReceipt(item);
    expect(pending.status).toBe("awaiting-receipt");
    expect(failFileTransfer(pending,"disk full").status).toBe("failed");
    expect(completeFileTransfer(pending).status).toBe("completed");
    expect(awaitFileTransferReceipt(completeFileTransfer(item)).status).toBe("completed");
    expect(completeFileTransfer(cancelFileTransfer(pending)).status).toBe("cancelled");
  });
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

  it("keeps a paused transfer resumable without accepting late progress", () => {
    const active = updateFileTransferProgress(
      createFileTransferQueueItem({ id: "pause", fileName: "pause.bin", totalBytes: 100 }),
      40,
      20,
    );
    const paused = pauseFileTransfer(active);

    expect(paused).toMatchObject({ status: "paused", sentBytes: 40, speedBytesPerSecond: 0 });
    expect(updateFileTransferProgress(paused, 80, 20)).toBe(paused);
    expect(awaitFileTransferReceipt(paused)).toBe(paused);
    expect(markFileTransferTransferring(paused)).toMatchObject({ status: "transferring", sentBytes: 40 });
    expect(cancelFileTransfer(paused)).toMatchObject({ status: "cancelled", sentBytes: 40 });
  });

  it("keeps every active transfer when a new batch is appended and only trims terminal history", () => {
    const completed = completeFileTransfer(createFileTransferQueueItem({ id: "done", fileName: "done.bin", totalBytes: 1 }));
    const queued = createFileTransferQueueItem({ id: "queued", fileName: "queued.bin", totalBytes: 2 });
    const transferring = markFileTransferTransferring(createFileTransferQueueItem({ id: "active", fileName: "active.bin", totalBytes: 3 }));
    const paused = pauseFileTransfer(updateFileTransferProgress(createFileTransferQueueItem({ id: "paused", fileName: "paused.bin", totalBytes: 5 }), 2));
    const added = createFileTransferQueueItem({ id: "new", fileName: "new.bin", totalBytes: 4 });

    expect(appendFileTransferQueueItems([completed, queued, transferring, paused], [added], 4).map((item) => item.id))
      .toEqual(["queued", "active", "paused", "new"]);
  });
});
