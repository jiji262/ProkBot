import { check } from './security.mjs';

/** The Host owns credentials; the existing execution computer owns MCP processes. */
export async function openPluginClient(hostCall, pkg, configuration, authorization = async () => ({})) {
  check(typeof hostCall === 'function', 409, 'Execution computer is unavailable');
  let id, stamp, closed = false, operations = Promise.resolve();
  const request = body => hostCall('localApplicationRpc', body);
  const serialized = task => { const next = operations.catch(() => {}).then(task); operations = next; return next; };
  async function ensure() {
    check(!closed, 410, 'Application session has ended');
    const headers = await authorization(), next = JSON.stringify(headers);
    if (id && stamp === next) return;
    const previous = id;
    ({ id } = await request({ action: 'open', package: pkg, configuration, authorization: headers }));
    stamp = next;
    if (previous) await request({ action: 'close', id: previous }).catch(() => {});
  }
  const client = {
    listTools() { return serialized(async () => { await ensure();
      try { return await request({ action: 'tools', id }); }
      catch (error) { if (error.status !== 404) throw error; id = undefined; await ensure(); return request({ action: 'tools', id }); }
    }); },
    callTool(params) { return serialized(async () => { await ensure(); return request({ action: 'call', id, name: params.name, arguments: params.arguments }); }); },
    async close() { if (closed) return; closed = true; await operations.catch(() => {});
      if (id) await request({ action: 'close', id }).catch(() => {}); client.onclose?.(); },
  };
  return client;
}
