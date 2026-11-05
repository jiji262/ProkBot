import { spawn } from 'node:child_process';
import { access, constants } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

export async function findCodex({ env = process.env, home = homedir() } = {}) {
  const candidates = [...(env.PATH ?? '').split(':').filter(Boolean).map(dir => join(dir, 'codex')),
    join(home, '.local/bin/codex'), '/opt/homebrew/bin/codex', '/usr/local/bin/codex',
    '/Applications/Codex.app/Contents/Resources/codex'];
  for (const candidate of new Set(candidates)) {
    if (await access(candidate, constants.X_OK).then(() => true, () => false)) return candidate;
  }
}

/** One private stdio transport; never attaches to the user's open Codex threads. */
export class CodexProcess {
  constructor({ executable, cwd, onEvent = () => {}, onRequest = () => {}, onExit = () => {}, env = process.env }) {
    this.pending = new Map(); this.nextId = 1; this.closed = false;
    const childEnv = { ...env };
    // A developer may launch Electron from inside Codex. These identify that
    // parent's tools/session, not this independently authenticated app-server.
    for (const key of ['CODEX_THREAD_ID', 'CODEX_TURN_ID', 'CODEX_SESSION_ID', 'CODEX_TOOL_CALL_ID',
      'CODEX_INTERNAL_ORIGINATOR_OVERRIDE', 'CODEX_APP_TOOLS_PIPE_PATH', 'CODEX_TASK_WORKSPACE_VERIFYING_IDENTITY',
      'BROWSER_USE_ACCESS_VERIFYING_IDENTITY', 'NODE_REPL_TRUSTED_BROWSER_CLIENT_SHA256S',
      'CODEX_PERMISSION_PROFILE', 'CODEX_SHELL', 'CODEX_CI']) delete childEnv[key];
    this.child = spawn(executable, ['app-server', '--listen', 'stdio://', '-c', 'analytics.enabled=false'], {
      cwd, env: childEnv, stdio: ['pipe', 'pipe', 'pipe'], shell: false,
    });
    let buffer = '';
    this.child.stderr.on('data', () => {}); // Runtime diagnostics can contain local account details.
    this.child.stdin.on('error', () => {});
    this.child.stdout.setEncoding('utf8');
    this.child.stdout.on('data', chunk => {
      buffer += chunk;
      if (buffer.length > 16 * 1024 * 1024) return this.close();
      let at;
      while ((at = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, at); buffer = buffer.slice(at + 1);
        if (!line.trim()) continue;
        let message;
        try { message = JSON.parse(line); } catch { continue; }
        if (message.method) {
          if (message.id !== undefined) onRequest(message);
          else onEvent(message);
        } else if (message.id !== undefined) {
          const waiting = this.pending.get(message.id);
          if (!waiting) continue;
          this.pending.delete(message.id); clearTimeout(waiting.timer);
          message.error ? waiting.reject(new Error(message.error.message || 'Codex request failed')) : waiting.resolve(message.result);
        }
      }
    });
    const exited = error => {
      if (this.closed) return;
      this.closed = true;
      for (const value of this.pending.values()) { clearTimeout(value.timer); value.reject(error); }
      this.pending.clear(); onExit(error);
    };
    this.child.once('error', error => exited(new Error(`Codex could not start: ${error.code ?? 'unknown error'}`)));
    this.child.once('exit', () => exited(new Error('Codex process stopped')));
  }
  send(value) {
    if (this.closed || !this.child.stdin.writable) throw new Error('Codex process is unavailable');
    this.child.stdin.write(JSON.stringify(value) + '\n');
  }
  request(method, params, timeoutMs = 30000) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`Codex ${method} timed out`)); }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try { this.send({ id, method, params }); }
      catch (error) { clearTimeout(timer); this.pending.delete(id); reject(error); }
    });
  }
  async initialize() {
    await this.request('initialize', { clientInfo: { name: 'grokbot_local', title: 'Grok Bot', version: '1.0.0' } });
    this.send({ method: 'initialized', params: {} });
  }
  respond(id, result) { this.send({ id, result }); }
  close() {
    if (this.closed) return;
    this.child.stdin.end(); this.child.kill('SIGTERM');
    const timer = setTimeout(() => { if (!this.closed) this.child.kill('SIGKILL'); }, 3000); timer.unref();
  }
}
