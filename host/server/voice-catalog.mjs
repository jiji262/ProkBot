import { check, HttpError } from './security.mjs';

/** Read one bounded public Fish library page; credentials stay on the Host. */
export async function listFishVoices(config, query = {}) {
  const page = query.page ?? 1;
  check(Number.isInteger(page) && page >= 1 && page <= 20, 400, 'Invalid voice catalog page');
  const language = query.language ?? 'zh';
  check(['zh', 'en'].includes(language), 400, 'Invalid voice language');
  const title = query.title ?? '';
  check(typeof title === 'string' && title.length <= 100 && !/[\x00-\x1f\x7f]/.test(title), 400, 'Invalid voice search');
  const url = new URL('/model', config.endpoint);
  url.search = new URLSearchParams({ page_size: '50', page_number: String(page), language, title: title.trim(), self: 'false' });
  let response;
  try {
    response = await fetch(url, { headers: { authorization: `Bearer ${config.apiKey}` }, redirect: 'error', signal: AbortSignal.timeout(15_000) });
    if (!response.ok) {
      await response.body?.cancel();
      throw new HttpError(502, response.status === 401 || response.status === 403 ? 'Voice service rejected the API key' : 'Could not load voice library');
    }
    let bytes = 0; const chunks = [];
    for await (const chunk of response.body) {
      bytes += chunk.length;
      check(bytes <= 2_000_000, 502, 'Voice library response is too large');
      chunks.push(chunk);
    }
    const data = JSON.parse(Buffer.concat(chunks));
    check(Array.isArray(data.items), 502, 'Invalid voice library response');
    return { page, hasMore: page < 20 && data.has_more === true,
      voices: data.items.slice(0, 50).filter(item => item.visibility === 'public' && !item.dmca_taken_down &&
        typeof item._id === 'string' && /^[A-Za-z0-9_-]{1,200}$/.test(item._id) && typeof item.title === 'string')
        .map(item => ({ id: item._id, name: item.title.slice(0, 200),
          languages: Array.isArray(item.languages) ? item.languages.filter(v => typeof v === 'string').slice(0, 10) : [] })) };
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw new HttpError(502, 'Could not load voice library');
  }
}
