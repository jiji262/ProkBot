import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile, rename, realpath, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join, parse } from 'node:path';
import { CodexProcess, findCodex } from './codex-process.mjs';

const app = { bundleId: 'com.openai.codex', name: 'Codex' };
const active = new Set(['starting', 'running', 'needs_input']);
const text = value => typeof value === 'string' && value.length > 0 && value.length <= 100000;
const outcome = value => ({ status: 'done', outputJson: JSON.stringify({ content: [{ type: 'text', text: JSON.stringify(value) }] }) });
const schema = (properties, required = []) => ({ type: 'object', properties, required, additionalProperties: false });
const jobId = { type: 'string', description: 'Job ID returned by this Mac for this Bot.' };
const prompt = { type: 'string', description: 'Task, context, constraints and acceptance criteria. Sent as JSON text, never shell code.' };
export const codexTools = [
  { name: 'codex_start', description: 'Delegate a coding task to Codex on this Mac. Returns immediately. Uses the Mac Codex account and configured default model. Then call codex_status with waitMs to collect progress and completion.',
    inputSchema: schema({ prompt, cwd: { type: 'string', description: 'Existing absolute project directory on this Mac. Omit for a new isolated project.' } }, ['prompt']) },
  { name: 'codex_status', description: 'Read this Bot’s Codex job status, progress, changed files and result. Wait up to 25 seconds for a change; repeat while working until completed, failed or interrupted.',
    inputSchema: schema({ jobId, waitMs: { type: 'integer', minimum: 0, maximum: 25000 } }, ['jobId']) },
  { name: 'codex_continue', description: 'Continue a completed/interrupted Codex job with context intact, or answer its pending questions. A running job must finish or be cancelled first.',
    inputSchema: schema({ jobId, prompt, answers: { type: 'object', additionalProperties: { type: 'array', items: { type: 'string' } }, description: 'Only answers supplied by the user, keyed by the pending question ID.' } }, ['jobId']) },
  { name: 'codex_cancel', description: 'Interrupt this Bot’s active Codex job. Existing files are retained and can be continued later.', inputSchema: schema({ jobId }, ['jobId']) },
  { name: 'codex_list', description: 'List Codex jobs previously started by this Bot on this paired Mac.', inputSchema: schema({}) },
];

/** Ownership lives on the Mac, separately for every paired Host/device and Bot. */
export async function createCodexBridge({ profile, config, root, decideLocalUse, enabled = () => true,
  executable, processFactory = options => new CodexProcess(options) }) {
  executable ??= await findCodex();
  if (!executable) return { tools: [], close() {}, async call() { return { status: 'failed', error: 'Install and sign in to Codex on this Mac.' }; } };
  const namespace = createHash('sha256').update(`${config.address ?? config.server}\0${config.deviceId}`).digest('hex');
  const directory = join(profile, 'codex-jobs', namespace), file = join(directory, 'jobs.json');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const jobs = new Map(), waiting = new Map(), cancellations = new Map();
  let process, ready, closed = false, writes = Promise.resolve();
  try {
    const saved = JSON.parse(await readFile(file, 'utf8'));
    for (const job of saved.jobs ?? []) {
      if (!text(job.id) || !text(job.conversationId) || !isAbsolute(job.cwd ?? '')) continue;
      if (active.has(job.status)) { job.status = 'interrupted'; job.error = 'Desktop session ended. Continue explicitly to resume.'; }
      jobs.set(job.id, job);
    }
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const persist = () => {
    const snapshot = JSON.stringify({ version: 1, jobs: [...jobs.values()] });
    writes = writes.catch(() => {}).then(async () => {
      await writeFile(`${file}.tmp`, snapshot, { mode: 0o600 }); await rename(`${file}.tmp`, file);
    });
    return writes;
  };
  function changed(job) {
    job.updatedAt = new Date().toISOString();
    for (const wake of waiting.get(job.id) ?? []) wake();
    void persist().catch(() => {});
  }
  function event({ method, params: p = {} }) {
    const job = [...jobs.values()].find(item => item.threadId === p.threadId);
    if (!job || p.turnId && job.turnId && p.turnId !== job.turnId) return;
    if (method === 'turn/started') { job.turnId = p.turn.id; job.status = 'running'; }
    else if (method === 'item/completed') {
      const item = p.item;
      if (item.type === 'agentMessage') { job.message = String(item.text ?? '').slice(-48000); if (item.phase === 'final_answer') job.result = job.message; }
      else if (item.type === 'commandExecution') job.activity = { type: item.type, command: String(item.command).slice(0, 2000), status: item.status, exitCode: item.exitCode };
      else if (item.type === 'fileChange') job.changedFiles = [...new Set([...(job.changedFiles ?? []), ...(item.changes ?? []).map(value => value.path)])].slice(-200);
      else return;
    } else if (method === 'turn/completed') {
      job.status = p.turn.status === 'completed' ? 'completed' : p.turn.status === 'interrupted' ? 'interrupted' : 'failed';
      job.error = p.turn.error?.message; if (!job.result) job.result = job.message;
      delete job.questions; delete job.pendingRequest;
    } else if (method === 'error') job.error = p.error?.message;
    else return;
    changed(job);
  }
  function serverRequest(message) {
    const job = [...jobs.values()].find(item => item.threadId === message.params?.threadId);
    if (message.method === 'item/tool/requestUserInput' && job && active.has(job.status)) {
      job.status = 'needs_input'; job.questions = message.params.questions; job.pendingRequest = message.id; changed(job); return;
    }
    // No generic approval forwarding: a coding grant is not permission to escalate the sandbox.
    if (message.method === 'item/commandExecution/requestApproval' || message.method === 'item/fileChange/requestApproval') process.respond(message.id, { decision: 'decline' });
    else if (message.method === 'item/permissions/requestApproval') process.respond(message.id, { permissions: {}, scope: 'turn' });
    else if (message.method === 'mcpServer/elicitation/request') process.respond(message.id, { action: 'decline', content: null });
    else process.send({ id: message.id, error: { code: -32601, message: 'Unsupported interactive request' } });
  }
  async function connection() {
    if (closed) throw new Error('Codex provider is closed');
    if (ready) return ready;
    process = processFactory({ executable, cwd: root, onEvent: event, onRequest: serverRequest, onExit: () => {
      ready = undefined;
      for (const job of jobs.values()) if (active.has(job.status)) {
        job.status = 'interrupted'; job.error = 'Codex stopped. Continue explicitly to resume.';
        delete job.questions; delete job.pendingRequest; changed(job);
      }
    } });
    ready = process.initialize().then(() => process).catch(error => { ready = undefined; process.close(); throw error; });
    return ready;
  }
  const snapshot = job => {
    const { conversationId, pendingRequest, cancelRequested, ...value } = job;
    return value;
  };
  const owned = (id, conversation) => {
    const job = jobs.get(id);
    if (!job || job.conversationId !== conversation) throw new Error('Codex job not found for this Bot');
    return job;
  };
  async function interrupt(job) {
    if (!active.has(job.status)) return;
    if (cancellations.has(job.id)) return cancellations.get(job.id);
    job.cancelRequested = true;
    const cancelled = (async () => {
      // turn/start acknowledges before the task becomes interruptible in app-server.
      if (job.status === 'starting') await wait(job, 5000);
      if (!active.has(job.status)) return;
      if (job.threadId && job.turnId && ready) await (await ready).request('turn/interrupt', { threadId: job.threadId, turnId: job.turnId });
      job.status = 'interrupted'; delete job.questions; delete job.pendingRequest; changed(job);
    })().finally(() => cancellations.delete(job.id));
    cancellations.set(job.id, cancelled); return cancelled;
  }
  async function run(job, input, resume, signal) {
    const client = await connection(); signal?.throwIfAborted();
    if (closed || !enabled()) throw new Error('Mac local execution is disabled');
    if (job.cancelRequested) throw new Error('Codex task cancelled');
    job.status = 'starting'; job.turnId = undefined; job.result = ''; job.message = ''; job.error = undefined; job.activity = undefined; changed(job);
    // macOS can leave a sandboxed shell waiting in getcwd when access to a
    // protected project folder is unavailable. Check through the same sandbox
    // before creating a model turn; the standalone command has a bounded life.
    const sandboxPolicy = { type: 'workspaceWrite', writableRoots: [job.cwd], networkAccess: true };
    const processId = `project-check-${randomUUID()}`;
    try {
      const probe = await client.request('command/exec', { command: ['/bin/pwd', '-P'], cwd: job.cwd,
        processId, timeoutMs: 5000, sandboxPolicy }, 8000);
      if (probe.exitCode !== 0) throw new Error('Project directory is unavailable');
    } catch {
      await client.request('command/exec/terminate', { processId }, 1000).catch(() => {});
      throw new Error('Codex cannot access this project directory. Allow Grok Bot to access the folder in macOS Privacy & Security settings, or choose another project directory.');
    }
    signal?.throwIfAborted();
    if (closed || !enabled() || job.cancelRequested) throw new Error('Codex task cancelled');
    if (resume) await client.request('thread/resume', { threadId: job.threadId, cwd: job.cwd, approvalPolicy: 'never', sandbox: 'workspace-write', excludeTurns: true });
    else {
      const result = await client.request('thread/start', { cwd: job.cwd, approvalPolicy: 'never', sandbox: 'workspace-write' });
      job.threadId = result.thread.id;
    }
    signal?.throwIfAborted();
    if (closed || !enabled()) throw new Error('Mac local execution is disabled');
    if (job.cancelRequested) throw new Error('Codex task cancelled');
    const started = await client.request('turn/start', { threadId: job.threadId, input: [{ type: 'text', text: input }],
      cwd: job.cwd, approvalPolicy: 'never', sandboxPolicy });
    job.turnId = started.turn.id;
    if (job.status === 'starting') await wait(job, 5000);
    if (signal?.aborted || closed || !enabled() || job.cancelRequested) await interrupt(job);
    await persist(); return snapshot(job);
  }
  async function wait(job, ms, signal) {
    if (!active.has(job.status) || !ms) return;
    await new Promise((resolve, reject) => {
      const callbacks = waiting.get(job.id) ?? new Set(); waiting.set(job.id, callbacks);
      const cleanup = () => { clearTimeout(timer); callbacks.delete(done); signal?.removeEventListener('abort', abort); if (!callbacks.size) waiting.delete(job.id); };
      const done = () => { cleanup(); resolve(); }, abort = () => { cleanup(); reject(new Error('Status request cancelled')); };
      const timer = setTimeout(done, ms); callbacks.add(done); signal?.addEventListener('abort', abort, { once: true });
      if (signal?.aborted) abort();
    });
  }
  return {
    tools: codexTools,
    async call(request, { signal } = {}) {
      try {
        if (closed || !enabled()) throw new Error('Mac local execution is disabled');
        if (!text(request.conversationId)) throw new Error('Bot identity required');
        if (!codexTools.some(tool => tool.name === request.toolId)) throw new Error('Unknown Codex capability');
        const decision = await decideLocalUse({ approvalId: request.approvalId,
          serverAuthoritative: request.authorizedApp === app.bundleId,
          authorization: { kind: request.authorizedApp === app.bundleId ? 'approval' : 'none' },
          describes: { action: 'use-app', target: app.bundleId, recipient: app.bundleId } });
        if (decision.kind === 'ask') return { status: 'ask', app };
        if (decision.kind !== 'allow') throw new Error('Codex access declined');
        signal?.throwIfAborted();
        const args = request.arguments ?? {}, conversation = request.conversationId;
        if (request.toolId === 'codex_list') return outcome({ jobs: [...jobs.values()].filter(job => job.conversationId === conversation).map(snapshot) });
        if (request.toolId === 'codex_start') {
          if (!text(args.prompt)) throw new Error('A task prompt is required');
          const id = randomUUID();
          let cwd;
          if (args.cwd !== undefined) {
            if (!text(args.cwd) || !isAbsolute(args.cwd)) throw new Error('Project directory must be an existing absolute Mac path');
            cwd = await realpath(args.cwd);
            if (!(await stat(cwd)).isDirectory() || cwd === parse(cwd).root || cwd === homedir()) throw new Error('Select a project directory, not the home or filesystem root');
          } else { cwd = join(root, 'codex', id); await mkdir(cwd, { recursive: true, mode: 0o700 }); }
          if ([...jobs.values()].filter(job => active.has(job.status)).length >= 3) throw new Error('Three Codex tasks are already active on this Mac');
          const job = { id, conversationId: conversation, cwd, status: 'starting', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
          jobs.set(id, job);
          try { return outcome(await run(job, args.prompt, false, signal)); }
          catch (error) { job.status = job.cancelRequested ? 'interrupted' : 'failed'; job.error = error.message; changed(job); throw error; }
        }
        const job = owned(args.jobId, conversation);
        if (request.toolId === 'codex_status') { await wait(job, Math.min(25000, Math.max(0, Number(args.waitMs) || 0)), signal); return outcome(snapshot(job)); }
        if (request.toolId === 'codex_cancel') { await interrupt(job); return outcome(snapshot(job)); }
        if (job.status === 'needs_input') {
          const answers = args.answers;
          if (!answers || !job.questions.every(q => Array.isArray(answers[q.id]) && answers[q.id].every(text))) throw new Error('Supply user answers for all pending questions');
          (await connection()).respond(job.pendingRequest, { answers: Object.fromEntries(job.questions.map(q => [q.id, { answers: answers[q.id] }])) });
          delete job.questions; delete job.pendingRequest; job.status = 'running'; changed(job); return outcome(snapshot(job));
        }
        if (active.has(job.status)) throw new Error('Codex is still running; query or cancel the job first');
        if (!job.threadId || !text(args.prompt)) throw new Error('A task continuation prompt is required');
        job.status = 'starting'; job.turnId = undefined; job.cancelRequested = false;
        try { return outcome(await run(job, args.prompt, true, signal)); }
        catch (error) { job.status = job.cancelRequested ? 'interrupted' : 'failed'; job.error = error.message; changed(job); throw error; }
      } catch (error) { return { status: 'failed', error: error.message }; }
    },
    stop() { for (const job of jobs.values()) void interrupt(job).catch(() => {}); },
    close() { closed = true; this.stop(); process?.close(); },
  };
}
