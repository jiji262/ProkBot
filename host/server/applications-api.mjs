import { jsonBody, sendJson, check } from './security.mjs';

export async function applicationsAdmin(request, response, path, applications, origin, actor) {
  const prefix = '/admin/api/apps';
  if (path !== prefix && !path.startsWith(prefix + '/')) return false;
  const method = request.method, { plugins, connectors } = applications;
  const parts = path.slice(prefix.length).split('/').filter(Boolean);
  check(parts.length <= 2, 404, 'Application route not found');
  const input = ['POST', 'PUT', 'PATCH'].includes(method) ? await jsonBody(request, 20 * 1024 * 1024) : {};
  let result;
  if (!parts.length && method === 'GET') result = { apps: applications.list(), redirectUri: new URL('/connectors/oauth/callback', origin).href };
  else if (parts[0] === 'preview' && parts.length === 1 && method === 'POST') result = plugins.preview(input);
  else if (parts[0] === 'import' && parts.length === 1 && method === 'POST') {
    await plugins.publish(input); result = applications.get(input.id);
  } else if (!parts.length && method === 'POST') { result = await connectors.store.save(input); }
  else {
    const [id, action] = parts, row = connectors.resolve(id);
    if (!action && method === 'GET') result = applications.get(id);
    else if (action === 'export' && method === 'GET') result = applications.export(id);
    else if (!action && method === 'PATCH') result = await applications.update(id, input);
    else if (action === 'configuration' && method === 'PUT') result = await plugins.configure(id, input);
    else if (!action && method === 'DELETE' && row.pluginId) result = await plugins.remove(id);
    else {
      check(!row.builtin || ['connect', 'authorize', 'test', 'disconnect'].includes(action), 400, 'Built-in application cannot be edited or deleted');
      result = await connectors.route('admin', method, '/admin/api/connectors/' + id + (action ? '/' + (action === 'connect' ? 'authorize' : action) : ''), input, origin, actor);
    }
  }
  sendJson(response, 200, result); return true;
}
