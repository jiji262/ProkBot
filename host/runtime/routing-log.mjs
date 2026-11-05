import { appendFile, mkdir, readFile, readdir, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
export function taskPreview(state) {
  return String(state.at(-1)?.text ?? '').replace(/(?:apikey_|sk-)[A-Za-z0-9_-]{16,}/g, '[redacted]')
    .replace(/Bearer\s+[A-Za-z0-9._-]+/gi, 'Bearer [redacted]').replace(/\s+/g, ' ').trim().slice(0, 240);
}
export async function recordRouting(directory, entry) {
  if (!directory) return;
  const at = new Date().toISOString();
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await appendFile(join(directory, `${at.slice(0, 10)}.jsonl`), JSON.stringify({ id: randomUUID(), at, ...entry }) + '\n', { mode: 0o600 });
  const files = (await readdir(directory)).filter(name => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(name)).sort();
  for (const name of files.slice(0, -30)) await unlink(join(directory, name)).catch(() => {});
}
export async function recentRouting(directory, limit = 100) {
  const files = await readdir(directory).catch(error => { if (error.code === 'ENOENT') return []; throw error; });
  const records = [];
  for (const file of files.filter(name => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(name)).sort().reverse()) {
    const text = await readFile(join(directory, file), 'utf8');
    const rows = text.trim().split('\n').reverse();
    for (const line of rows) { try { const item = JSON.parse(line); if (item.id && item.at) records.push(item); } catch {} if (records.length >= limit) break; }
    if (records.length >= limit) break;
  }
  return records.sort((a, b) => b.at.localeCompare(a.at)).slice(0, limit);
}
