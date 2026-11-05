import { jsonBody, sendJson } from './security.mjs';

/** Invoke only after the shared admin session and mutation-origin checks. */
export async function mediaAdmin(request, response, path, { mediaSettings, webSettings, webServices }) {
  const method = request.method;
  if (path === '/admin/api/media') {
    if (method === 'GET') { sendJson(response, 200, mediaSettings.publicConfig()); return true; }
    if (method === 'PUT') { sendJson(response, 200, await mediaSettings.save(await jsonBody(request, 4 * 1024 * 1024))); return true; }
  }
  const catalog = /^\/admin\/api\/media\/catalog\/([A-Za-z0-9_.-]+)$/.exec(path);
  if (catalog && method === 'GET') {
    sendJson(response, 200, await mediaSettings.catalog(catalog[1])); return true;
  }
  if (path === '/admin/api/web-services') {
    if (method === 'GET') { sendJson(response, 200, webSettings.publicConfig()); return true; }
    if (method === 'PUT') { sendJson(response, 200, await webSettings.save(await jsonBody(request))); return true; }
  }
  if (path === '/admin/api/web-services/test' && method === 'POST') {
    const body = await jsonBody(request);
    const kind = body.kind === 'fetch' ? 'fetch' : 'search';
    const result = await webServices.invoke(kind, body.value, { modelId: body.model });
    sendJson(response, 200, kind === 'fetch' ? { ok: true, characters: result.content.length }
      : { ok: true, sources: result.documents.length }); return true;
  }
  return false;
}
