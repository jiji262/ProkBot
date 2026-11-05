import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, readFile, readdir, rename, rm, unlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { deserialize, serialize } from 'node:v8';

const scopes = new AsyncLocalStorage();
const executions = new AsyncLocalStorage();
const active = new Map();
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const canonical = value => Array.isArray(value) ? value.map(canonical)
  : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;

/** Each runner, including a child runner, supplies its own durable conversation identity. */
export function withToolJournalScope(conversationId, execute) {
  if (typeof conversationId !== 'string' || !conversationId) throw new Error('A tool journal requires a conversation ID');
  const parent = scopes.getStore();
  return scopes.run({ conversationId, parentConversationId: parent?.conversationId,
    rootConversationId: parent?.rootConversationId ?? conversationId }, execute);
}

/** Capture the original protobuf completion for transcript/UI delivery after a result-only recovery. */
export function captureToolCompletion(callId, toolCall) {
  const current = executions.getStore();
  if (current?.toolCallId === callId) current.completion = toolCall.toBinary();
}

/** Called after the Host has interrupted and removed an agent. */
export async function removeToolJournal(conversationId, root = process.env.SAND_DATA_ROOT) {
  if (typeof conversationId !== 'string' || !conversationId || !root) throw new Error('Journal cleanup requires a conversation ID and data root');
  const base = join(resolve(root), 'tool-execution-journal');
  const names = await readdir(base).catch(error => { if (error.code !== 'ENOENT') throw error; return []; });
  const records = await Promise.all(names.map(async name => {
    const path = join(base, name);
    return { path, scope: JSON.parse(await readFile(join(path, 'scope.json'), 'utf8')) };
  }));
  const removed = new Set([conversationId]);
  let changed;
  do {
    changed = false;
    for (const { scope } of records) {
      if (!removed.has(scope.conversationId) && (removed.has(scope.parentConversationId) || removed.has(scope.rootConversationId))) {
        removed.add(scope.conversationId); changed = true;
      }
    }
  } while (changed);
  const directories = records.filter(({ scope }) => removed.has(scope.conversationId)).map(({ path }) => path);
  if ([...active.keys()].some(key => directories.some(directory => key.startsWith(directory + '/')))) {
    throw new Error('Cannot remove an active tool execution journal; retained parent and child execution records');
  }
  for (const directory of directories) await rm(directory, { recursive: true, force: true });
  if (names.length) await syncDirectory(base);
  return { removedScopes: directories.length };
}

async function syncDirectory(directory) {
  const fd = await open(directory, 'r');
  try { await fd.sync(); } finally { await fd.close(); }
}

async function writeExclusive(path, bytes) {
  const fd = await open(path, 'wx', 0o600);
  try { await fd.writeFile(bytes); await fd.sync(); } finally { await fd.close(); }
}

async function writeAtomic(directory, name, bytes) {
  const temporary = join(directory, `${name}.${process.pid}.${randomUUID()}.tmp`);
  try {
    await writeExclusive(temporary, bytes);
    await rename(temporary, join(directory, name));
    await syncDirectory(directory);
  } finally { await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
}

function unknownMessage(descriptor, reason) {
  const text = `Tool execution outcome is UNKNOWN. ${reason} This call was not automatically repeated. An earlier attempt may already have changed external state. Inspect that state before deciding on a new action; do not retry merely because this result is unknown.`;
  return { role: 'tool', id: descriptor.toolCallId,
    content: [{ type: 'tool-result', toolName: descriptor.toolName, toolCallId: descriptor.toolCallId,
      result: text, experimental_content: [{ type: 'text', text }] }],
    providerOptions: { cursor: { highLevelToolCallResult: { isError: true,
      output: { executionStatus: 'unknown', automaticReplayBlocked: true, message: text } } } } };
}

/** Durable admission precedes effects. A crash without a durable result never admits a second execution. */
export async function runJournaledTool({ descriptor, argumentsText, turnId = 'unscoped-turn', signal, isDeferred, execute, captureDelivery, onReplay }) {
  const scope = scopes.getStore();
  // Low-level consumers outside a SandAgentRunner must deliberately supply an equivalent scope.
  if (!scope) throw new Error('Tool execution has no durable conversation scope');
  if (signal?.aborted) throw Object.assign(new Error('Tool execution aborted before admission'), { name: 'AbortError' });
  const root = process.env.SAND_DATA_ROOT;
  if (!root) throw new Error('Tool execution requires SAND_DATA_ROOT for its durable journal');
  if (typeof descriptor.toolCallId !== 'string' || !descriptor.toolCallId) throw new Error('Tool call ID is required');
  let argumentsValue;
  try { argumentsValue = canonical(JSON.parse(argumentsText)); } catch { argumentsValue = argumentsText; }
  const fingerprint = digest(JSON.stringify({ name: descriptor.effectiveNativeToolCall?.toolName ?? descriptor.toolName,
    args: argumentsValue }));
  const base = join(resolve(root), 'tool-execution-journal');
  const directory = join(base, digest(scope.conversationId), digest(JSON.stringify([turnId, descriptor.toolCallId])));
  const activeKey = `${directory}:${fingerprint}`;
  if (active.has(activeKey)) return await active.get(activeKey);
  const deliverUnknown = async reason => {
    const result = unknownMessage(descriptor, reason);
    await onReplay?.(undefined, result, undefined);
    return result;
  };
  const operation = (async () => {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    try { await writeExclusive(join(base, digest(scope.conversationId), 'scope.json'), JSON.stringify(scope) + '\n'); }
    catch (error) { if (error.code !== 'EEXIST') throw error; }
    await syncDirectory(resolve(root));
    await syncDirectory(base);
    await syncDirectory(join(base, digest(scope.conversationId)));
    const intentPath = join(directory, 'intent.json');
    const intent = { version: 1, conversationId: scope.conversationId, turnId, toolCallId: descriptor.toolCallId,
      toolName: descriptor.toolName, fingerprint, startedAt: new Date().toISOString() };
    let existing;
    try {
      await writeExclusive(intentPath, JSON.stringify(intent) + '\n');
      await syncDirectory(directory);
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      try { existing = JSON.parse(await readFile(intentPath, 'utf8')); }
      catch { return await deliverUnknown('The durable execution intent is unreadable.'); }
      if (existing.fingerprint !== fingerprint) return await deliverUnknown('This tool-call ID already belongs to different arguments.');
      let record;
      try {
        record = deserialize(await readFile(join(directory, 'result.v8')));
        if (record.version !== 1 || record.fingerprint !== fingerprint) throw new Error('Result fingerprint mismatch');
      } catch (error) {
        if (error.code !== 'ENOENT') return await deliverUnknown('The saved execution result is unreadable.');
      }
      if (record) { await onReplay?.(record.delivery, record.result, record.completion); return record.result; }
      // A structured interaction deferral is an explicit before-execution continuation boundary.
      // Claim it atomically so only one resume can execute after user input arrives.
      try { await rename(join(directory, 'deferred'), join(directory, `resumed-${randomUUID()}`)); }
      catch (error) {
        if (error.code !== 'ENOENT') throw error;
        return await deliverUnknown('A prior execution started but has no durable completed result.');
      }
      await syncDirectory(directory);
    }
    if (signal?.aborted) {
      // Admission has happened, but execution has not. Preserve a durable, unambiguous result.
      const result = unknownMessage(descriptor, 'Cancellation was observed before invoking the tool body; no tool body was started by this attempt.');
      await writeAtomic(directory, 'result.v8', serialize({ version: 1, fingerprint, result }));
      return result;
    }
    let result;
    const execution = { toolCallId: descriptor.toolCallId };
    try { result = await executions.run(execution, execute); }
    catch (error) {
      if (isDeferred?.(error)) {
        await writeAtomic(directory, 'deferred', Buffer.from('Awaiting an explicit interaction continuation.\n'));
      }
      // Every other failure conservatively retains an unresolved intent, including timeout and cancellation.
      throw error;
    }
    await writeAtomic(directory, 'result.v8', serialize({ version: 1, fingerprint, result,
      completion: execution.completion, delivery: captureDelivery?.() }));
    return result;
  })();
  active.set(activeKey, operation);
  try { return await operation; } finally { active.delete(activeKey); }
}
