import { taskInternal } from './federation-tasks.mjs';
import { check, jsonBody, sendJson } from './security.mjs';

export async function federationAdmin(request, response, path, federation) {
  if (!path.startsWith('/admin/api/federation')) return false;
  const method = request.method; let result;
  if (path === '/admin/api/federation' && method === 'GET') result = federation.publicConfig();
  else if (path === '/admin/api/federation' && method === 'PUT') result = await federation.save(await jsonBody(request));
  else if (path === '/admin/api/federation/invitation' && method === 'POST') result = await federation.createInvitation(await jsonBody(request));
  else if (path === '/admin/api/federation/accept' && method === 'POST') result = await federation.acceptInvitation(await jsonBody(request));
  else {
    const peer = /^\/admin\/api\/federation\/peers\/([a-f0-9]{64})(\/sync)?$/.exec(path);
    check(peer, 404, 'Host not paired');
    if (method === 'PUT' && !peer[2]) result = await federation.updatePeer(peer[1], await jsonBody(request));
    else if (method === 'POST' && peer[2]) { await federation.syncPeer(peer[1]); result = federation.publicConfig(); }
    else check(false, 405, 'Method not allowed');
  }
  sendJson(response, 200, result); return true;
}

export async function federationInternal(federation, method, input) {
  if (method === 'snapshot') return federation.publicConfig();
  if (method === 'send') return federation.send(input);
  if (method === 'claim') return federation.claim(input.worker);
  if (method === 'finish') return federation.finish(input);
  return taskInternal(federation, method, input);
}
