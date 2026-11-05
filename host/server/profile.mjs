import { join } from "node:path";
import { JsonStore } from "./storage.mjs";
import { check } from "./security.mjs";
import { validateAvatar } from "./avatar.mjs";

export class Profile {
  constructor(dataDir) {
    this.store = new JsonStore(join(dataDir, "user-profile.json"), {
      version: 1,
      displayName: "本地工作区",
      hostName: "Grok Bot Host",
      avatarDataUrl: null,
      updatedAt: null,
    });
  }
  async load() {
    await this.store.load();
    return this;
  }
  current() {
    return this.currentFrom(this.store.value);
  }
  async save(input, { allowHostName = false } = {}) {
    check(
      typeof input.displayName === "string" &&
        !/[\p{Cc}\u2028\u2029]/u.test(input.displayName),
      400,
      "用户名不能包含控制字符或换行",
    );
    const displayName = input.displayName.trim();
    check(
      [...displayName].length >= 1 && [...displayName].length <= 80,
      400,
      "用户名需要 1–80 个字符",
    );
    const avatarDataUrl = validateAvatar(input.avatarDataUrl);
    let hostName;
    if (Object.hasOwn(input, "hostName")) {
      check(allowHostName, 403, "Host 昵称只能在管理页面修改");
      check(typeof input.hostName === "string" && !/[\p{Cc}\u2028\u2029]/u.test(input.hostName), 400, "Host 昵称无效");
      hostName = input.hostName.trim();
      check([...hostName].length >= 1 && [...hostName].length <= 80, 400, "Host 昵称需要 1–80 个字符");
    }
    return this.store.mutate((value) => {
      Object.assign(value, {
        displayName,
        avatarDataUrl,
        updatedAt: new Date().toISOString(),
        ...(hostName === undefined ? {} : { hostName }),
      });
      return this.currentFrom(value);
    });
  }
  currentFrom({ displayName, avatarDataUrl, updatedAt, hostName = "Grok Bot Host" }) {
    return { displayName, avatarDataUrl, hostName, updatedAt };
  }
}
