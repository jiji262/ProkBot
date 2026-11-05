import { createHash, randomUUID } from 'node:crypto';
import { validatePlugin, pluginDigest, validatePluginConfiguration, runnerDependencies } from '../server/plugin-package.mjs';
import { check } from '../server/security.mjs';

const quote = value => `'${String(value).replaceAll("'", "'\\''")}'`;
const root = '/home/box/.grokbot-apps';
const sdk = `${root}/sdk-${createHash('sha256').update(JSON.stringify(runnerDependencies)).digest('hex').slice(0, 16)}`;
const prepare = `import os,sys,json,base64
from pathlib import Path
p=json.loads(base64.b64decode(sys.argv[1])); root=Path('${root}')
for d in [root,Path(p['sdk']),Path(p['directory'])]:
 if d.is_symlink(): raise ValueError('application directory is a symlink')
 d.mkdir(parents=True,exist_ok=True)
 os.chmod(d,0o700)
for f in p['files']:
 dest=Path(p['directory'])/f['path']
 for d in list(dest.parents):
  if str(d).startswith(p['directory']) and d.is_symlink(): raise ValueError('application path is a symlink')
 dest.parent.mkdir(parents=True,exist_ok=True)
 if dest.is_symlink(): raise ValueError('application file is a symlink')
 dest.write_bytes(base64.b64decode(f['data']));os.chmod(dest,0o600)
link=Path(p['directory'])/'node_modules'
if not link.exists() and not link.is_symlink(): link.symlink_to(Path(p['sdk'])/'node_modules')
`;

/** Installed applications run through the existing Box MCP registry. */
export function createBoxApplications({ box, library, exec, updateRegistry }) {
  const sessions = new Map();
  let operations = Promise.resolve(), sdkReady = false;
  const serialize = task => { const next = operations.catch(() => {}).then(task); operations = next; return next; };
  async function shell(command) {
    const [ctx, cancel] = library.createContext().withCancel();
    const timer = setTimeout(() => cancel(new Error('Application setup timed out')), 100000);
    try {
      const accessor = await box.mcpResourceAccessor(ctx);
      const { shellExecutorResource, buildHostShellArgs } = library.getComputerRecoveryBindings();
      const result = await accessor.get(shellExecutorResource).execute(ctx, buildHostShellArgs({
        command, name: 'application-setup', workingDirectory: '/workspace', toolCallId: `app-setup-${randomUUID()}`,
      }));
      check(result.result?.case === 'success' && result.result.value.exitCode === 0, 502, 'Application setup on the execution computer failed');
      return result.result.value.stdout;
    } finally { clearTimeout(timer); cancel(); }
  }
  const configs = () => Object.fromEntries([...sessions.values()].map(s => [s.identifier, s.config]));
  async function open(input) {
    const pkg = validatePlugin(input.package);
    check(pkg.runtime.kind === 'node-stdio', 400, 'Application does not run code');
    const configuration = validatePluginConfiguration(pkg, input.configuration ?? {});
    const authorization = input.authorization ?? {};
    check(Object.entries(authorization).every(([k, v]) => /^[a-zA-Z0-9-]+$/.test(k) && typeof v === 'string' && !/[\r\n\0]/.test(v)), 400, 'Invalid application authorization');
    const id = randomUUID(), identifier = `app_${id.replaceAll('-', '')}`;
    const directory = `${root}/${pkg.id}-${pluginDigest(pkg).slice(0, 16)}`;
    const files = pkg.files.map(file => ({ path: file.path, data: Buffer.from(file.content, file.encoding).toString('base64') }));
    if (!files.some(file => file.path === 'package.json')) files.push({ path: 'package.json', data: Buffer.from('{"type":"module"}').toString('base64') });
    const payload = Buffer.from(JSON.stringify({ directory, sdk, files })).toString('base64');
    // Exec has bounded stdout and command frames; package bytes travel via its file upload port.
    const staging = `/tmp/grokbot-app-${id}.json`;
    await box.uploadFile(library.createContext(), undefined, staging, Buffer.from(payload));
    try { await shell(`python3 -c ${quote(prepare.replace("base64.b64decode(sys.argv[1])", "base64.b64decode(Path(sys.argv[1]).read_bytes())"))} ${quote(staging)}`); }
    finally { await shell(`rm -f ${quote(staging)}`).catch(() => {}); }
    if (!sdkReady) {
      const packages = Object.entries(runnerDependencies).map(([name, version]) => quote(`${name}@${version}`)).join(' ');
      await shell(`test -f ${quote(`${sdk}/node_modules/@modelcontextprotocol/sdk/package.json`)} || npm install --prefix ${quote(sdk)} --ignore-scripts --no-audit --no-fund --save-exact ${packages}`);
      sdkReady = true;
    }
    const config = { command: '/exec-daemon/node', args: [directory + '/' + pkg.runtime.entry],
      env: { ...configuration, GROKBOT_APP_AUTH_HEADERS: JSON.stringify(authorization) } };
    sessions.set(id, { identifier, config });
    try { await updateRegistry(configs()); return { id }; }
    catch (error) { sessions.delete(id); await updateRegistry(configs()).catch(() => {}); throw error; }
  }
  async function close(id) {
    if (!sessions.has(id)) return { ok: true };
    sessions.delete(id); await updateRegistry(configs()); return { ok: true };
  }
  async function rpc(input) {
    check(input && typeof input === 'object', 400, 'Invalid application request');
    if (input.action === 'read') {
      check(typeof input.path === 'string' && /^\/workspace\/.+\.json$/.test(input.path) && !input.path.split('/').includes('..'), 400, 'Use an application JSON file in /workspace');
      const bytes = await box.downloadFile(library.createContext(), undefined, input.path);
      check(bytes.length <= 20 * 1024 * 1024, 400, 'Application package is too large');
      return { package: JSON.parse(bytes.toString('utf8')) };
    }
    if (input.action === 'open') return serialize(() => open(input));
    if (input.action === 'close') return serialize(() => close(input.id));
    const session = sessions.get(input.id); check(session, 404, 'Application session has ended');
    if (input.action === 'tools') {
      const [server] = await exec.listTools([session.identifier]);
      check(server?.status === 'connected', 502, 'Application could not start');
      return { tools: server.tools.map(tool => ({ name: tool.toolName || tool.name, description: tool.description, inputSchema: tool.inputSchema })) };
    }
    check(input.action === 'call' && typeof input.name === 'string', 400, 'Invalid application operation');
    const result = (await exec.executeTool(library.createContext(), library.McpArgs.fromJson({
      name: `${session.identifier}-${input.name}`, toolName: input.name, serverIdentifier: session.identifier,
      providerIdentifier: session.identifier, toolCallId: randomUUID(), args: input.arguments ?? {}, skipApproval: true,
    }))).toJson();
    check(result.success, 502, 'Application execution failed');
    return { isError: result.success.isError ?? false, content: (result.success.content ?? []).map(item => item.text
      ? { type: 'text', text: item.text.text } : item.image ? { type: 'image', ...item.image } : { type: 'text', text: JSON.stringify(item) }) };
  }
  return { rpc, async close() { await operations.catch(() => {}); sessions.clear(); await updateRegistry({}); } };
}
