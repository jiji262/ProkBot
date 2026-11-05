import { readFile, mkdir, writeFile, appendFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

/** Opt-in research observation. Never records headers, credentials, or reasoning text. */
export function observeModelFetch(fetchImpl, session = {}, stateDir = process.env.GROKBOT_STATE_DIR ?? '/research/state') {
  const sessionId = randomUUID();
  return async (url, options) => {
    let capture;
    try {
      const control = JSON.parse(await readFile(join(stateDir, 'active-model-observation.json'), 'utf8'));
      if (!/^recovered-harness-[a-z0-9-]+$/.test(control.id)) throw new Error('Invalid observation id');
      const directory = join(stateDir, control.id);
      await mkdir(directory, { recursive: true, mode: 0o700 });
      const body = JSON.parse(options.body);
      const messages = [];
      for (const message of body.messages) {
        if (message.role === 'tool') {
          messages.push({ role: 'tool', tool_call_id: message.tool_call_id, content: message.content });
        } else if (message.role === 'assistant' && message.tool_calls?.length) {
          messages.push({ role: 'assistant', tool_calls: message.tool_calls });
        } else if (Array.isArray(message.content)) {
          const images = [];
          for (const part of message.content) {
            const match = /^data:image\/(png|webp|jpeg);base64,(.*)$/s.exec(part.image_url?.url ?? '');
            if (!match) continue;
            const bytes = Buffer.from(match[2], 'base64');
            const sha256 = createHash('sha256').update(bytes).digest('hex');
            const filename = `model-image-${sha256}.${match[1] === 'jpeg' ? 'jpg' : match[1]}`;
            await writeFile(join(directory, filename), bytes, { mode: 0o600 });
            images.push({ filename, sha256, bytes: bytes.length });
          }
          if (images.length) messages.push({ role: message.role, images });
        }
      }
      capture = { directory, record: { at: new Date().toISOString(), sessionId,
        requestedModel: session.modelId, inferenceReason: session.inferenceReason,
        model: body.model, tools: body.tools?.map(tool => tool.function.name), messages } };
    } catch (error) {
      if (error.code !== 'ENOENT') console.error(`[model-observation] ${error.message}`);
    }
    const response = await fetchImpl(url, options);
    if (capture) {
      capture.record.status = response.status;
      capture.record.requestId = response.headers.get('x-request-id') ?? response.headers.get('request-id');
      try { await appendFile(join(capture.directory, 'model-observation.jsonl'), JSON.stringify(capture.record) + '\n', { mode: 0o600 }); }
      catch (error) { console.error(`[model-observation] ${error.message}`); }
    }
    return response;
  };
}
