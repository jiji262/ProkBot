import http from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';

// Only this loopback listener can mark a request as having arrived over Tailcat.
// This keeps absolute desktop/voice/file URLs on the client's local tunnel.
export async function tailcatIngress(target) {
  const token = randomBytes(32).toString('hex'), sockets = new Set();
  const headers = request => ({ ...request.headers, 'x-grokbot-tailcat-ingress': token });
  const track = socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); };
  const server = http.createServer((request, response) => {
    const upstream = http.request(`http://${target}`, { method: request.method, path: request.url, headers: headers(request) });
    response.on('close', () => upstream.destroy()); request.on('error', () => upstream.destroy());
    upstream.on('error', () => { if (!response.headersSent) response.writeHead(502); response.end(); });
    upstream.on('response', incoming => { response.writeHead(incoming.statusCode, incoming.headers); response.flushHeaders(); incoming.pipe(response); });
    request.pipe(upstream);
  });
  server.on('connection', track);
  server.on('upgrade', (request, socket, head) => {
    const upstream = http.request(`http://${target}`, { path: request.url, headers: headers(request) });
    socket.on('error', () => upstream.destroy()); socket.on('close', () => upstream.destroy());
    upstream.on('error', () => socket.destroy());
    upstream.on('response', response => { response.resume(); socket.destroy(); });
    upstream.on('upgrade', (response, remote, remoteHead) => {
      track(remote); remote.on('error', () => socket.destroy()); remote.on('close', () => socket.destroy()); socket.on('close', () => remote.destroy());
      let status = `HTTP/1.1 ${response.statusCode} ${response.statusMessage}\r\n`;
      for (let i = 0; i < response.rawHeaders.length; i += 2) status += `${response.rawHeaders[i]}: ${response.rawHeaders[i + 1]}\r\n`;
      socket.write(status + '\r\n'); if (remoteHead.length) socket.write(remoteHead); if (head.length) remote.write(head);
      socket.pipe(remote).pipe(socket);
    });
    upstream.end();
  });
  server.requestTimeout = 0;
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  return { target: `127.0.0.1:${server.address().port}`,
    matches(request) {
      const value = request.headers['x-grokbot-tailcat-ingress'];
      return ['127.0.0.1', '::ffff:127.0.0.1'].includes(request.socket.remoteAddress) && typeof value === 'string' &&
        Buffer.byteLength(value) === token.length && timingSafeEqual(Buffer.from(value), Buffer.from(token));
    },
    async close() { for (const socket of sockets) socket.destroy(); await new Promise(resolve => server.close(resolve)); },
  };
}
