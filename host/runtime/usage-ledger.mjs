import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

export function usageCounts(raw = {}) {
  const count = value => Number.isSafeInteger(value) && value >= 0 ? value : 0;
  const input = count(raw.prompt_tokens ?? raw.input_tokens);
  const output = count(raw.completion_tokens ?? raw.output_tokens);
  return { input, output, total: count(raw.total_tokens ?? input + output),
    cached: count(raw.prompt_cache_hit_tokens ?? raw.prompt_tokens_details?.cached_tokens),
    reasoning: count(raw.completion_tokens_details?.reasoning_tokens) };
}
export async function recordUsage(directory, { raw, model, kind = 'chat', effort, requestId, at = new Date() }) {
  if (!directory || !raw || !Object.keys(raw).length) return;
  const timestamp = at.toISOString();
  const entry = { id: randomUUID(), at: timestamp, model, kind, effort, requestId, ...usageCounts(raw) };
  await mkdir(directory, { recursive: true, mode: 0o700 });
  // Each process appends one short JSON line; no read/modify/write race with the admin server.
  await appendFile(join(directory, timestamp.slice(0, 10) + '.jsonl'), JSON.stringify(entry) + '\n', { mode: 0o600 });
}
export async function todayUsage(directory, timeZone = 'UTC', now = new Date()) {
  const date = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' });
  const today = date.format(now), rows = [], seen = new Set();
  for (const offset of [-1, 0, 1]) {
    const day = new Date(now.getTime() + offset * 86400000).toISOString().slice(0, 10);
    const text = await readFile(join(directory, day + '.jsonl'), 'utf8').catch(error => {
      if (error.code === 'ENOENT') return ''; throw error;
    });
    for (const line of text.split('\n')) {
      let row; try { row = JSON.parse(line); } catch { continue; }
      if (!row?.id || seen.has(row.id) || !Number.isFinite(Date.parse(row.at)) || date.format(new Date(row.at)) !== today) continue;
      seen.add(row.id); rows.push(row);
    }
  }
  const sum = group => group.reduce((value, row) => {
    for (const key of ['input', 'output', 'total', 'cached', 'reasoning']) value[key] += row[key] ?? 0;
    value.requests++; return value;
  }, { input: 0, output: 0, total: 0, cached: 0, reasoning: 0, requests: 0 });
  return { date: today, timeZone, ...sum(rows), models: [...new Set(rows.map(row => row.model))].map(model => ({ model, ...sum(rows.filter(row => row.model === model)) })) };
}
