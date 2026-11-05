import { jsonBody, sendJson, HttpError } from './security.mjs';
export async function webhookAdmin(request, response, path, hooks, verifyAgent) {
  if (!path.startsWith('/admin/api/webhooks')) return false;
  const method = request.method;
  if (path === '/admin/api/webhooks/events' && method === 'GET') { sendJson(response, 200, hooks.events()); return true; }
  const match = /^\/admin\/api\/webhooks(?:\/([a-f0-9-]{36})(?:\/(rotate))?)?$/.exec(path);
  if (!match) throw new HttpError(404, 'Webhook not found');
  const [, id, action] = match; let result;
  if (!id && method === 'GET') result = hooks.list();
  else if (!action && ((!id && method === 'POST') || (id && method === 'PUT'))) {
    const input = await jsonBody(request); await verifyAgent(input.agentId); result = await hooks.save(input, id);
  } else if (id && action === 'rotate' && method === 'POST') result = await hooks.rotate(id);
  else if (id && !action && method === 'DELETE') result = await hooks.remove(id);
  else throw new HttpError(405, 'Method not allowed');
  sendJson(response, 200, result); return true;
}
