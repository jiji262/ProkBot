import { jsonBody, sendJson, check } from './security.mjs';

/** A Host with no fixed public URL resolves its own links against the paired endpoint. */
export function rewriteSharingUrls(value, origin) {
  if (Array.isArray(value)) return value.map(item => rewriteSharingUrls(item, origin));
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key,
    key === 'shareUrl' && item === '/admin?view=sharing' ? `${origin}${item}` : rewriteSharingUrls(item, origin)]));
}

function archive(input) {
  check(typeof input.zip === 'string' && input.zip.length <= 21 * 1024 * 1024, 413, 'ZIP exceeds size limit');
  const bytes = Buffer.from(input.zip, 'base64'); check(bytes.toString('base64') === input.zip, 400, 'Invalid ZIP encoding'); return bytes;
}

/** Caller applies the existing admin authentication, origin and CSRF checks. */
export async function sharingAdmin(request, response, path, sharing) {
  if (!path.startsWith('/admin/api/sharing')) return false;
  const method = request.method; let result;
  if (path === '/admin/api/sharing/preview' && method === 'POST') result = sharing.preview(archive(await jsonBody(request, 21 * 1024 * 1024)));
  else if (path === '/admin/api/sharing/import' && method === 'POST') {
    const input = await jsonBody(request, 21 * 1024 * 1024); result = await sharing.import(archive(input), input);
  } else if (path === '/admin/api/sharing/skills' && method === 'POST') {
    const { id } = await jsonBody(request), skill = sharing.skills.get(id);
    const source = skill.content; result = await sharing.createSkill({ workflowId: id,
      skill: { ...source, id }, dependencies: skill.source.startsWith('plugin:') ? [{ pluginId: skill.source.slice(7), name: skill.source.slice(7), tools: source.requiresTools }] : [] });
  } else {
    const match = /^\/admin\/api\/sharing(?:\/([A-Za-z0-9_-]{21})(?:\/(download|publish|unpublish))?)?$/.exec(path);
    check(match, 404, 'Shared package not found'); const [, id, action] = match;
    if (method === 'GET' && action === 'download') {
      const value = new URL(request.url, 'http://local').searchParams.get('version');
      const file = sharing.download(id, value ? Number(value) : undefined);
      response.writeHead(200, { 'content-type': 'application/zip', 'content-length': file.bytes.length,
        'content-disposition': `attachment; filename="${file.name}"`, 'cache-control': 'no-store' }); response.end(file.bytes); return true;
    }
    if (method === 'GET') result = id ? sharing.details(id, Number(new URL(request.url, 'http://local').searchParams.get('version')) || undefined) : sharing.list();
    else if (method === 'POST' && action === 'publish') result = await sharing.publish({ ...await jsonBody(request), shareId: id });
    else if (method === 'POST' && action === 'unpublish') result = await sharing.unpublish(id);
    else if (method === 'DELETE' && id && !action) result = await sharing.remove(id);
    else check(false, 405, 'Method not allowed');
  }
  sendJson(response, 200, result); return true;
}
