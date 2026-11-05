import { startExecutionTailcat } from './execution-tailcat.mjs';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { equal, sendJson, securityHeaders } from '../server/security.mjs';
import { proxyHttp, proxyWebSocket } from '../server/proxy.mjs';

/** One authenticated endpoint for the shipped Exec/window/VNC protocols. */
export function createExecutionGateway({ token, boxHost = 'box', boxToken = 'local', ports = {}, tls } = {}) {
  if (!/^[A-Za-z0-9_-]{32,256}$/.test(token ?? '')) throw new Error('A strong execution node key is required');
  if (!/^[A-Za-z0-9.-]+$/.test(boxHost)) throw new Error('Invalid execution desktop hostname');
  const services = { exec: ports.exec ?? 1337, windows: ports.windows ?? 1339,
    desktop: ports.desktop ?? 6080, fork: ports.fork ?? 6081 };
  const sockets = new Set();
  const authorized = request => equal(request.headers.authorization, `Bearer ${token}`);
  function route(request) {
    const pathname = request.url.split('?')[0];
    if (pathname.includes('..') || /%2e|%2f|%5c|\\/i.test(pathname)) return null;
    const match = /^\/(exec|windows|vnc\/(desktop|fork))(\/[^#]*)$/.exec(request.url);
    if (!match) return null;
    return { target: new URL(`http://${boxHost}:${services[match[2] ?? match[1]]}`), path: match[3], token: boxToken };
  }
  const probe = port => new Promise(resolve => {
    const socket = net.connect({ host: boxHost, port });
    const done = ready => { socket.destroy(); resolve(ready); };
    socket.once('connect', () => done(true)); socket.once('error', () => done(false)); socket.setTimeout(1500, () => done(false));
  });
  async function handle(request, response) {
    securityHeaders(response);
    if (!authorized(request)) { request.resume(); return sendJson(response, 401, { error: 'Unauthorized' }); }
    if (request.method === 'GET' && request.url === '/health') {
      const states = Object.fromEntries(await Promise.all(Object.entries(services).map(async ([name, port]) => [name, await probe(port)])));
      return sendJson(response, 200, { protocol: 'grokbot-execution/v1', ready: Object.values(states).every(Boolean), services: states });
    }
    const destination = route(request);
    if (!destination || !['GET', 'HEAD', 'POST'].includes(request.method)) { request.resume(); return sendJson(response, 404, { error: 'Not found' }); }
    return proxyHttp(request, response, destination);
  }
  const callback = (request, response) => handle(request, response).catch(() => sendJson(response, 502, { error: 'Execution service unavailable' }));
  const server = tls ? https.createServer(tls, callback) : http.createServer(callback);
  server.on('connection', socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); });
  server.on('upgrade', (request, socket, head) => {
    const destination = route(request);
    if (!authorized(request) || !request.url.startsWith('/vnc/') || !destination) return socket.end('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
    proxyWebSocket(request, socket, head, destination);
  });
  return { server, async start(port = 8443, bind = '0.0.0.0') {
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, bind, resolve); }); return server.address();
  }, async close() { for (const socket of sockets) socket.destroy(); if (server.listening) await new Promise(resolve => server.close(resolve)); } };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const token = process.env.GROKBOT_NODE_TOKEN_FILE ? (await readFile(process.env.GROKBOT_NODE_TOKEN_FILE, 'utf8')).trim() : process.env.GROKBOT_NODE_TOKEN;
  const tls = process.env.GROKBOT_NODE_TLS_CERT ? { cert: await readFile(process.env.GROKBOT_NODE_TLS_CERT), key: await readFile(process.env.GROKBOT_NODE_TLS_KEY) } : undefined;
  const gateway = createExecutionGateway({ token, tls, boxHost: process.env.GROKBOT_BOX_HOST ?? 'box', boxToken: process.env.GROKBOT_BOX_TOKEN ?? 'local' });
  const address = await gateway.start(Number(process.env.GROKBOT_NODE_PORT ?? 8443), process.env.GROKBOT_NODE_BIND ?? '0.0.0.0');
  const internal = tls && process.env.GROKBOT_TAILCAT_ENABLED === '1' ? createExecutionGateway({ token, boxHost: process.env.GROKBOT_BOX_HOST ?? 'box', boxToken: process.env.GROKBOT_BOX_TOKEN ?? 'local' }) : null;
  const tailcatPort = internal ? (await internal.start(0, '127.0.0.1')).port : address.port;
  const tunnel = await startExecutionTailcat(tailcatPort);
  console.log('[execution-node] ready');
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, async () => { await tunnel?.close(); await internal?.close(); await gateway.close(); });
}
