import { open, realpath } from 'node:fs/promises';
import { constants } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Host and execution nodes need not share a filesystem. The original prompt
// identifies managed attachments as already present on the Bot computer.
export async function syncTurnAttachments(options, turn, library, root = process.env.SAND_DATA_ROOT) {
  const paths = [...turn.attachedFilePaths ?? [],
    ...(turn.selectedImages ?? []).map(image => image.path),
    ...(turn.selectedVideos ?? []).map(video => video.path)];
  if (!root || !paths.length) return;
  const agents = join(resolve(root), 'agents');
  const agentId = options.getAgentId?.() ?? options.agentStore?.getId();
  const [context, cancel] = library.createContext().withCancel();
  const timer = setTimeout(() => cancel(new Error('Attachment transfer timed out')), 120_000);
  const transferred = new Set();
  try {
    for (const value of new Set(paths)) {
      if (typeof value !== 'string') continue;
      const path = value.startsWith('file:') ? fileURLToPath(value) : resolve(value);
      if (transferred.has(path)) continue;
      if (!/^[a-f0-9-]+\/attachments\/[^/]+$/i.test(relative(agents, path))) continue;
      if (await realpath(path) !== path || await realpath(agents) !== agents)
        throw new Error('Invalid managed attachment path');
      const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const info = await file.stat();
        if (!info.isFile() || info.size > 200 * 1024 * 1024) throw new Error('Invalid attachment size');
        const bytes = await file.readFile();
        if (bytes.length !== info.size) throw new Error('Attachment changed during transfer');
        await options.remoteBox.uploadFile(context, agentId, path, bytes);
        transferred.add(path);
      } finally { await file.close(); }
    }
  } finally { clearTimeout(timer); cancel(); }
}
