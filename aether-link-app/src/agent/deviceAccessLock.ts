import { constants, createDecipheriv, createPublicKey, generateKeyPairSync, pbkdf2, privateDecrypt, randomBytes, randomUUID, sign, timingSafeEqual, verify } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { accessRequestAad, type DeviceAccessRequest, type DeviceAccessCredentials, type DeviceAccessState } from "../domain/deviceAccessLock";
import { protectDeviceAccessData } from "./deviceAccessStorage";

const derive = promisify(pbkdf2);
const RECOVERY_VERIFIER = {salt:"33dd5e7ae1841090d057481bc32a8945", hash:"99a046d1ca4f687163f74b51700a8b8b42669d422283d914f1e53384b4ecccd2"};
interface PasswordVerifier { salt: string; hash: string }
interface SavedLock {
  schemaVersion: 1;
  deviceId: string;
  privateKey: string;
  publicKey: string;
  version: string;
  password: PasswordVerifier | null;
  attempts: number;
  blockedUntil: number;
}

function validatePassword(password: unknown): asserts password is string {
  if (typeof password !== "string" || password.length < 4 || password.length > 64) throw new Error("비밀번호는 4~64자로 입력하세요.");
}
async function verifier(password: string): Promise<PasswordVerifier> {
  validatePassword(password);
  const salt = randomBytes(16).toString("hex");
  return {salt, hash:(await derive(password, salt, 600_000, 32, "sha256")).toString("hex")};
}
async function matches(password: string, stored: PasswordVerifier): Promise<boolean> {
  if (typeof password !== "string" || password.length > 64) return false;
  const actual = await derive(password, stored.salt, 600_000, 32, "sha256");
  const expected = Buffer.from(stored.hash, "hex");
  return expected.length === actual.length && timingSafeEqual(actual, expected);
}

export class AgentDeviceAccessLock {
  private constructor(private readonly file: string, private state: SavedLock) {}

  static async load(file: string, deviceId: string): Promise<AgentDeviceAccessLock> {
    let state: SavedLock;
    let created = false;
    try {
      state = JSON.parse(await protectDeviceAccessData(await readFile(file, "utf8"), true));
      if (state.schemaVersion !== 1 || state.deviceId !== deviceId || typeof state.privateKey !== "string" || typeof state.publicKey !== "string"
        || typeof state.version !== "string" || !Number.isFinite(state.attempts) || !Number.isFinite(state.blockedUntil)
        || (state.password !== null && (!/^[a-f0-9]{32}$/.test(state.password?.salt) || !/^[a-f0-9]{64}$/.test(state.password?.hash)))) {
        throw new Error("장비 접속 잠금 설정이 손상되었습니다. 설정을 삭제하지 말고 복구하세요.");
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      const keys = generateKeyPairSync("rsa", {modulusLength:2048});
      state = {schemaVersion:1, deviceId, privateKey:keys.privateKey.export({format:"pem", type:"pkcs8"}).toString(),
        publicKey:keys.publicKey.export({format:"der", type:"spki"}).toString("base64"),
        version:randomUUID(), password:null, attempts:0, blockedUntil:0};
      created = true;
    }
    const lock = new AgentDeviceAccessLock(file, state);
    if (created) await lock.save(state);
    return lock;
  }

  get publicState(): DeviceAccessState {
    return {enabled:this.state.password !== null, version:this.state.version, publicKey:this.state.publicKey};
  }

  signApproval(request: DeviceAccessRequest, version: string): string {
    return sign("sha256", Buffer.from(JSON.stringify([accessRequestAad(request), version])),
      {key:this.state.privateKey, padding:constants.RSA_PKCS1_PSS_PADDING, saltLength:32}).toString("base64");
  }

  verifyApproval(request: DeviceAccessRequest, version: string, signature: unknown): boolean {
    if (typeof signature !== "string" || signature.length > 400) return false;
    try { return verify("sha256", Buffer.from(JSON.stringify([accessRequestAad(request), version])),
      {key:createPublicKey(this.state.privateKey), padding:constants.RSA_PKCS1_PSS_PADDING, saltLength:32}, Buffer.from(signature,"base64")); }
    catch { return false; }
  }

  private async save(state: SavedLock): Promise<void> {
    await mkdir(path.dirname(this.file), {recursive:true});
    const temporary = `${this.file}.${randomUUID()}.tmp`;
    const sealed = await protectDeviceAccessData(JSON.stringify(state));
    try {
      await writeFile(temporary, sealed, {mode:0o600, flag:"wx"});
      await rename(temporary, this.file);
    } catch (error) {
      await rm(temporary, {force:true}).catch(() => undefined);
      throw error;
    }
    this.state = state;
  }

  async authorize(request: DeviceAccessRequest, now = Date.now(), publish?: (state: DeviceAccessState) => Promise<void>): Promise<DeviceAccessState> {
    if (request.deviceId !== this.state.deviceId || !request.ownerUid || !request.id || !["connect", "set", "disable", "reset"].includes(request.operation)) throw new Error("잘못된 접속 잠금 요청입니다.");
    if (this.state.blockedUntil > now) throw new Error("비밀번호 오류가 반복되었습니다. 잠시 후 다시 시도하세요.");
    if (request.key.length > 400 || request.iv.length > 32 || request.ciphertext.length > 2048) throw new Error("접속 잠금 요청이 너무 큽니다.");
    let credentials: DeviceAccessCredentials;
    try {
      const key = privateDecrypt({key:this.state.privateKey, padding:constants.RSA_PKCS1_OAEP_PADDING, oaepHash:"sha256"}, Buffer.from(request.key, "base64"));
      const payload = Buffer.from(request.ciphertext, "base64");
      const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(request.iv, "base64"));
      decipher.setAAD(Buffer.from(accessRequestAad(request)));
      decipher.setAuthTag(payload.subarray(-16));
      credentials = JSON.parse(Buffer.concat([decipher.update(payload.subarray(0, -16)), decipher.final()]).toString("utf8"));
    } catch { throw new Error("접속 잠금 요청을 검증하지 못했습니다."); }
    const password = credentials.password;
    const accepted = typeof password === "string" && password.length <= 64 && (request.operation === "reset"
      ? await matches(password, RECOVERY_VERIFIER)
      : this.state.password ? await matches(password, this.state.password) : request.operation === "set");
    if (!accepted) {
      const attempts = this.state.attempts + 1;
      await this.save({...this.state, attempts:attempts >= 5 ? 0 : attempts, blockedUntil:attempts >= 5 ? now + 60_000 : 0});
      throw new Error("비밀번호가 일치하지 않습니다.");
    }
    let next = {...this.state, attempts:0, blockedUntil:0};
    if (request.operation === "set" || request.operation === "reset") {
      next = {...next, password:await verifier(credentials.newPassword!), version:randomUUID()};
    } else if (request.operation === "disable") {
      next = {...next, password:null, version:randomUUID()};
    }
    const previous = this.state;
    await this.save(next);
    try { await publish?.(this.publicState); }
    catch (error) { await this.save(previous); throw error; }
    return this.publicState;
  }
}
