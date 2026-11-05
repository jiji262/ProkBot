import http from "node:http";
import https from "node:https";
import { Transform, pipeline } from "node:stream";
import { StringDecoder } from "node:string_decoder";
import { sendJson } from "./security.mjs";

export class DeviceConnections {
  constructor() {
    this.devices = new Map();
  }
  track(deviceId, stream) {
    let streams = this.devices.get(deviceId);
    if (!streams) this.devices.set(deviceId, (streams = new Set()));
    streams.add(stream);
    stream.once("close", () => {
      streams.delete(stream);
      if (!streams.size) this.devices.delete(deviceId);
    });
  }
  revoke(deviceId) {
    for (const stream of this.devices.get(deviceId) ?? []) stream.destroy();
  }
  close() {
    for (const id of this.devices.keys()) this.revoke(id);
  }
}
function upstreamHeaders(headers, target, token, upgrade = false) {
  const excluded = new Set([
    "host",
    "authorization",
    "proxy-authorization",
    "origin",
    "cookie",
    "referer",
    "x-anyrun-network-token",
    "x-forwarded-for",
    "x-forwarded-host",
    "x-forwarded-proto",
    "forwarded",
    "connection",
    "keep-alive",
    "te",
    "trailer",
    "transfer-encoding",
    "upgrade",
    "accept-encoding",
  ]);
  for (const name of String(headers.connection ?? "").split(","))
    excluded.add(name.trim().toLowerCase());
  const result = Object.fromEntries(
    Object.entries(headers).filter(([key]) => !excluded.has(key)),
  );
  result.host = target.host;
  result["accept-encoding"] = "identity";
  if (token) result.authorization = `Bearer ${token}`;
  if (upgrade) {
    result.connection = "Upgrade";
    result.upgrade = "websocket";
  }
  return result;
}
function responseHeaders(headers, transformed) {
  const result = {
    ...headers,
    "referrer-policy": "no-referrer",
    "x-content-type-options": "nosniff",
    "cache-control": "no-store",
  };
  for (const name of [
    "connection",
    "keep-alive",
    "transfer-encoding",
    "set-cookie",
  ])
    delete result[name];
  if (transformed)
    for (const name of ["content-length", "content-encoding", "etag"])
      delete result[name];
  return result;
}
export function sseRewriter(rewrite) {
  const decoder = new StringDecoder("utf8");
  let buffered = "";
  function block(text) {
    const lines = text.split(/\r?\n/);
    const data = lines
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trimStart());
    if (!data.length) return text;
    let value;
    try {
      value = JSON.parse(data.join("\n"));
    } catch {
      return text;
    }
    let written = false;
    return lines
      .flatMap((line) => {
        if (!line.startsWith("data:")) return [line];
        if (written) return [];
        written = true;
        return [`data: ${JSON.stringify(rewrite(value))}`];
      })
      .join("\n");
  }
  return new Transform({
    transform(chunk, _encoding, done) {
      try {
        buffered += decoder.write(chunk);
        if (buffered.length > 64 * 1024 * 1024)
          throw new Error("SSE frame exceeds limit");
        let boundary;
        while ((boundary = /\r?\n\r?\n/.exec(buffered))) {
          this.push(`${block(buffered.slice(0, boundary.index))}\n\n`);
          buffered = buffered.slice(boundary.index + boundary[0].length);
        }
        done();
      } catch (error) {
        done(error);
      }
    },
    flush(done) {
      buffered += decoder.end();
      if (buffered) this.push(block(buffered));
      done();
    },
  });
}
export function proxyHttp(
  request,
  response,
  { target, path, token, rewrite, ticketCookie },
) {
  const transport = target.protocol === "https:" ? https : http;
  const upstream = transport.request(target, {
    path,
    method: request.method,
    headers: upstreamHeaders(request.headers, target, token),
  });
  response.on("close", () => upstream.destroy());
  request.on("error", () => upstream.destroy());
  upstream.on("error", () =>
    sendJson(response, 502, { error: "Host 暂不可用，请稍后重试" }),
  );
  const timer = setTimeout(
    () => upstream.destroy(new Error("Upstream headers timeout")),
    30_000,
  );
  upstream.once("close", () => clearTimeout(timer));
  upstream.on("response", (incoming) => {
    clearTimeout(timer);
    const type = String(incoming.headers["content-type"] ?? "");
    const json = rewrite && type.includes("application/json");
    const sse = rewrite && type.includes("text/event-stream");
    const headers = responseHeaders(incoming.headers, json || sse);
    if (ticketCookie) headers["set-cookie"] = ticketCookie;
    if (type.includes("text/event-stream")) headers["x-accel-buffering"] = "no";
    if (json) {
      const chunks = [];
      let size = 0;
      incoming.on("data", (chunk) => {
        size += chunk.length;
        if (size > 64 * 1024 * 1024) {
          incoming.destroy();
          sendJson(response, 502, { error: "Host 响应内容过大" });
        } else chunks.push(chunk);
      });
      incoming.on("end", () => {
        try {
          const body = JSON.stringify(
            rewrite(JSON.parse(Buffer.concat(chunks).toString("utf8"))),
          );
          response.writeHead(incoming.statusCode, {
            ...headers,
            "content-length": Buffer.byteLength(body),
          });
          response.end(body);
        } catch {
          sendJson(response, 502, { error: "Host 响应格式错误" });
        }
      });
      incoming.on("error", () =>
        sendJson(response, 502, { error: "Host 响应中断" }),
      );
    } else {
      response.writeHead(incoming.statusCode, headers);
      response.flushHeaders();
      pipeline(
        ...(sse
          ? [incoming, sseRewriter(rewrite), response]
          : [incoming, response]),
        () => upstream.destroy(),
      );
    }
  });
  request.pipe(upstream);
}
export function proxyWebSocket(request, socket, head, { target, path, token }) {
  const transport = target.protocol === "https:" ? https : http;
  const upstream = transport.request(target, {
    path,
    headers: upstreamHeaders(request.headers, target, token, true),
  });
  const timer = setTimeout(() => upstream.destroy(), 15_000);
  socket.on("close", () => upstream.destroy());
  socket.on("error", () => upstream.destroy());
  upstream.on("error", () => socket.destroy());
  upstream.on("close", () => clearTimeout(timer));
  upstream.on("response", (response) => {
    response.resume();
    socket.end("HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n");
  });
  upstream.on("upgrade", (response, remote, remoteHead) => {
    clearTimeout(timer);
    remote.on("close", () => socket.destroy());
    remote.on("error", () => socket.destroy());
    socket.on("close", () => remote.destroy());
    let status = `HTTP/1.1 ${response.statusCode} ${response.statusMessage}\r\n`;
    for (let i = 0; i < response.rawHeaders.length; i += 2)
      if (
        !["set-cookie", "server"].includes(response.rawHeaders[i].toLowerCase())
      )
        status += `${response.rawHeaders[i]}: ${response.rawHeaders[i + 1]}\r\n`;
    socket.write(`${status}\r\n`);
    if (remoteHead.length) socket.write(remoteHead);
    if (head.length) remote.write(head);
    remote.pipe(socket).pipe(remote);
  });
  upstream.end();
}
