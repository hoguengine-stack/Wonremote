import { collection, doc, limit, onSnapshot, query, where, writeBatch, type Firestore, type Unsubscribe } from "firebase/firestore";
import { emptySessionData, type SessionData, type SessionDataOptions } from "../domain/sessionData";
import type { FileTransferReceipt } from "../domain/types";

function timestamp(value: any): string {
  return typeof value === "string" ? value : value?.toDate?.().toISOString() ?? new Date().toISOString();
}

export function mapFileReceipt(id: string, data: Record<string, any>): FileTransferReceipt {
  return {
    transferId: String(data.transferId ?? id), filename: String(data.filename ?? ""),
    status: data.status === "received" ? "received" : data.status === "failed" ? "failed" : "partial",
    receivedChunks: Number(data.receivedChunks ?? 0), totalChunks: Number(data.totalChunks ?? 0),
    receivedBytes: typeof data.receivedBytes === "number" ? data.receivedBytes : undefined,
    savedPath: typeof data.savedPath === "string" ? data.savedPath : undefined,
    error: typeof data.error === "string" ? data.error : undefined, updatedAt: timestamp(data.updatedAt),
  };
}

export function subscribeFirebaseSessionData(
  db: Firestore, sessionId: string, target: "viewer" | "agent",
  onData: (data: SessionData) => void | Promise<void>, onError: (error: Error) => void,
  options: SessionDataOptions = {},
): Unsubscribe {
  let active = true;
  let tail = Promise.resolve();
  const subscriptions: Unsubscribe[] = [];
  const stop = () => { active = false; subscriptions.splice(0).forEach((unsubscribe) => unsubscribe()); };
  const fail = (error: unknown) => {
    if (!active) return;
    stop();
    onError(error instanceof Error ? error : new Error(String(error)));
  };
  const addSubscription = (unsubscribe: Unsubscribe) => active ? subscriptions.push(unsubscribe) : unsubscribe();
  const queues = options.queues === false ? [] : ["chat", ...(options.clipboard === false ? [] : ["clipboard"]), "files"];
  try {
    for (const queueName of queues) {
      const pending = new Set<string>();
      const queue = query(collection(db, "sessions", sessionId, queueName), where("target", "==", target), limit(queueName === "files" ? 200 : 100));
      addSubscription(onSnapshot(queue, (snapshot) => {
        if (!active) return;
        for (const change of snapshot.docChanges()) if (change.type === "removed") pending.delete(change.doc.id);
        const docs = snapshot.docChanges().filter((change) => change.type !== "removed" && !pending.has(change.doc.id)).map((change) => change.doc);
        if (!docs.length) return;
        docs.forEach((item) => pending.add(item.id));
        tail = tail.then(async () => {
          if (!active) return;
          const next = emptySessionData();
          for (const item of docs) {
            const data = item.data();
            const sender = data.sender === "agent" ? "agent" : "viewer";
            if (queueName === "chat") next.messages.push({ id: item.id, sender, message: String(data.message ?? ""), createdAt: timestamp(data.createdAt) });
            if (queueName === "clipboard") next.clipboards.push({ sender, text: String(data.text ?? "") });
            if (queueName === "files") next.files.push({
              ...data, id: item.id, filename: String(data.filename ?? ""), fileData: String(data.fileData ?? ""),
              delivery: data.delivery === "firebase-storage" ? "firebase-storage" : "firestore-direct",
            });
          }
          await onData(next);
          if (!active) return;
          const batch = writeBatch(db);
          docs.forEach((item) => batch.delete(item.ref));
          await batch.commit();
          // IDs stay claimed until removal is observed, including overlapping local snapshots.
        }).catch(fail);
      }, fail));
    }
    for (const transferId of new Set(options.receiptIds ?? [])) {
      let unsubscribe: Unsubscribe | undefined;
      let finished = false;
      unsubscribe = onSnapshot(doc(db, "sessions", sessionId, "fileReceipts", transferId), (snapshot) => {
        if (!active || finished || !snapshot.exists()) return;
        const receipt = mapFileReceipt(snapshot.id, snapshot.data());
        finished = receipt.status !== "partial";
        if (finished) unsubscribe?.();
        tail = tail.then(async () => {
          if (active) await onData({ ...emptySessionData(), receipts: [receipt] });
        }).catch(fail);
      }, fail);
      if (finished) unsubscribe();
      addSubscription(unsubscribe);
    }
  } catch (error) { fail(error); }
  return stop;
}
