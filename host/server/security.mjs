import {
  createHash,
  randomBytes,
  scrypt as scryptCallback,
  timingSafeEqual,
} from "node:crypto";
import { promisify } from "node:util";
const scrypt = promisify(scryptCallback);
export const hash = (value) => createHash("sha256").update(value).digest("hex");
export const secret = () => randomBytes(32).toString("base64url");
export const equal = (a, b) =>
  typeof a === "string" &&
  typeof b === "string" &&
  timingSafeEqual(Buffer.from(hash(a), "hex"), Buffer.from(hash(b), "hex"));
export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}
export function check(condition, status, message) {
  if (!condition) throw new HttpError(status, message);
}
export async function passwordHash(
  password,
  salt = randomBytes(16).toString("hex"),
) {
  check(
    typeof password === "string" &&
      password.length >= 12 &&
      password.length <= 128,
    400,
    "管理员密码需要 12–128 个字符",
  );
  const key = await scrypt(password, salt, 64, {
    N: 32768,
    r: 8,
    p: 1,
    maxmem: 64 * 1024 * 1024,
  });
  return { salt, hash: key.toString("hex") };
}
export async function verifyPassword(password, saved) {
  if (
    typeof password !== "string" ||
    password.length < 12 ||
    password.length > 128
  )
    return false;
  const computed = await passwordHash(password, saved.salt);
  return equal(computed.hash, saved.hash);
}
export function bearer(request) {
  const value = request.headers.authorization;
  return typeof value === "string" &&
    /^Bearer [A-Za-z0-9_-]{32,256}$/.test(value)
    ? value.slice(7)
    : null;
}
export function cookie(request, name) {
  return String(request.headers.cookie ?? "")
    .split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${name}=`))
    ?.slice(name.length + 1);
}
export async function jsonBody(request, limit = 128 * 1024, { allowEmpty = false } = {}) {
  check(
    String(request.headers["content-type"] ?? "")
      .split(";")[0]
      .trim() === "application/json",
    415,
    "请发送 JSON 格式",
  );
  let size = 0;
  const chunks = [];
  for await (const chunk of request) {
    size += chunk.length;
    check(size <= limit, 413, "请求内容过大");
    chunks.push(chunk);
  }
  if (size === 0 && allowEmpty) return {};
  try {
    const value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    check(
      value && typeof value === "object" && !Array.isArray(value),
      400,
      "请求需要 JSON 对象",
    );
    return value;
  } catch (error) {
    if (error.status) throw error;
    throw new HttpError(400, "JSON 格式错误");
  }
}
export function sendJson(response, status, value) {
  if (response.destroyed) return;
  if (response.headersSent) return response.destroy();
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  response.end(JSON.stringify(value));
}
export function securityHeaders(response) {
  response.setHeader("x-content-type-options", "nosniff");
  response.setHeader("referrer-policy", "no-referrer");
  response.setHeader("x-frame-options", "SAMEORIGIN");
  response.setHeader("cache-control", "no-store");
}
export function originFor(request, configured) {
  if (configured) return configured;
  const origin = new URL(`http://${request.headers.host ?? "localhost"}`);
  check(
    !origin.username && !origin.password && origin.pathname === "/",
    400,
    "无效的服务地址",
  );
  return origin.origin;
}
export function adminMutation(request, origin) {
  check(
    request.headers["x-grokbot-csrf"] === "1",
    403,
    "请从管理页面执行此操作",
  );
  check(
    !request.headers.origin || request.headers.origin === origin,
    403,
    "请求来源不匹配",
  );
}
export class RateLimit {
  constructor() {
    this.entries = new Map();
  }
  check(key, limit = 10, windowMs = 60_000) {
    const now = Date.now();
    if (this.entries.size > 2048)
      for (const [id, item] of this.entries)
        if (item.end <= now) this.entries.delete(id);
    check(
      this.entries.size < 4096 || this.entries.has(key),
      429,
      "请求过多，请稍后重试",
    );
    let item = this.entries.get(key);
    if (!item || item.end <= now) {
      item = { end: now + windowMs, count: 0 };
      this.entries.set(key, item);
    }
    check(++item.count <= limit, 429, "尝试次数过多，请稍后重试");
  }
}
