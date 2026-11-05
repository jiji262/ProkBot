import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

export function tailcatLink(value) {
  const input = String(value ?? '').trim();
  if (/^tc[A-Za-z0-9_-]{30,16384}$/.test(input)) return `tailcat://connect/${input}?port=8000`;
  let url; try { url = new URL(input); } catch { throw new Error('Invalid Tailcat link'); }
  if (url.protocol !== 'tailcat:' || url.hostname !== 'connect' || url.username || url.password || url.hash ||
      !/^\/tc[A-Za-z0-9_-]{30,16384}$/.test(url.pathname) || [...url.searchParams.keys()].join() !== 'port' ||
      !/^[1-9][0-9]{0,4}$/.test(url.searchParams.get('port')) || Number(url.searchParams.get('port')) > 65535)
    throw new Error('Invalid Tailcat link');
  return url.href;
}

/** One helper owns one listener. Restart on the same local port, without replaying requests. */
export class TailcatProcess {
  constructor(config, { binary, onIdentity = async () => {}, onStatus = () => {} } = {}) {
    this.config = { ...config };
    if (config.mode === 'forward') this.config.link = tailcatLink(config.link);
    this.binary = binary ?? process.env.GROKBOT_TAILCAT_BINARY ?? fileURLToPath(new URL('../../dist/network/grokbot-tailcat', import.meta.url));
    this.onIdentity = onIdentity; this.onStatus = onStatus;
    this.status = { state: 'disabled', path: 'unknown' }; this.closed = false; this.failures = 0;
  }
  async start() {
    if (this.pending) return this.pending;
    if (this.closed) throw new Error('Tailcat is closed');
    this.pending = this.launch().finally(() => { this.pending = null; });
    return this.pending;
  }
  launch() {
    return new Promise((resolve, reject) => {
      let settled = false;
      this.status = { ...this.status, state: 'connecting', error: '' }; this.onStatus(this.status);
      const child = spawn(this.binary, [], { stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true });
      this.child = child;
      const lines = createInterface({ input: child.stdout });
      const timeout = setTimeout(() => { child.kill('SIGTERM'); fail(); }, 45000); timeout.unref();
      const fail = () => {
        if (!settled) { settled = true; clearTimeout(timeout); reject(new Error('Tailcat connection unavailable')); }
      };
      child.stdin.on('error', fail);
      child.stdin.write(JSON.stringify(this.config) + '\n');
      lines.on('line', async line => {
        try {
          if (line.length > 65536) throw new Error('Invalid tunnel response');
          const value = JSON.parse(line);
          if (this.closed || child !== this.child) return;
          if (value.error) { fail(); return; }
          if (value.ready) {
            await this.onIdentity(value.identity);
            if (this.closed || child !== this.child) return;
            this.config.identity = value.identity;
            if (value.status.localURL) this.config.localPort = Number(new URL(value.status.localURL).port);
            this.failures = 0; clearTimeout(timeout);
            this.status = value.status; this.onStatus(this.status);
            if (!settled) { settled = true; resolve(this.status); }
          } else if (value.status) { this.status = value.status; this.onStatus(this.status); }
        } catch { fail(); child.kill('SIGTERM'); }
      });
      child.on('error', fail);
      child.once('close', () => {
        clearTimeout(timeout); lines.close(); fail();
        if (child !== this.child || this.closed) return;
        this.child = null; this.status = { ...this.status, state: 'reconnecting', path: 'unknown' }; this.onStatus(this.status);
        this.timer = setTimeout(() => { void this.start().catch(() => {}); }, Math.min(30000, 1000 * 2 ** this.failures++));
        this.timer.unref();
      });
    });
  }
  async close() {
    this.closed = true; clearTimeout(this.timer);
    const child = this.child; this.child = null;
    if (child && child.exitCode === null && child.signalCode === null) {
      await new Promise(resolve => {
        const timer = setTimeout(() => child.kill('SIGKILL'), 3000); timer.unref();
        child.once('close', () => { clearTimeout(timer); resolve(); }); child.kill('SIGTERM');
      });
    }
    this.status = { state: 'disabled', path: 'unknown' };
  }
}
