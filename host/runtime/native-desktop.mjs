import { readFile } from 'node:fs/promises';

/** Small adapter between paired desktop channels and the original Host grants. */
export async function createNativeDesktop({ permission, enabled = () => true, request, base = process.env.GROKBOT_NATIVE_DESKTOP_URL } = {}) {
  if (!request) {
    if (!base) return { list: async () => [], call: async () => { throw new Error('Native desktop unavailable'); } };
    const url = new URL(base);
    if (!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) || url.username || url.password || url.search || url.hash)
      throw new Error('Native desktop service requires an authenticated loopback endpoint');
    const token = (await readFile(process.env.GROKBOT_INTERNAL_HOST_TOKEN_FILE, 'utf8')).trim();
    request = async (method, body, signal) => {
      const response = await fetch(`${base.replace(/\/$/, '')}/${method}`, { method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify(body), redirect: 'error',
        signal: AbortSignal.any([AbortSignal.timeout(method === 'call' ? 370000 : 15000), ...(signal ? [signal] : [])]),
      });
      if (!response.ok) throw new Error(`Native desktop service HTTP ${response.status}`);
      return response.json();
    };
  }
  return {
    list: async () => enabled() ? (await request('tools', {})).computers : [],
    async call({ scope, machineId, toolId, arguments: args = {}, signal }) {
      if (!enabled()) throw new Error('Mac computer control is disabled');
      const grants = typeof permission === 'function' ? permission() : permission;
      if (!scope?.agentId || !scope.toolCallId || !grants) throw new Error('Computer calls require an agent tool scope');
      const epoch = scope.directionEpoch ?? grants.directionEpoch(scope.agentId);
      if (epoch !== grants.directionEpoch(scope.agentId)) throw new Error('Computer task has been superseded');
      const blocked = grants.blockedReason?.(machineId);
      if (blocked) return { isError: true, content: [{ type: 'text', text: blocked }] };
      const body = { machineId, conversationId: scope.agentId, toolId, arguments: args };
      let outcome = await request('call', body, signal);
      if (outcome.status === 'ask') {
        const app = outcome.app;
        if (typeof app?.bundleId !== 'string' || !app.bundleId) throw new Error('Invalid app approval target');
        if (epoch !== grants.directionEpoch(scope.agentId)) throw new Error('Computer task has been superseded');
        // Original resource grants survive tool completion and retire on the next direction.
        const resourcePath = `native-app:${JSON.stringify([scope.agentId, machineId, epoch, app.bundleId])}`;
        const decision = await grants.authorize(scope, { machineId, action: 'use-app', target: app.bundleId,
          resourcePath, outlivesScope: true, signal });
        if (!decision.allowed) return { isError: true, content: [{ type: 'text', text: decision.reason || 'App access declined' }] };
        signal?.throwIfAborted();
        if (epoch !== grants.directionEpoch(scope.agentId)) throw new Error('Computer task has been superseded');
        outcome = await request('call', { ...body, approvalId: decision.approvalId, authorizedApp: app.bundleId }, signal);
      }
      if (outcome.status === 'done') {
        const result = JSON.parse(outcome.outputJson);
        if (!result || !Array.isArray(result.content)) throw new Error('Computer helper returned invalid MCP output');
        return result;
      }
      return { isError: true, content: [{ type: 'text', text: outcome.status === 'needs_permission'
        ? 'Allow the computer helper in macOS Accessibility and Screen Recording settings.'
        : outcome.status === 'ask' ? 'Approve this application on the target Mac.' : outcome.error || 'Computer action failed' }] };
    },
  };
}
