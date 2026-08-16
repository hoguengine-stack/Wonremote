import { getAuth, type Auth, type UserRecord } from "firebase-admin/auth";
import { HttpsError, onCall } from "firebase-functions/v2/https";

export const BOOTSTRAP_VIEWER_UID = "Xjjdvk0Nx1eqCvND4yIOHbM53tl1";

type ViewerAuth = Pick<Auth, "createUser" | "deleteUser" | "getUser" | "listUsers" | "revokeRefreshTokens" | "setCustomUserClaims" | "updateUser">;

export type ViewerAdminActor = {
  token?: Record<string, unknown>;
  uid?: string;
};

export type ViewerAccountSummary = {
  createdAt: string;
  disabled: boolean;
  displayName: string;
  email: string;
  isAdmin: boolean;
  lastSignInAt: string | null;
  uid: string;
};

export async function listViewerAccountsOperation(
  auth: ViewerAuth,
  actor: ViewerAdminActor | undefined,
  data: unknown,
): Promise<ViewerAccountSummary[]> {
  requireViewerAdmin(actor);
  asRecord(data);
  const result = await auth.listUsers(1_000);
  return result.users
    .filter(isManagedViewerAccount)
    .map(toAccountSummary)
    .sort((left, right) => left.email.localeCompare(right.email));
}

export async function createViewerAccountOperation(
  auth: ViewerAuth,
  actor: ViewerAdminActor | undefined,
  data: unknown,
): Promise<ViewerAccountSummary> {
  requireViewerAdmin(actor);
  const input = asRecord(data);
  const email = requireEmail(input.email);
  const password = requirePassword(input.password);
  const displayName = optionalDisplayName(input.displayName);

  const created = await auth.createUser({
    email,
    password,
    ...(displayName ? { displayName } : {}),
    disabled: false,
  });
  try {
    await auth.setCustomUserClaims(created.uid, { wonremoteViewer: true });
  } catch (error) {
    await auth.deleteUser(created.uid).catch(() => undefined);
    throw error;
  }

  return toAccountSummary(created);
}

export async function updateViewerAccountOperation(
  auth: ViewerAuth,
  actor: ViewerAdminActor | undefined,
  data: unknown,
): Promise<ViewerAccountSummary> {
  const actorUid = requireViewerAdmin(actor);
  const input = asRecord(data);
  const uid = requireString(input.uid, "uid");
  if (uid === BOOTSTRAP_VIEWER_UID) {
    throw new HttpsError("failed-precondition", "The bootstrap account cannot be modified.");
  }
  const target = await requireManagedViewer(auth, uid);
  const update: { disabled?: boolean; displayName?: string; email?: string; password?: string } = {};

  if (input.email !== undefined) update.email = requireEmail(input.email);
  if (input.password !== undefined) update.password = requirePassword(input.password);
  if (input.displayName !== undefined) update.displayName = requireDisplayName(input.displayName);
  if (input.disabled !== undefined) {
    if (typeof input.disabled !== "boolean") {
      throw new HttpsError("invalid-argument", "disabled must be a boolean.");
    }
    if (input.disabled && uid === actorUid) {
      throw new HttpsError("failed-precondition", "The current account cannot be disabled.");
    }
    update.disabled = input.disabled;
  }
  if (Object.keys(update).length === 0) {
    throw new HttpsError("invalid-argument", "At least one account field must be updated.");
  }

  const updated = await auth.updateUser(uid, update);
  if (update.disabled === true) {
    await auth.revokeRefreshTokens(uid);
  }
  if (uid !== BOOTSTRAP_VIEWER_UID && target.customClaims?.wonremoteViewer !== true) {
    await auth.setCustomUserClaims(uid, { ...target.customClaims, wonremoteViewer: true });
  }
  return toAccountSummary(updated);
}

export async function deleteViewerAccountOperation(
  auth: ViewerAuth,
  actor: ViewerAdminActor | undefined,
  data: unknown,
): Promise<{ deleted: true }> {
  const actorUid = requireViewerAdmin(actor);
  const uid = requireString(asRecord(data).uid, "uid");
  if (uid === BOOTSTRAP_VIEWER_UID || uid === actorUid) {
    throw new HttpsError("failed-precondition", "The bootstrap account and current account cannot be deleted.");
  }
  await requireManagedViewer(auth, uid);
  await auth.revokeRefreshTokens(uid);
  await auth.deleteUser(uid);
  return { deleted: true };
}

export const listViewerAccounts = onCall((request) =>
  listViewerAccountsOperation(getAuth(), request.auth, request.data));

export const createViewerAccount = onCall((request) =>
  createViewerAccountOperation(getAuth(), request.auth, request.data));

export const updateViewerAccount = onCall((request) =>
  updateViewerAccountOperation(getAuth(), request.auth, request.data));

export const deleteViewerAccount = onCall((request) =>
  deleteViewerAccountOperation(getAuth(), request.auth, request.data));

function requireViewerAdmin(actor: ViewerAdminActor | undefined): string {
  if (!actor?.uid) {
    throw new HttpsError("unauthenticated", "Authentication is required.");
  }
  if (actor.uid !== BOOTSTRAP_VIEWER_UID && actor.token?.wonremoteAdmin !== true) {
    throw new HttpsError("permission-denied", "Viewer account administrator permission is required.");
  }
  return actor.uid;
}

async function requireManagedViewer(auth: ViewerAuth, uid: string): Promise<UserRecord> {
  const user = await auth.getUser(uid);
  if (!isManagedViewerAccount(user)) {
    throw new HttpsError("failed-precondition", "The target account is not a WonRemote Viewer account.");
  }
  return user;
}

function isManagedViewerAccount(user: UserRecord): boolean {
  return user.uid === BOOTSTRAP_VIEWER_UID || user.customClaims?.wonremoteViewer === true;
}

function toAccountSummary(user: UserRecord): ViewerAccountSummary {
  return {
    uid: user.uid,
    email: user.email ?? "",
    displayName: user.displayName ?? "",
    disabled: user.disabled,
    isAdmin: user.uid === BOOTSTRAP_VIEWER_UID || user.customClaims?.wonremoteAdmin === true,
    createdAt: user.metadata?.creationTime ?? "",
    lastSignInAt: user.metadata?.lastSignInTime ?? null,
  };
}

function asRecord(value: unknown): Record<string, unknown> {
  if (value === undefined || value === null) return {};
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new HttpsError("invalid-argument", "Request data must be an object.");
  }
  return value as Record<string, unknown>;
}

function requireString(value: unknown, fieldName: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new HttpsError("invalid-argument", `${fieldName} is required.`);
  }
  return value.trim();
}

function requireEmail(value: unknown): string {
  const email = requireString(value, "email").toLowerCase();
  if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new HttpsError("invalid-argument", "email must be a valid email address.");
  }
  return email;
}

function requirePassword(value: unknown): string {
  if (typeof value !== "string" || value.length < 8) {
    throw new HttpsError("invalid-argument", "password must be at least 8 characters.");
  }
  return value;
}

function requireDisplayName(value: unknown): string {
  const displayName = requireString(value, "displayName");
  if (displayName.length > 100) {
    throw new HttpsError("invalid-argument", "displayName must be 100 characters or fewer.");
  }
  return displayName;
}

function optionalDisplayName(value: unknown): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  return requireDisplayName(value);
}
