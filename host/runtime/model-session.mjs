import { randomUUID } from 'node:crypto';

export const SUPPORTED_MODELS = Object.freeze([
  'deepseek-flash', 'deepseek-v4.1-flash', 'deepseek-v4.1-flash-sg',
]);

export class ModelRequestError extends Error {
  constructor(message, { status, code, retryAfterMs, cause } = {}) {
    super(message, { cause });
    this.name = 'ModelRequestError';
    this.status = status;
    this.code = code;
    this.retryAfterMs = retryAfterMs;
  }
}

function retryAfterMs(headers) {
  const value = headers?.get('retry-after')?.trim();
  if (!value) return undefined;
  if (/^\d+(?:\.\d+)?$/.test(value)) {
    const milliseconds = Number(value) * 1000;
    return Number.isFinite(milliseconds) ? milliseconds : undefined;
  }
  // HTTP-date is the other Retry-After form; reject numeric-looking invalid values.
  if (!/[a-z]/i.test(value)) return undefined;
  const deadline = Date.parse(value);
  return Number.isFinite(deadline) ? Math.max(0, deadline - Date.now()) : undefined;
}

function imageUrl(part) {
  const value = part.image ?? part.data ?? part.url;
  if (value instanceof URL) return imageUrl({ ...part, image: value.href });
  if (typeof value === 'string') {
    if (/^(https?:\/\/|data:image\/)/i.test(value)) return value;
    if (/^[a-z][\w+.-]*:/i.test(value)) throw new TypeError('Unsupported image URL scheme');
    if (!value.trim()) throw new TypeError('Image content is empty');
    return `data:${part.mimeType ?? 'image/png'};base64,${value}`;
  }
  if (value instanceof ArrayBuffer || ArrayBuffer.isView(value)) {
    const bytes = value instanceof ArrayBuffer ? Buffer.from(value)
      : Buffer.from(value.buffer, value.byteOffset, value.byteLength);
    return `data:${part.mimeType ?? 'image/png'};base64,${bytes.toString('base64')}`;
  }
  throw new TypeError('Image must contain a URL, base64 string, or bytes');
}

function textValue(value) {
  return typeof value === 'string' ? value : JSON.stringify(value ?? '');
}

/** Translate the original Harness CoreMessage representation without losing screenshots. */
export function convertMessages(messages) {
  const output = [];
  let toolImages = [];
  const flushToolImages = () => {
    if (!toolImages.length) return;
    output.push({ role: 'user', content: [
      { type: 'text', text: 'Screenshots from the preceding tool results:' }, ...toolImages,
    ] });
    toolImages = [];
  };
  for (const message of messages) {
    if (message.role !== 'tool') flushToolImages();
    const parts = typeof message.content === 'string'
      ? [{ type: 'text', text: message.content }] : message.content ?? [];
    if (message.role === 'tool') {
      for (const part of parts) {
        if (part.type !== 'tool-result' || !part.toolCallId) {
          throw new TypeError('Tool messages require tool-result parts and toolCallId');
        }
        const extra = part.experimental_content ?? [];
        const fallback = extra.filter(p => p.type === 'text').map(p => p.text).join('\n');
        output.push({ role: 'tool', tool_call_id: part.toolCallId,
          content: part.result === undefined ? fallback : textValue(part.result) });
        toolImages.push(...extra.filter(p => p.type === 'image').map(p => ({
          type: 'image_url', image_url: { url: imageUrl(p) },
        })));
      }
    } else if (message.role === 'assistant') {
      const content = parts.filter(p => p.type === 'text').map(p => p.text).join('');
      const reasoning = parts.filter(p => p.type === 'reasoning').map(p => p.text).join('');
      const calls = parts.filter(p => p.type === 'tool-call').map(p => ({
        id: p.toolCallId, type: 'function',
        function: { name: p.toolName, arguments: textValue(p.args ?? {}) },
      }));
      output.push({ role: 'assistant', content: content || (calls.length ? null : ''),
        ...(reasoning ? { reasoning_content: reasoning } : {}),
        ...(calls.length ? { tool_calls: calls } : {}) });
    } else if (['user', 'system', 'developer'].includes(message.role)) {
      const content = parts.map(part => {
        if (part.type === 'text') return { type: 'text', text: part.text };
        if (part.type === 'image' && message.role === 'user') {
          return { type: 'image_url', image_url: { url: imageUrl(part) } };
        }
        throw new TypeError(`Unsupported ${message.role} content type: ${part.type}`);
      });
      output.push({ role: message.role, content: content.every(p => p.type === 'text')
        ? content.map(p => p.text).join('') : content });
    } else {
      throw new TypeError(`Unsupported message role: ${message.role}`);
    }
  }
  flushToolImages();
  return output;
}

export function convertTools(tools = []) {
  return tools.map(tool => {
    if (tool.type === 'provider-defined' || tool.customToolFormat) {
      throw new TypeError('This session supports JSON function tools only');
    }
    if (typeof tool.name !== 'string' || !tool.name) throw new TypeError('Tool name is required');
    const parameters = tool.parameters?.jsonSchema ?? tool.parameters;
    if (!parameters || typeof parameters !== 'object') throw new TypeError('Tool schema is required');
    return { type: 'function', function: {
      name: tool.name, description: tool.description ?? '', parameters,
    } };
  });
}

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  // Consumers read several promises after fullStream; reject all without unhandled rejections.
  promise.catch(() => {});
  return { promise, resolve, reject };
}

function abortError(reason) {
  return reason instanceof Error ? reason : new DOMException('Model stream was canceled', 'AbortError');
}

/** SSE events can cross UTF-8 chunks and use LF, CRLF, or CR line endings. */
async function* readSse(body) {
  if (!body) throw new ModelRequestError('Model response has no body');
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let pending = '', data = [];
  function accept(line) {
    if (line === '') {
      const event = data.length ? data.join('\n') : undefined;
      data = [];
      return event;
    }
    if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''));
    return undefined;
  }
  try {
    while (true) {
      const { value, done } = await reader.read();
      pending += done ? decoder.decode() : decoder.decode(value, { stream: true });
      let match;
      while ((match = /\r\n|\r|\n/.exec(pending))) {
        if (!done && match[0] === '\r' && match.index === pending.length - 1) break;
        const line = pending.slice(0, match.index);
        pending = pending.slice(match.index + match[0].length);
        const event = accept(line);
        if (event !== undefined) yield event;
      }
      if (done) {
        if (pending) accept(pending);
        const event = accept('');
        if (event !== undefined) yield event;
        break;
      }
    }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

function endpointFor(baseUrl) {
  const url = new URL(baseUrl);
  if (!['http:', 'https:'].includes(url.protocol)) throw new TypeError('baseUrl must use HTTP or HTTPS');
  url.pathname = url.pathname.replace(/\/+$/, '');
  if (!url.pathname.endsWith('/chat/completions')) url.pathname += '/chat/completions';
  return url.href;
}

function usageValues(raw = {}, contextWindowTokens = 0) {
  const count = value => Number.isFinite(value) && value >= 0 ? value : 0;
  const inputTokens = count(raw.prompt_tokens), outputTokens = count(raw.completion_tokens);
  return {
    usage: { promptTokens: inputTokens, completionTokens: outputTokens,
      totalTokens: count(raw.total_tokens ?? inputTokens + outputTokens) },
    extendedUsage: { inputTokens, outputTokens,
      cacheReadTokens: count(raw.prompt_cache_hit_tokens ?? raw.prompt_tokens_details?.cached_tokens),
      cacheWriteTokens: count(raw.cache_creation_input_tokens), maxTokens: count(contextWindowTokens) },
  };
}

export function createModelSession({ baseUrl, apiKey, model, onRequestId,
  fetchImpl = globalThis.fetch, headers = {}, requestOptions = {}, contextWindowTokens = 0,
  summaryThresholdTokens = 0, mapError = error => error, onUsage = async () => {}, selectRequest } = {}) {
  if (typeof model !== 'string' || !model.trim() || model !== model.trim() || model.length > 256 || /[\r\n\0]/.test(model)) {
    throw new TypeError('model must be an explicitly selected, nonempty model ID');
  }
  if (typeof fetchImpl !== 'function') throw new TypeError('fetchImpl must be a function');
  if (typeof mapError !== 'function') throw new TypeError('mapError must be a function');
  if (!Number.isSafeInteger(contextWindowTokens) || contextWindowTokens < 0) {
    throw new TypeError('contextWindowTokens must be a nonnegative integer');
  }
  const endpoint = endpointFor(baseUrl);
  let resolvedModelId;
  let selectedContext = { contextWindowTokens, summaryThresholdTokens };
  function providerError(payload, status, responseHeaders) {
    const error = payload?.error ?? payload;
    let message = typeof error?.message === 'string' ? error.message : `Model request failed${status ? ` (HTTP ${status})` : ''}`;
    if (apiKey) message = message.split(apiKey).join('[redacted]');
    const reportedStatus = error?.status ?? error?.status_code;
    return new ModelRequestError(message, {
      status: status ?? (Number.isInteger(reportedStatus) && reportedStatus >= 400 && reportedStatus <= 599
        ? reportedStatus : undefined),
      code: typeof error?.code === 'string' || typeof error?.code === 'number' ? error.code : undefined,
      retryAfterMs: retryAfterMs(responseHeaders),
    });
  }

  class Executor {
    constructor(initialMessages, trackModel) {
      this.messages = initialMessages ? [...(Array.isArray(initialMessages) ? initialMessages : [initialMessages])] : [];
      this.trackModel = trackModel;
    }
    appendMessages(value) { this.messages.push(...(Array.isArray(value) ? value : [value])); return this; }
    getState() { return [...this.messages]; }
    getMessages() { return [...this.messages]; }
    clearMessages() { this.messages = []; }
    stream(ctx, invocationId, tools, options = {}) {
      const slots = Object.fromEntries(['response', 'usage', 'extendedUsage', 'providerMetadata', 'invocationId'].map(key => [key, deferred()]));
      const controller = new AbortController();
      const signal = ctx?.signal;
      let settled = false;
      const fail = error => {
        if (settled) return;
        settled = true;
        Object.values(slots).forEach(slot => slot.reject(error));
      };
      const cancel = () => {
        const error = abortError(signal?.reason);
        controller.abort(error);
        fail(error);
      };
      if (signal?.aborted) cancel();
      else signal?.addEventListener('abort', cancel, { once: true });
      const messages = this.getMessages();
      const trackModel = this.trackModel;
      async function* produce() {
        let notified = false;
        let recordedUsage, reportedModel = model, reportedId, selectedEffort;
        const notifyRequest = id => {
          if (!notified && id) {
            notified = true;
            try { onRequestId?.(id); } catch { /* Observers do not control model execution. */ }
          }
        };
        try {
          controller.signal.throwIfAborted();
          const functions = convertTools(tools);
          const selected = await selectRequest?.({ messages, signal: controller.signal });
          const requestContext = { contextWindowTokens: selected?.contextWindowTokens ?? contextWindowTokens,
            summaryThresholdTokens: selected?.summaryThresholdTokens ?? summaryThresholdTokens };
          if (trackModel) selectedContext = requestContext;
          const selectedModel = selected?.model ?? model;
          reportedModel = selectedModel; selectedEffort = selected?.effort;
          const body = { ...requestOptions, ...selected?.requestOptions, model: selectedModel, messages: convertMessages(messages), stream: true,
            stream_options: { ...requestOptions.stream_options, include_usage: true },
            ...(functions.length ? { tools: functions } : {}),
            ...(options.maxTokens !== undefined ? { max_tokens: options.maxTokens } : {}) };
          // A caller cannot replace the original Harness tool surface through requestOptions.
          if (!functions.length) delete body.tools;
          const requestHeaders = new Headers(headers);
          requestHeaders.set('content-type', 'application/json');
          requestHeaders.set('accept', 'text/event-stream');
          if (apiKey) requestHeaders.set('authorization', `Bearer ${apiKey}`);
          const http = await fetchImpl(endpoint, { method: 'POST', headers: requestHeaders,
            body: JSON.stringify(body), signal: controller.signal });
          if (!http.ok) {
            let payload;
            try { payload = await http.json(); } catch { payload = undefined; }
            throw providerError(payload, http.status, http.headers);
          }
          notifyRequest(http.headers.get('x-request-id') ?? http.headers.get('request-id'));
          let id, responseModel = selectedModel, created, text = '', reasoning = '', rawUsage = {};
          let finishReason, receivedChoice = false, receivedDone = false;
          const toolCalls = new Map();
          for await (const data of readSse(http.body)) {
            controller.signal.throwIfAborted();
            if (data.trim() === '[DONE]') { receivedDone = true; break; }
            let chunk;
            try { chunk = JSON.parse(data); }
            catch (cause) { throw new ModelRequestError('Invalid JSON in model SSE event', { cause }); }
            if (chunk.error) throw providerError(chunk, undefined, http.headers);
            if (chunk.id) { id = chunk.id; reportedId = id; notifyRequest(id); }
            if (chunk.model) { responseModel = chunk.model; reportedModel = responseModel; }
            if (Number.isFinite(chunk.created)) created = chunk.created;
            if (chunk.usage) { rawUsage = { ...rawUsage, ...chunk.usage }; recordedUsage = rawUsage; }
            const choice = chunk.choices?.find(item => (item.index ?? 0) === 0);
            if (!choice) continue;
            receivedChoice = true;
            if (choice.finish_reason) finishReason = choice.finish_reason;
            const delta = choice.delta ?? {};
            if (typeof delta.reasoning_content === 'string' && delta.reasoning_content) {
              reasoning += delta.reasoning_content;
              yield { type: 'reasoning', textDelta: delta.reasoning_content };
            }
            if (typeof delta.content === 'string' && delta.content) {
              text += delta.content;
              yield { type: 'text-delta', textDelta: delta.content };
            }
            for (const part of delta.tool_calls ?? []) {
              const index = part.index ?? 0;
              const call = toolCalls.get(index) ?? { id: '', name: '', arguments: '' };
              if (part.id) call.id += part.id;
              if (part.function?.name) call.name += part.function.name;
              if (part.function?.arguments) call.arguments += part.function.arguments;
              toolCalls.set(index, call);
            }
          }
          controller.signal.throwIfAborted();
          if (!receivedChoice || (!receivedDone && !finishReason)) {
            throw new ModelRequestError('Model SSE stream ended before a completion marker');
          }
          if (finishReason === 'length' || finishReason === 'content_filter') {
            throw new ModelRequestError(`Model response stopped with ${finishReason}`, { code: finishReason });
          }
          const content = [];
          if (reasoning) content.push({ type: 'reasoning', text: reasoning });
          if (text) content.push({ type: 'text', text });
          const calls = [...toolCalls.entries()].sort(([a], [b]) => a - b).map(([, call]) => {
            if (!call.id || !call.name) throw new ModelRequestError('Incomplete model tool call identity');
            let args;
            try { args = JSON.parse(call.arguments || '{}'); }
            catch (cause) { throw new ModelRequestError(`Invalid tool arguments for ${call.name}`, { cause }); }
            return { type: 'tool-call', toolCallId: call.id, toolName: call.name, args };
          });
          // Original Harness consumes one argument stream at a time; serialize parallel calls.
          for (const call of calls) {
            const { toolCallId, toolName, args } = call;
            yield { type: 'tool-call-streaming-start', toolCallId, toolName };
            yield { type: 'tool-call-delta', toolCallId, toolName, argsTextDelta: JSON.stringify(args) };
            yield call;
            content.push(call);
          }
          const responseId = id ?? randomUUID();
          notifyRequest(responseId);
          const timestamp = created === undefined ? new Date() : new Date(created * 1000);
          // Harness interprets maxTokens as context capacity, not the output token limit.
          const values = usageValues(rawUsage, requestContext.contextWindowTokens);
          if (trackModel) resolvedModelId = responseModel;
          slots.response.resolve({ id: responseId, timestamp, modelId: responseModel,
            messages: [{ id: responseId, role: 'assistant', content }] });
          slots.usage.resolve(values.usage);
          slots.extendedUsage.resolve(values.extendedUsage);
          slots.providerMetadata.resolve(undefined);
          slots.invocationId.resolve(invocationId ?? responseId);
          settled = true;
          yield { type: 'finish', finishReason: calls.length ? 'tool-calls' : (finishReason ?? 'stop'),
            usage: values.usage, response: { id: responseId, timestamp, modelId: responseModel } };
        } catch (error) {
          const mapped = mapError(error);
          fail(mapped);
          throw mapped;
        } finally {
          if (recordedUsage) {
            try { await onUsage({ raw: recordedUsage, model: reportedModel, requestId: reportedId, effort: selectedEffort }); }
            catch (error) { console.error(`[usage] ${error.message}`); }
          }
          signal?.removeEventListener('abort', cancel);
          if (!settled) fail(abortError());
          controller.abort();
        }
      }
      const iterator = produce();
      const fullStream = {
        [Symbol.asyncIterator]() { return this; },
        next: value => iterator.next(value),
        return: value => { cancel(); signal?.removeEventListener('abort', cancel); return iterator.return(value); },
        throw: error => {
          fail(error); controller.abort(error); signal?.removeEventListener('abort', cancel);
          return iterator.throw(error);
        },
      };
      return { fullStream, ...Object.fromEntries(Object.entries(slots).map(([key, slot]) => [key, slot.promise])) };
    }
  }
  return {
    getModelId: () => model,
    getResolvedModelId: () => resolvedModelId,
    getEarlyCompaction: () => undefined,
    getLocalContextPolicy: () => ({ ...selectedContext }),
    getExecutor: state => new Executor(state, true),
    getExecutorWithoutResolvedModelTracking: state => new Executor(state, false),
  };
}
