import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { readJson } from '../server/storage.mjs';
import { packagePath } from '../server/package-files.mjs';

const root = '/workspace/.grokbot-skills';
const quote = value => `'${String(value).replaceAll("'", "'\\''")}'`;
const checkFiles = `import sys,json,hashlib
from pathlib import Path
root=Path(sys.argv[1]); rows=json.loads(sys.argv[2]); missing=[]
if root.is_symlink(): raise ValueError('unexpected skills link')
root.mkdir(exist_ok=True)
for row in rows:
 p=root/row['path']
 for parent in reversed(p.parents):
  if parent==root or root in parent.parents:
   if parent.is_symlink(): raise ValueError('unexpected skills directory link')
   parent.mkdir(exist_ok=True)
 if p.is_symlink(): raise ValueError('unexpected skills file link')
 if not p.is_file() or hashlib.sha256(p.read_bytes()).hexdigest()!=row['sha256']: missing.append(row['path'])
print(json.dumps(missing))`;
const publishFile = `import sys,os,hashlib
from pathlib import Path
source=Path(sys.argv[1]);target=Path(sys.argv[2])
if source.is_symlink() or target.is_symlink() or any(p.is_symlink() for p in target.parents): raise ValueError('unexpected skills link')
if hashlib.sha256(source.read_bytes()).hexdigest()!=sys.argv[3]: raise ValueError('skill file checksum mismatch')
source.chmod(0o444);os.replace(source,target)`;
const owners = new WeakMap();

/** The original Read tool runs on the execution node, which need not share Host storage. */
export async function syncSkillFiles(options, library, data = process.env.GROKBOT_DATA_DIR) {
  const box = options.remoteBox;
  if (!data || !box) return new Map();
  const prior = owners.get(box) ?? Promise.resolve();
  const pending = prior.catch(() => {}).then(async () => {
    const catalog = await readJson(join(data, 'skill-catalog.json'), { skills: [] });
    const files = [], paths = new Map();
    for (const skill of catalog.skills.filter(item => item.enabled)) {
      const content = skill.versions.find(item => item.id === skill.current);
      const prefix = packagePath(`${skill.id}-${skill.current.slice(0, 12)}`);
      paths.set(skill.id, { path: `${root}/${prefix}/SKILL.md`, revision: skill.current });
      for (const file of content.files) files.push({ ...file, path: `${prefix}/${packagePath(file.path)}` });
    }
    if (!files.length) return paths;
    const [ctx, cancel] = library.createContext().withCancel();
    const timer = setTimeout(() => cancel(new Error('Skill synchronization timed out')), 60000);
    let shell;
    const { shellExecutorResource, buildHostShellArgs } = library.getComputerRecoveryBindings();
    const run = async command => {
      const result = await shell.execute(ctx, buildHostShellArgs({ command, name: 'python3', workingDirectory: '/workspace', toolCallId: `skills-sync-${randomUUID()}` }));
      if (result.result?.case !== 'success' || result.result.value.exitCode !== 0) throw new Error('Skill synchronization failed on the execution node');
      return result.result.value.stdout;
    };
    try {
      const connection = await box.ensureReady(ctx, options.getAgentId?.());
      shell = connection.remoteAccessor.get(shellExecutorResource);
      const missing = new Set(JSON.parse(await run(`python3 -c ${quote(checkFiles)} ${quote(root)} ${quote(JSON.stringify(files.map(({ path, sha256 }) => ({ path, sha256 }))))}`)));
      for (const file of files.filter(file => missing.has(file.path))) {
        const temporary = `${root}/.upload-${randomUUID()}`;
        await box.uploadFile(ctx, options.getAgentId?.(), temporary, Buffer.from(file.content, file.encoding));
        await run(`python3 -c ${quote(publishFile)} ${quote(temporary)} ${quote(`${root}/${file.path}`)} ${quote(file.sha256)}`);
      }
      return paths;
    } finally { clearTimeout(timer); cancel(); }
  });
  owners.set(box, pending); return pending;
}
