import {
  addDoc as firebaseAddDoc,
  setDoc as firebaseSetDoc,
  updateDoc as firebaseUpdateDoc,
} from "firebase/firestore";
import { stripUndefinedFields } from "./firestorePayload";

export async function safeSetDoc(
  documentRef: unknown,
  data: unknown,
  options?: unknown,
): Promise<void> {
  const payload = stripUndefinedFields(data);
  if (options === undefined) {
    await firebaseSetDoc(documentRef as never, payload as never);
    return;
  }
  await firebaseSetDoc(documentRef as never, payload as never, options as never);
}

export async function safeUpdateDoc(documentRef: unknown, data: unknown): Promise<void> {
  await firebaseUpdateDoc(documentRef as never, stripUndefinedFields(data) as never);
}

export async function safeAddDoc(collectionRef: unknown, data: unknown): Promise<unknown> {
  return firebaseAddDoc(collectionRef as never, stripUndefinedFields(data) as never);
}

export function safeBatchUpdate(
  batch: unknown,
  documentRef: unknown,
  data: unknown,
): unknown {
  const writableBatch = batch as { update: (documentRef: never, data: never) => unknown };
  return writableBatch.update(documentRef as never, stripUndefinedFields(data) as never);
}

export function safeBatchSet(
  batch: unknown,
  documentRef: unknown,
  data: unknown,
  options?: unknown,
): unknown {
  const writableBatch = batch as {
    set: (documentRef: never, data: never, options?: never) => unknown;
  };
  const payload = stripUndefinedFields(data);
  if (options === undefined) {
    return writableBatch.set(documentRef as never, payload as never);
  }
  return writableBatch.set(documentRef as never, payload as never, options as never);
}
