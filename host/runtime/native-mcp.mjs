import { createHash } from 'node:crypto';
import { createNativeDesktop } from './native-desktop.mjs';

const providerFor = machineId => `local_mac_${createHash('sha256').update(machineId).digest('hex').slice(0, 12)}`;
const values = args => Object.fromEntries(Object.entries(args ?? {}).map(([key, value]) =>
  [key, typeof value?.toJson === 'function' ? value.toJson() : value]));
const asMcpResult = (library, result) => library.McpResult.fromJson({ success: {
  isError: Boolean(result.isError), content: (result.content ?? []).map(item => item.type === 'text'
    ? { text: { text: item.text } } : item.type === 'image'
      ? { image: { data: item.data, mimeType: item.mimeType } } : { text: { text: JSON.stringify(item) } }),
} });

/** Use original dynamic tool discovery, result/image persistence and permission cards. */
export async function decorateNativeMcp(original, { library, permission, enabled, request, base }) {
  const native = await createNativeDesktop({ permission, enabled, request, base });
  let computers = [];
  async function discover() {
    computers = await native.list().catch(() => []);
    return computers.flatMap(computer => computer.tools.map(tool => ({
      providerIdentifier: providerFor(computer.machineId),
      name: `${providerFor(computer.machineId)}-${tool.name}`, toolName: tool.name,
      description: `${computer.label}: ${tool.description}`, inputSchema: tool.inputSchema,
    })));
  }
  return {
    ...original,
    getTools: async (...args) => [...await original.getTools(...args), ...await discover()],
    resolveToolTransport: async identifier => identifier.startsWith('local_mac_') ? 'http' : original.resolveToolTransport(identifier),
    createStateExecutor(...args) {
      const executor = original.createStateExecutor(...args);
      return { async execute(...callArgs) {
        const result = await executor.execute(...callArgs), json = result.toJson();
        const tools = await discover();
        if (!json.success) return result;
        const servers = computers.map(computer => ({ serverIdentifier: providerFor(computer.machineId),
          serverName: computer.label, status: 'connected', tools: tools.filter(tool => tool.providerIdentifier === providerFor(computer.machineId)) }));
        json.success.servers = [...(json.success.servers ?? []), ...servers];
        return result.constructor.fromJson(json);
      } };
    },
    createExecutor(...args) {
      const executor = original.createExecutor(...args), identity = args[2];
      const nativeExecutor = new executor.constructor({ async executeTool(ctx, call) {
        const computer = computers.find(value => providerFor(value.machineId) === call.providerIdentifier);
        const grants = typeof permission === 'function' ? permission() : permission;
        const scope = { agentId: identity?.agentId, toolCallId: call.toolCallId,
          directionEpoch: library.sandTurnDirectionEpochKey
            ? ctx.get(library.sandTurnDirectionEpochKey) ?? grants.directionEpoch(identity?.agentId)
            : grants.directionEpoch(identity?.agentId) };
        try {
          if (!computer || !computer.tools.some(tool => tool.name === call.toolName)) throw new Error('Computer tool is unavailable');
          return asMcpResult(library, await native.call({ scope, machineId: computer.machineId,
            toolId: call.toolName, arguments: values(call.args), signal: ctx.signal }));
        } finally { grants.completeScope(scope); }
      } }, ...args);
      return { execute: (ctx, call) => call.providerIdentifier.startsWith('local_mac_')
        ? nativeExecutor.execute(ctx, call) : executor.execute(ctx, call) };
    },
  };
}
