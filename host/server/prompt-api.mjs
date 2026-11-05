import { check, jsonBody, sendJson } from './security.mjs';

/** Call after admin authentication and origin checks. */
export async function promptAdmin(request, response, path, prompts) {
  if (!path.startsWith('/admin/api/prompts')) return false;
  const match = /^\/admin\/api\/prompts(?:\/([A-Za-z]+-[a-f0-9]{24}))?$/.exec(path); check(match, 404, 'Prompt not found');
  const id = match[1]; let result;
  if (request.method === 'GET') result = id ? await prompts.get(id) : await prompts.list();
  else if (request.method === 'PUT' && id) result = await prompts.save(id, await jsonBody(request, 250000));
  else check(false, 405, 'Method not allowed');
  sendJson(response, 200, result); return true;
}
