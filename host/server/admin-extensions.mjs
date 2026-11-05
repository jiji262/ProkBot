import { jsonBody, sendJson, HttpError } from './security.mjs';
import { pluginAdmin } from './plugins-api.mjs';
import { webhookAdmin } from './webhooks-api.mjs';
import { sharingAdmin } from './sharing-api.mjs';
import { federationAdmin } from './federation-api.mjs';
import { mediaAdmin } from './media-api.mjs';
import { promptAdmin } from './prompt-api.mjs';

/** Called after the common admin authentication and mutation-origin checks. */
export async function adminExtensions(request, response, path, { harness, skills, executionNode, plugins, webhooks, verifyAgent, sharing, federation, mediaSettings, webSettings, webServices, prompts }) {
  const method = request.method;
  if (await pluginAdmin(request, response, path, plugins)) return true;
  if (await webhookAdmin(request, response, path, webhooks, verifyAgent)) return true;
  if (await sharingAdmin(request, response, path, sharing)) return true;
  if (await federationAdmin(request, response, path, federation)) return true;
  if (await mediaAdmin(request, response, path, { mediaSettings, webSettings, webServices })) return true;
  if (await promptAdmin(request, response, path, prompts)) return true;
  if (path === '/admin/api/execution') {
    if (method === 'GET') { sendJson(response, 200, executionNode.publicConfig()); return true; }
    if (method === 'PUT') { sendJson(response, 200, await executionNode.save(await jsonBody(request))); return true; }
  }
  if (path === '/admin/api/execution/test' && method === 'POST') {
    sendJson(response, 200, await executionNode.test(await jsonBody(request))); return true;
  }
  if (path === '/admin/api/harness') {
    if (method === 'GET') { sendJson(response, 200, harness.current()); return true; }
    if (method === 'PUT') { sendJson(response, 200, await harness.save(await jsonBody(request))); return true; }
  }
  if (!path.startsWith('/admin/api/skills')) return false;
  const match = /^\/admin\/api\/skills(?:\/([a-z][a-z0-9-]{0,63}))?$/.exec(path);
  if (!match) throw new HttpError(404, 'Skill not found');
  const id = match[1];
  let result;
  if (method === 'GET') result = id ? skills.get(id, new URL(request.url, 'http://local').searchParams.get('version') || undefined) : skills.list();
  else if (method === 'POST' && !id) result = await skills.publish(await jsonBody(request, 15 * 1024 * 1024));
  else if (method === 'PATCH' && id) result = await skills.update(id, await jsonBody(request));
  else if (method === 'DELETE' && id) result = await skills.remove(id);
  else throw new HttpError(405, 'Method not allowed');
  sendJson(response, method === 'POST' ? 201 : 200, result); return true;
}
