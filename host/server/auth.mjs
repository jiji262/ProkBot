import { randomInt, randomUUID } from "node:crypto";
import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { JsonStore, writePrivate } from "./storage.mjs";
import {
  check,
  equal,
  hash,
  passwordHash,
  secret,
  verifyPassword,
} from "./security.mjs";

const publicDevice = ({
  id,
  name,
  platform,
  createdAt,
  revokedAt,
  lastSeenAt,
}) => ({ id, name, platform, createdAt, revokedAt, lastSeenAt });
const normalizeKey = (value) =>
  typeof value === "string" ? value.replace(/[\s-]/g, "").toUpperCase() : "";
export class Auth {
  constructor(
    dataDir,
    { sessionMs = 12 * 60 * 60_000, pairingMs = 5 * 60_000 } = {},
  ) {
    this.dataDir = dataDir;
    this.sessionMs = sessionMs;
    this.pairingMs = pairingMs;
    this.store = new JsonStore(join(dataDir, "auth.json"), {
      version: 1,
      admin: null,
      sessions: [],
      devices: [],
      pairing: [],
    });
  }
  async load() {
    await this.store.load();
    if (!this.initialized) {
      const filename = join(this.dataDir, "setup-key");
      this.setupKey = await readFile(filename, "utf8")
        .then((value) => value.trim())
        .catch((error) => {
          if (error.code === "ENOENT") return null;
          throw error;
        });
      if (!this.setupKey) {
        this.setupKey = secret();
        await writePrivate(filename, `${this.setupKey}\n`);
      }
    }
    return this;
  }
  get initialized() {
    return Boolean(this.store.value.admin);
  }
  async setup(key, password) {
    check(!this.initialized, 409, "管理员已经设置");
    check(equal(key, this.setupKey), 401, "初始化 Key 无效");
    const admin = await passwordHash(password);
    const token = secret();
    await this.store.mutate((state) => {
      check(!state.admin, 409, "管理员已经设置");
      state.admin = admin;
      state.sessions = [
        { hash: hash(token), expiresAt: Date.now() + this.sessionMs },
      ];
    });
    this.setupKey = null;
    await rm(join(this.dataDir, "setup-key"), { force: true });
    return token;
  }
  async login(password) {
    check(this.initialized, 409, "请先设置管理员");
    check(
      await verifyPassword(password, this.store.value.admin),
      401,
      "管理员密码不正确",
    );
    const token = secret();
    await this.store.mutate((state) => {
      state.sessions = state.sessions
        .filter((item) => item.expiresAt > Date.now())
        .slice(-19);
      state.sessions.push({
        hash: hash(token),
        expiresAt: Date.now() + this.sessionMs,
      });
    });
    return token;
  }
  adminSession(token) {
    return (
      typeof token === "string" &&
      this.store.value.sessions.some(
        (item) => item.hash === hash(token) && item.expiresAt > Date.now(),
      )
    );
  }
  async logout(token) {
    await this.store.mutate((state) => {
      state.sessions = state.sessions.filter(
        (item) => item.hash !== hash(token),
      );
    });
  }
  async createPairing() {
    const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
    let key;
    const expiresAt = Date.now() + this.pairingMs;
    const id = randomUUID();
    await this.store.mutate((state) => {
      state.pairing = state.pairing
        .filter((item) => item.expiresAt > Date.now())
        .slice(-19);
      do { key = Array.from({ length: 6 }, () => alphabet[randomInt(alphabet.length)]).join(""); }
      while (state.pairing.some(item => item.hash === hash(key)));
      state.pairing.push({ id, hash: hash(key), expiresAt });
    });
    return {
      id,
      pairingKey: key,
      expiresAt: new Date(expiresAt).toISOString(),
    };
  }
  pairingKeys() {
    return this.store.value.pairing
      .filter((item) => item.expiresAt > Date.now())
      .map(({ id, expiresAt }) => ({ id, expiresAt }));
  }
  async pair({ pairingKey, deviceName, platform }) {
    check(
      typeof deviceName === "string" &&
        deviceName.trim().length > 0 &&
        deviceName.length <= 80,
      400,
      "设备名称需要 1–80 个字符",
    );
    check(
      ["desktop", "ios"].includes(platform),
      400,
      "设备类型应为 desktop 或 ios",
    );
    const token = secret();
    const id = randomUUID();
    await this.store.mutate((state) => {
      const index = state.pairing.findIndex(
        (item) =>
          item.hash === hash(normalizeKey(pairingKey)) &&
          item.expiresAt > Date.now(),
      );
      check(index >= 0, 401, "配对码无效、已使用或已过期");
      check(
        state.devices.filter((item) => !item.revokedAt).length < 100,
        409,
        "设备数量已达上限，请先撤销不用的设备",
      );
      state.pairing.splice(index, 1);
      state.devices.push({
        id,
        name: deviceName.trim(),
        platform,
        hash: hash(token),
        createdAt: new Date().toISOString(),
        revokedAt: null,
        lastSeenAt: new Date().toISOString(),
      });
    });
    return { deviceId: id, token };
  }
  authenticate(token) {
    if (typeof token !== "string") return null;
    const device = this.store.value.devices.find(
      (item) => !item.revokedAt && item.hash === hash(token),
    );
    return device ? publicDevice(device) : null;
  }
  device(id) {
    return this.store.value.devices.find(
      (item) => item.id === id && !item.revokedAt,
    );
  }
  devices() {
    return this.store.value.devices.map(publicDevice);
  }
  async touch(id) {
    const device = this.device(id);
    if (!device || Date.now() - Date.parse(device.lastSeenAt ?? 0) < 60_000)
      return;
    await this.store.mutate((state) => {
      const current = state.devices.find(
        (item) => item.id === id && !item.revokedAt,
      );
      if (current) current.lastSeenAt = new Date().toISOString();
    });
  }
  async revoke(id) {
    await this.store.mutate((state) => {
      const device = state.devices.find((item) => item.id === id);
      check(device, 404, "设备不存在");
      device.revokedAt ??= new Date().toISOString();
    });
  }
}
