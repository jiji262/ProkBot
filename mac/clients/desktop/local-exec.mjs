import { grokText } from './i18n.mjs';
import { createRequire } from 'node:module';
import { readFile, writeFile, rename, mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createNativeComputer } from './native-computer.mjs';
import { startNativeProvider } from './native-provider.mjs';
import { createCodexBridge } from './codex-bridge.mjs';

export async function createLocalExec({ payload, profile, config, command, window }) {
  const original = createRequire(import.meta.url)(path.join(payload, 'local-exec-daemon/main.cjs'));
  const directory = path.join(profile, 'local-exec');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const root = path.join(directory, 'workspace');
  await mkdir(root, { recursive: true, mode: 0o700 });
  const settingsPath = path.join(directory, 'settings.json');
  const approvalsPath = path.join(directory, 'approvals.json');
  const retirementsPath = path.join(directory, 'retirements.json');
  const standingGrantsPath = path.join(directory, 'standing-grants.json');
  let native, codex, closed = false;
  const machineId = `mac-${config.deviceId}`;
  let permission = 'ask', writes = Promise.resolve();
  try { const value = JSON.parse(await readFile(settingsPath, 'utf8')); if (['ask', 'never', 'always'].includes(value.permission)) permission = value.permission; } catch {}
  const serialize = task => { writes = writes.catch(() => {}).then(task); return writes; };
  const save = async (filename, value) => { await writeFile(`${filename}.tmp`, JSON.stringify(value), { mode: 0o600 }); await rename(`${filename}.tmp`, filename); };
  const provider = new original.Provider({ root, computerId: machineId, computerLabel: os.hostname(),
    resolveConnection: async () => ({ baseUrl: config.server, token: config.token }),
    isSupervised: async () => !window.isDestroyed(),
    messages: { available: () => false },
    isLocalUseBlocked: args => original.isLocalUseBlocked({ ...args, permission, messagesEnabled: false,
      approvalsPath, retirementsPath, standingGrantsPath }),
    onApprovalRetired: id => serialize(() => original.retireApproval(id, approvalsPath, retirementsPath)),
  });
  const publishPermission = async (value = permission) => {
    // The original Host has separate single-machine and per-machine stores.
    await command('setHostSettings', { localToolPermission: value });
    await command('setHostSettings', { localToolPermission: value, localToolPermissionMachineId: machineId });
  };
  const streamRequests = provider.streamRequests.bind(provider);
  provider.streamRequests = async (...args) => { await publishPermission(); return streamRequests(...args); };
  provider.start();
  // Discovery does not delay the workspace. The shipped helper is started only
  // to read its own schemas; each GUI session retains its original app policy.
  const decideLocalUse = args => original.decideLocalUse({ ...args, permission, messagesEnabled: false,
    approvalsPath, retirementsPath, standingGrantsPath });
  void Promise.allSettled([
    createNativeComputer({ original, profile, enabled: () => permission !== 'never', decideLocalUse }),
    createCodexBridge({ profile, config, root, enabled: () => permission !== 'never', decideLocalUse }),
  ]).then(results => {
    const providers = results.filter(result => result.status === 'fulfilled').map(result => result.value);
    if (results[1].status === 'fulfilled') codex = results[1].value;
    const computer = { tools: providers.flatMap(value => value.tools),
      call: (request, options) => providers.find(value => value.tools.some(tool => tool.name === request.toolId)).call(request, options),
      disconnected: () => codex?.stop(),
      close: () => providers.forEach(value => value.close()) };
    if (closed) return computer.close();
    native = startNativeProvider({ config, computer });
  }).catch(error => console.warn('[native-computer]', error.name));
  return {
    close: () => { closed = true; provider.close(); native?.close(); },
    handlers: {
      getLocalToolPermission: () => permission,
      setLocalToolPermission: async args => {
        if (!['ask', 'never', 'always'].includes(args.permission) || args.machineId && args.machineId !== machineId) throw new Error(grokText('无效的本机权限设置', 'Invalid local access permission'));
        await publishPermission(args.permission);
        permission = args.permission; await serialize(() => save(settingsPath, { permission }));
        if (permission === 'never') codex?.stop();
        return permission;
      },
      recordLocalToolApproval: args => serialize(async () => {
        if (args.machineId && args.machineId !== machineId) throw new Error(grokText('请在目标电脑确认审批。', 'Approve this request on the target computer.'));
        const record = original.parseApproval({ id: args.approvalId, action: args.action, target: args.target });
        if (!record) throw new Error(grokText('本机审批无效', 'Invalid local approval'));
        let entries = [];
        try { entries = JSON.parse(await readFile(approvalsPath, 'utf8')).approvals ?? []; } catch {}
        await save(approvalsPath, { approvals: [...entries.filter(item => item.id !== record.id), record].slice(-500) });
      }),
      clearLocalToolApprovals: () => serialize(async () => { await rm(approvalsPath, { force: true }); await rm(retirementsPath, { force: true }); }),
      getSandMachines: () => ({ machines: [{ machineId, name: os.hostname(), label: os.hostname(), platform: 'darwin',
        isCurrent: true, localToolPermission: permission, isOnline: Boolean(provider.providerId) }], currentMachineRemoved: false }),
      getLocalExecutionStatus: () => ({ connected: Boolean(provider.providerId), machineId, root, permission }),
    },
  };
}
