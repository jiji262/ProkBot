import { setTimeout as delay } from 'node:timers/promises';

export async function readSse(body, consume) {
  let buffer = '';
  const decoder = new TextDecoder();
  for await (const chunk of body) {
    buffer += decoder.decode(chunk, { stream: true });
    if (buffer.length > 16 * 1024 * 1024) throw new Error('事件超过大小限制');
    let boundary;
    while ((boundary = /\r?\n\r?\n/.exec(buffer))) {
      const block = buffer.slice(0, boundary.index);
      buffer = buffer.slice(boundary.index + boundary[0].length);
      const lines = block.split(/\r?\n/);
      const data = lines.filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n');
      if (!data) continue;
      await consume({ data: JSON.parse(data),
        id: lines.find(line => line.startsWith('id:'))?.slice(3).trim(),
        event: lines.find(line => line.startsWith('event:'))?.slice(6).trim() });
    }
  }
}

export async function subscribe(config, endpoint, consume, signal, options = {}) {
  let failures = 0, lastId = options.lastId ?? '';
  while (!signal.aborted) {
    const request = new AbortController();
    const abort = () => request.abort(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
    const timeout = setTimeout(() => request.abort(), 15000);
    try {
      signal.throwIfAborted();
      const response = await fetch(`${config.server}${endpoint}`, {
        headers: { Authorization: `Bearer ${config.token}`, ...(lastId ? { 'Last-Event-ID': lastId } : {}) },
        signal: request.signal, redirect: 'error',
      });
      clearTimeout(timeout);
      if (response.status === 401) { options.onUnauthorized?.(); return; }
      if (!response.ok || !response.body) throw new Error(`HTTP ${response.status}`);
      failures = 0;
      options.onConnected?.();
      await readSse(response.body, async frame => {
        await consume(frame);
        if (frame.id) lastId = frame.id;
      });
      throw new Error('事件连接结束');
    } catch (error) {
      if (signal.aborted) return;
      options.onDisconnected?.(error);
    } finally {
      clearTimeout(timeout);
      signal.removeEventListener('abort', abort);
      request.abort();
    }
    try { await delay(Math.min(500 * 2 ** Math.min(failures++, 4), 10000), undefined, { signal }); }
    catch { return; }
  }
}
