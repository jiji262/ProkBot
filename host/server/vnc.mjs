import { secret } from "./security.mjs";

const allowedPorts = new Map([
  ["6080", "desktop"],
  ["16080", "desktop"],
  ["6081", "fork"],
  ["16081", "fork"],
]);
// The original iOS embedded viewer adds a slash before our absolute socket path.
// Normalize only that known upgrade path, never arbitrary protocol-relative URLs.
export function normalizeVncUpgradeUrl(rawUrl) {
  return typeof rawUrl === "string"
    ? rawUrl.replace(/^\/\/(?=vnc\/(?:desktop|fork)\/websockify(?:\?|$))/, "/")
    : rawUrl;
}
export function vncPath(rawPath, upgrade = false) {
  const match = /^\/vnc\/(desktop|fork)(\/.*)$/.exec(rawPath);
  if (!match) return null;
  const path = match[2];
  if (
    !/^\/[a-zA-Z0-9_.@/-]*$/.test(path) ||
    path.split("/").some((part) => part === "." || part === "..")
  )
    return null;
  if (
    upgrade
      ? path !== "/websockify"
      : !(
          /^\/vnc(?:_auto|_lite)?\.html$/.test(path) ||
          /^\/(defaults|mandatory)\.json$/.test(path) ||
          path === "/package.json" ||
          /^\/(app|core|vendor|include)\/.+\.(js|css|json|svg|png|gif|jpg|ico|woff2?|ttf|mp3|ogg|oga|map)$/.test(
            path,
          )
        )
  )
    return null;
  return { slot: match[1], path };
}
export class VncTickets {
  constructor(auth, { ttlMs = 10 * 60_000 } = {}) {
    this.auth = auth;
    this.ttlMs = ttlMs;
    this.tickets = new Map();
  }
  issue(deviceId, slot) {
    const now = Date.now();
    for (const [ticket, item] of this.tickets) {
      if (item.expiresAt <= now || !this.auth.device(item.deviceId))
        this.tickets.delete(ticket);
      else if (
        item.deviceId === deviceId &&
        item.slot === slot &&
        item.expiresAt - now > 30_000
      )
        return ticket;
    }
    const ticket = secret();
    this.tickets.set(ticket, { deviceId, slot, expiresAt: now + this.ttlMs });
    return ticket;
  }
  validate(ticket, slot) {
    const item = this.tickets.get(ticket);
    if (!item || item.slot !== slot || item.expiresAt <= Date.now())
      return null;
    return this.auth.device(item.deviceId) ? item : null;
  }
  revoke(deviceId) {
    for (const [ticket, item] of this.tickets)
      if (item.deviceId === deviceId) this.tickets.delete(ticket);
  }
  rewrite(value, deviceId, origin) {
    if (!value || typeof value !== "object") return value;
    if (Array.isArray(value))
      return value.map((item) => this.rewrite(item, deviceId, origin));
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => {
        if (key !== "vncUrl" || typeof item !== "string")
          return [key, this.rewrite(item, deviceId, origin)];
        try {
          const original = new URL(item);
          const slot = allowedPorts.get(original.port);
          if (!slot) return [key, null];
          const path =
            original.pathname === "/" ? "/vnc.html" : original.pathname;
          if (!vncPath(`/vnc/${slot}${path}`)) return [key, null];
          const socket = new URL(
            original.searchParams.get("path") ?? "websockify",
            "http://vnc.invalid/",
          );
          if (
            socket.origin !== "http://vnc.invalid" ||
            socket.pathname !== "/websockify"
          )
            return [key, null];
          const ticket = this.issue(deviceId, slot);
          socket.searchParams.delete("gateway_token");
          socket.searchParams.set("ticket", ticket);
          const result = new URL(`/vnc/${slot}${path}`, origin);
          result.search = original.search;
          for (const name of ["host", "port", "gateway_token"])
            result.searchParams.delete(name);
          result.searchParams.set(
            "encrypt",
            result.protocol === "https:" ? "1" : "0",
          );
          result.searchParams.set(
            "path",
            `/vnc/${slot}/websockify${socket.search}`,
          );
          result.searchParams.set("autoconnect", "true");
          result.searchParams.set("resize", "scale");
          result.searchParams.set("ticket", ticket);
          return [key, result.href];
        } catch {
          return [key, null];
        }
      }),
    );
  }
}
