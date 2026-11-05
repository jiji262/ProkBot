import { join } from 'node:path';

/** Original app-scoped helper, permission policy, and MCP output are preserved. */
export async function createNativeComputer({ original, profile, decideLocalUse, enabled = () => true, helperPath }) {
  const helper = helperPath ?? original.findComputerHelper();
  if (!helper) return { tools: [], async call() { return { status: 'failed', error: 'Computer helper unavailable' }; }, close() {} };
  const computer = new original.ComputerUse({
    readGate: enabled, findHelper: async () => ({ kind: 'bundled', app: helper }),
    installDir: join(profile, 'computer-helper'),
  });
  const schemaSession = computer.sessionFor('grokbot-local-tool-catalog', { kind: 'bundled', app: helper });
  let tools;
  try {
    await schemaSession.ready;
    const result = await schemaSession.request('tools/list', {}).reply;
    if (result.kind !== 'result' || !Array.isArray(result.value?.tools)) throw new Error('Computer helper did not return its tool catalog');
    const announced = new Set(await computer.announcedTools());
    tools = result.value.tools.filter(tool => announced.has(tool.name));
  } finally { schemaSession.stop('Tool catalog loaded.'); }
  return {
    tools,
    call: (request, { signal, onProgress = () => {} }) => computer.call({
      conversationId: request.conversationId, toolId: request.toolId,
      inputJson: JSON.stringify(request.arguments ?? {}), approvalId: request.approvalId,
    }, {
      signal, onPermissionPending: () => onProgress('permission'),
      onPermissionGranted: () => onProgress('ready'), onStillQueued: () => onProgress('queued'),
      decideAppUse: bundleId => decideLocalUse({ approvalId: request.approvalId,
        serverAuthoritative: request.authorizedApp === bundleId,
        authorization: { kind: request.authorizedApp === bundleId ? 'approval' : 'none' },
        describes: { action: 'use-app', target: bundleId, recipient: bundleId } }),
    }),
    close: () => computer.close(),
  };
}
