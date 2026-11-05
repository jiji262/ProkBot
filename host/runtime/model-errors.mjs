import { ModelRequestError } from './model-session.mjs';

const CONFIG_CODES = new Set(['invalid_api_key', 'authentication_error']);
const TERMINAL_CODES = new Set([
  'invalid_request_error', 'model_not_found', 'permission_denied', 'insufficient_quota',
  'content_filter', 'length',
]);
const TERMINAL_STATUSES = new Set([400, 402, 403, 404, 405, 413, 415, 422]);
const RATE_LIMIT_CODES = new Set(['rate_limit_error', 'rate_limit_exceeded']);

/** Bridge local provider failures to the exact error constructors used by this Runner. */
export function createHarnessModelErrorMapper(library) {
  const { ConnectError, Code, ActionRequiredError, NonRetriableError, InputTokenLimitError } = library;
  if (![ConnectError, ActionRequiredError, NonRetriableError].every(value => typeof value === 'function')
      || ![Code?.ResourceExhausted, Code?.Unavailable, Code?.Internal].every(Number.isInteger)) {
    throw new TypeError('The original Harness error constructors must be exported by the loaded library');
  }
  return error => {
    // Preserve cancellation/deadline identities, network causes, and original Harness errors.
    if (!(error instanceof ModelRequestError)) return error;
    const status = error.status;
    const code = typeof error.code === 'string' ? error.code : undefined;
    const options = { cause: error, displayInfo: { detail: error.message, isRetryable: false } };
    const inputLimit = ['context_length_exceeded', 'input_token_limit_exceeded', 'prompt_too_long'].includes(code) ||
      ([400, 413, 422].includes(status) && /(?:maximum context length|input token limit|prompt (?:is )?too long|context window.*exceed)/i.test(error.message));
    if (inputLimit && typeof InputTokenLimitError === 'function') {
      const mapped = new InputTokenLimitError(error.message); mapped.cause = error; return mapped;
    }
    if (status === 401 || CONFIG_CODES.has(code)) {
      // This is a local provider API key, so official-account login is not the remedy.
      return new ActionRequiredError(error.message, 'config', options);
    }
    if (TERMINAL_STATUSES.has(status) || TERMINAL_CODES.has(code)) {
      return new NonRetriableError(error.message, options);
    }
    const rateLimited = status === 429 || RATE_LIMIT_CODES.has(code);
    const unavailable = status === 503;
    if (rateLimited || unavailable || (status >= 500 && status <= 599 && error.retryAfterMs !== undefined)) {
      const metadata = new Headers();
      if (Number.isFinite(error.retryAfterMs) && error.retryAfterMs >= 0) {
        metadata.set('retry-after', String(error.retryAfterMs / 1000));
      }
      return new ConnectError(error.message, rateLimited ? Code.ResourceExhausted
        : unavailable ? Code.Unavailable : Code.Internal,
        metadata, undefined, error);
    }
    return error;
  };
}
