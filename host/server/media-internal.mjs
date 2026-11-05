import { bearer, check, equal, jsonBody, sendJson } from './security.mjs';

/** The admin process exclusively owns provider requests and the media-job ledger. */
export async function mediaInternal(request, response, path, { internalToken, mediaServices, webServices }) {
  const operations = ['/internal/media/generate', '/internal/media/analyze', '/internal/web-services/invoke'];
  if (!operations.includes(path)) return false;
  check(request.method === 'POST', 405, 'Method not allowed');
  check(request.headers.origin === undefined && internalToken && equal(bearer(request), internalToken), 401, 'Invalid internal credential');
  const body = await jsonBody(request, 96 * 1024 * 1024);
  check(body && typeof body === 'object' && !Array.isArray(body), 400, 'Invalid service request');
  const controller = new AbortController(), cancel = () => { if (!response.writableFinished) controller.abort(); };
  response.once('close', cancel);
  try {
    let result;
    if (path === '/internal/web-services/invoke') {
      check(body.modelId === undefined || typeof body.modelId === 'string' && body.modelId.length <= 200, 400, 'Invalid model ID');
      result = await webServices.invoke(body.kind, body.value, { modelId: body.modelId, signal: controller.signal });
    } else {
      check(body.input && typeof body.input === 'object' && !Array.isArray(body.input), 400, 'Invalid media input');
      if (path.endsWith('/analyze')) result = await mediaServices.analyze(body.kind, body.input, { signal: controller.signal });
      else {
        check(body.requestId === undefined || typeof body.requestId === 'string' && body.requestId.length <= 512, 400, 'Invalid request ID');
        const generated = await mediaServices.generate(body.kind, body.input, { requestId: body.requestId, jobId: body.jobId, signal: controller.signal });
        result = { jobId: generated.jobId, modelId: generated.modelId,
          outputs: generated.outputs.map(output => ({ base64: output.bytes.toString('base64'), mimeType: output.mimeType })) };
      }
    }
    sendJson(response, 200, result); return true;
  } finally { response.removeListener('close', cancel); }
}
