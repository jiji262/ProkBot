import { jsonBody, sendJson, check } from './security.mjs';

export async function pluginAdmin(request, response, path, plugins) {
  if (!path.startsWith('/admin/api/plugins')) return false;
  const method = request.method; let result;
  if (path === '/admin/api/plugins/preview' && method === 'POST') {
    result = plugins.preview(await jsonBody(request, 20 * 1024 * 1024));
  } else {
    const match = /^\/admin\/api\/plugins(?:\/([a-z][a-z0-9-]{0,63})(\/configuration)?)?$/.exec(path);
    check(match, 404, 'Plugin not found'); const id = match[1];
    if (method === 'GET') result = id ? plugins.get(id) : plugins.list();
    else if (method === 'POST' && !id) result = await plugins.publish(await jsonBody(request, 20 * 1024 * 1024));
    else if (method === 'PATCH' && id && !match[2]) result = await plugins.update(id, await jsonBody(request));
    else if (method === 'PUT' && id && match[2]) result = await plugins.configure(id, await jsonBody(request));
    else if (method === 'DELETE' && id) result = await plugins.remove(id);
    else check(false, 405, 'Method not allowed');
  }
  sendJson(response, 200, result); return true;
}
