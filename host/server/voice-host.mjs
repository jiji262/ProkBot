import { randomUUID } from 'node:crypto';
import { check, HttpError } from './security.mjs';

const MAX_TURNS = 200;
const MAX_SPEECH_CHARS = 64 * 1024;
const aborted = () => new DOMException('Voice response cancelled', 'AbortError');
const validId = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value);

function observe(promise, signal) {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(signal.reason ?? aborted());
  return new Promise((resolve, reject) => {
    const stop = () => reject(signal.reason ?? aborted());
    signal.addEventListener('abort', stop, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', stop));
  });
}

/**
 * The original VoiceCallRuntime runs nudgeVoiceCall on the Bot's existing
 * scheduler/runner, with its current model, context and tools. Its plain-text
 * result belongs to that exact voice turn; no transcript polling or second LLM
 * is needed. See original voice-call-runtime.ts and shared/voice-call/record.ts.
 *
 * An abort stops delivery, not the shared Bot runner: interruptAgentRun only
 * accepts agentId and can otherwise stop unrelated work. Accepted work drains
 * before the original hang-up receipt is saved. The owner must retain this
 * object for reconnects and reject unknown/expired session IDs after restart.
 */
export class VoiceHostSession {
  constructor({ hostCall, agentId, callId = randomUUID(), modelLabel = 'Host',
    now = Date.now, requestTimeoutMs = 180_000 }) {
    check(typeof hostCall === 'function', 500, 'Host connection is required');
    check(validId(agentId) && validId(callId), 400, 'Invalid voice session');
    check(typeof modelLabel === 'string' && modelLabel.length <= 256, 400, 'Invalid model label');
    this.hostCall = hostCall;
    this.agentId = agentId;
    this.callId = callId;
    this.modelLabel = modelLabel;
    this.now = now;
    this.requestTimeoutMs = requestTimeoutMs;
    this.startedAtMs = now();
    this.requests = new Map();
    this.turns = [];
    this.nudges = [];
    this.speechChars = 0;
    this.queue = Promise.resolve();
    this.endedAtMs = null;
    this.endPromise = null;
  }

  async context({ signal } = {}) {
    return this.hostCall('readVoiceCallAgentContext', { id: this.agentId }, { signal });
  }

  turn({ id, text, signal } = {}) {
    check(validId(id), 400, 'Invalid voice turn ID');
    check(typeof text === 'string' && text.trim().length > 0 && text.length <= 16 * 1024,
      400, 'Invalid voice transcript');
    const existing = this.requests.get(id);
    if (existing) {
      check(existing.text === text, 409, 'Voice turn ID was already used');
      return this.observeTurn(existing, signal);
    }
    check(this.endedAtMs === null, 410, 'Voice session has ended');
    check(this.requests.size < MAX_TURNS && this.speechChars + text.length <= MAX_SPEECH_CHARS,
      413, 'Voice session transcript is full');
    if (signal?.aborted) return Promise.reject(signal.reason ?? aborted());
    const request = { id, text, atMs: this.now(), cancelled: false, dispatched: false,
      cancel: new AbortController(), promise: null };
    this.requests.set(id, request);
    this.speechChars += text.length;
    request.promise = this.queue.then(() => this.execute(request));
    // Keep the outcome for retries, including uncertain network failures. A
    // failed request must never rerun an action merely because HTTP is retried.
    this.queue = request.promise.catch(() => {});
    return this.observeTurn(request, signal);
  }

  observeTurn(request, signal) {
    const onAbort = () => this.cancel(request.id);
    if (signal?.aborted) onAbort();
    else signal?.addEventListener('abort', onAbort, { once: true });
    const response = observe(request.promise, request.cancel.signal);
    return response.finally(() => signal?.removeEventListener('abort', onAbort));
  }

  async execute(request) {
    if (request.cancelled || this.endedAtMs !== null) throw aborted();
    request.dispatched = true;
    this.turns.push({ id: request.id, speaker: 'user', text: request.text, atMs: request.atMs });
    const nudge = { id: request.id, request: request.text, atMs: request.atMs, answer: null };
    this.nudges.push(nudge);
    const reply = await this.hostCall('nudgeVoiceCall', {
      id: this.agentId, callId: this.callId, request: request.text,
      spokenTurns: this.turns.filter(turn => turn.speaker === 'user').map(turn => turn.text),
      isCallerOnCall: true,
    }, { signal: AbortSignal.timeout(this.requestTimeoutMs) });
    check(reply && (reply.answer === null || typeof reply.answer === 'string'),
      502, 'Invalid Host voice response');
    if (reply.refusal) {
      const error = new HttpError(reply.refusal === 'agent-unavailable' ? 409 : 422,
        `Host voice request refused: ${reply.refusal}`);
      error.code = 'voice-host-refused';
      error.refusal = reply.refusal;
      throw error;
    }
    const answer = reply.answer?.trim() ?? '';
    nudge.answer = answer || null;
    if (request.cancelled || this.endedAtMs !== null) throw aborted();
    check(answer || reply.isStillWorking === true, 503, 'Host returned no voice answer');
    request.answer = answer;
    return { id: request.id, text: answer, isStillWorking: reply.isStillWorking === true,
      status: answer ? 'answered' : 'working' };
  }

  /** Record only text actually played; cancelled/generated text stays in nudges. */
  spoken(id, text) {
    const request = this.requests.get(id);
    check(request && typeof request.answer === 'string', 404, 'Voice response not found');
    check(typeof text === 'string' && request.answer.startsWith(text), 400, 'Invalid spoken text');
    if (!text || this.endedAtMs !== null) return;
    const turnId = `${id}-assistant`;
    const existing = this.turns.find(turn => turn.id === turnId);
    if (existing) {
      check(text.startsWith(existing.text), 409, 'Spoken text cannot shrink');
      existing.text = text;
    } else this.turns.push({ id: turnId, speaker: 'assistant', text, atMs: this.now() });
  }

  cancel(id) {
    const request = this.requests.get(id);
    if (!request || request.cancelled) return false;
    request.cancelled = true;
    request.cancel.abort(aborted());
    return true;
  }

  end({ ending = 'hung-up' } = {}) {
    check(['hung-up', 'disconnected', 'failed'].includes(ending), 400, 'Invalid call ending');
    if (this.endPromise) return this.endPromise;
    this.endedAtMs = this.now();
    for (const id of this.requests.keys()) this.cancel(id);
    this.endPromise = this.queue.then(async () => {
      const record = {
        callId: this.callId, agentId: this.agentId, model: this.modelLabel,
        startedAtMs: this.startedAtMs, endedAtMs: this.endedAtMs,
        durationMs: Math.max(0, this.endedAtMs - this.startedAtMs), ending,
        turns: structuredClone(this.turns), nudges: structuredClone(this.nudges),
      };
      await this.hostCall('recordVoiceCall', { record });
      return record;
    });
    return this.endPromise;
  }
}

export const createVoiceHostSession = options => new VoiceHostSession(options);
