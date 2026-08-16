import assert from "node:assert/strict";
import test from "node:test";
import type { Auth, UserRecord } from "firebase-admin/auth";
import {
  BOOTSTRAP_VIEWER_UID,
  createViewerAccountOperation,
  deleteViewerAccountOperation,
  listViewerAccountsOperation,
  updateViewerAccountOperation,
} from "./viewerAccounts.js";

const admin = { uid: BOOTSTRAP_VIEWER_UID, token: {} };

function user(input: Partial<UserRecord> & { uid: string }): UserRecord {
  return {
    customClaims: {},
    disabled: false,
    displayName: undefined,
    email: undefined,
    ...input,
  } as UserRecord;
}

function fakeAuth(users: UserRecord[] = []) {
  const state = new Map(users.map((item) => [item.uid, item]));
  const calls = {
    created: [] as unknown[],
    deleted: [] as string[],
    claims: [] as Array<[string, Record<string, unknown> | null]>,
    updated: [] as Array<[string, unknown]>,
    revoked: [] as string[],
  };
  const auth = {
    async listUsers() {
      return { users: [...state.values()] };
    },
    async createUser(input: { email?: string; displayName?: string; disabled?: boolean }) {
      calls.created.push(input);
      const created = user({ uid: "created-viewer", ...input });
      state.set(created.uid, created);
      return created;
    },
    async setCustomUserClaims(uid: string, claims: Record<string, unknown> | null) {
      calls.claims.push([uid, claims]);
      const current = state.get(uid)!;
      state.set(uid, user({ ...current, customClaims: claims ?? {} }));
    },
    async getUser(uid: string) {
      const found = state.get(uid);
      if (!found) throw new Error("missing user");
      return found;
    },
    async updateUser(uid: string, input: Partial<UserRecord>) {
      calls.updated.push([uid, input]);
      const updated = user({ ...state.get(uid)!, ...input, uid });
      state.set(uid, updated);
      return updated;
    },
    async deleteUser(uid: string) {
      calls.deleted.push(uid);
      state.delete(uid);
    },
    async revokeRefreshTokens(uid: string) {
      calls.revoked.push(uid);
    },
  } as unknown as Auth;
  return { auth, calls };
}

test("only bootstrap UID or wonremoteAdmin claim can manage Viewer accounts", async () => {
  const { auth } = fakeAuth();
  await assert.rejects(() => listViewerAccountsOperation(auth, {}, {}), { code: "unauthenticated" });
  await assert.rejects(
    () => listViewerAccountsOperation(auth, { uid: "ordinary", token: {} }, {}),
    { code: "permission-denied" },
  );
  await assert.doesNotReject(() =>
    listViewerAccountsOperation(auth, { uid: "admin", token: { wonremoteAdmin: true } }, {}));
});

test("list returns only Viewer accounts and never exposes password data", async () => {
  const { auth } = fakeAuth([
    user({ uid: BOOTSTRAP_VIEWER_UID, email: "bootstrap@example.com" }),
    user({ uid: "viewer", email: "viewer@example.com", customClaims: { wonremoteViewer: true } }),
    user({ uid: "agent", email: "123@agents.wonremote.app" }),
  ]);
  const result = await listViewerAccountsOperation(auth, admin, {});
  assert.deepEqual(result.map((item) => item.uid), [BOOTSTRAP_VIEWER_UID, "viewer"]);
  assert.equal(JSON.stringify(result).includes("password"), false);
});

test("create validates fields and grants wonremoteViewer claim", async () => {
  const { auth, calls } = fakeAuth();
  await assert.rejects(
    () => createViewerAccountOperation(auth, admin, { email: "bad", password: "short", displayName: "" }),
    { code: "invalid-argument" },
  );
  const result = await createViewerAccountOperation(auth, admin, {
    email: " Viewer@Example.com ",
    password: "password8",
    displayName: " 운영자 ",
  });
  assert.equal(result.email, "viewer@example.com");
  assert.deepEqual(calls.claims, [["created-viewer", { wonremoteViewer: true }]]);
  assert.equal(JSON.stringify(result).includes("password8"), false);
});

test("update resets password but blocks disabling bootstrap or current account", async () => {
  const viewer = user({ uid: "viewer", email: "old@example.com", customClaims: { wonremoteViewer: true } });
  const { auth, calls } = fakeAuth([viewer, user({ uid: BOOTSTRAP_VIEWER_UID })]);
  await updateViewerAccountOperation(auth, admin, {
    uid: "viewer",
    email: "new@example.com",
    password: "newpass88",
    displayName: "New Viewer",
  });
  assert.deepEqual(calls.updated[0], ["viewer", {
    email: "new@example.com",
    password: "newpass88",
    displayName: "New Viewer",
  }]);
  await assert.rejects(
    () => updateViewerAccountOperation(auth, admin, { uid: BOOTSTRAP_VIEWER_UID, displayName: "Changed" }),
    { code: "failed-precondition" },
  );
  await assert.rejects(
    () => updateViewerAccountOperation(auth, { uid: "viewer", token: { wonremoteAdmin: true } }, { uid: "viewer", disabled: true }),
    { code: "failed-precondition" },
  );
  await updateViewerAccountOperation(auth, admin, { uid: "viewer", disabled: true });
  assert.deepEqual(calls.revoked, ["viewer"]);
});

test("delete blocks bootstrap and self while allowing another Viewer account", async () => {
  const viewer = user({ uid: "viewer", customClaims: { wonremoteViewer: true } });
  const other = user({ uid: "other", customClaims: { wonremoteViewer: true } });
  const { auth, calls } = fakeAuth([viewer, other]);
  await assert.rejects(() => deleteViewerAccountOperation(auth, admin, { uid: BOOTSTRAP_VIEWER_UID }), {
    code: "failed-precondition",
  });
  await assert.rejects(
    () => deleteViewerAccountOperation(auth, { uid: "viewer", token: { wonremoteAdmin: true } }, { uid: "viewer" }),
    { code: "failed-precondition" },
  );
  await deleteViewerAccountOperation(auth, admin, { uid: "other" });
  assert.deepEqual(calls.deleted, ["other"]);
  assert.deepEqual(calls.revoked, ["other"]);
});

test("update and delete reject non-Viewer accounts", async () => {
  const { auth } = fakeAuth([user({ uid: "agent" })]);
  await assert.rejects(() => updateViewerAccountOperation(auth, admin, { uid: "agent", displayName: "No" }), {
    code: "failed-precondition",
  });
  await assert.rejects(() => deleteViewerAccountOperation(auth, admin, { uid: "agent" }), {
    code: "failed-precondition",
  });
});
