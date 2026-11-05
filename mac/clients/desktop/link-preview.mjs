import { createHash, randomUUID } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { externalHttpUrl } from './external-url.mjs';
import { fetchPreview } from './link-preview-fetch.mjs';
import path from 'node:path';

const PAGE_LIMIT = 1024 * 1024;
const IMAGE_LIMIT = 2 * 1024 * 1024;
const FAVICON_LIMIT = 128 * 1024;
const MAX_REDIRECTS = 5;
const SUCCESS_TTL = 24 * 60 * 60 * 1000;
const USER_AGENT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 '
  + '(KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36 GrokBot-LinkPreview/1.0';
const IMAGE_TYPES = new Set([
  'image/png',
  'image/jpeg',
  'image/jpg',
  'image/webp',
  'image/gif',
  'image/avif',
  'image/x-icon',
  'image/vnd.microsoft.icon',
]);
const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif', '.avif', '.ico']);
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const GATE_TITLES = new Set(['验证', '安全验证', '环境异常', 'just a moment...', 'attention required!']);

function previewError(code) {
  return Object.assign(new Error(code), { code });
}

async function discardBody(response) {
  try {
    await response.body?.cancel();
  } catch {}
}

function normalizeUrl(value) {
  const normalized = externalHttpUrl(value);
  return normalized ? new URL(normalized) : null;
}

async function readLimitedBody(response, limit) {
  const declared = Number.parseInt(response.headers.get('content-length') ?? '', 10);
  if (Number.isFinite(declared) && declared > limit) {
    await discardBody(response);
    throw previewError('body-too-large');
  }
  if (!response.body) return Buffer.alloc(0);
  const chunks = [];
  let total = 0;
  for await (const chunk of response.body) {
    const bytes = Buffer.from(chunk);
    total += bytes.length;
    if (total > limit) {
      await discardBody(response);
      throw previewError('body-too-large');
    }
    chunks.push(bytes);
  }
  return Buffer.concat(chunks);
}

async function fetchWithRedirects(url, options, lookupImpl) {
  let current = url;
  for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects += 1) {
    const response = await fetchPreview(current, {
      redirect: 'manual',
      signal: options.signal,
      headers: { accept: options.accept, 'user-agent': USER_AGENT },
    }, lookupImpl, options.fetchImpl);
    if (!REDIRECT_STATUSES.has(response.status)) return { response, url: current };
    const location = response.headers.get('location');
    await discardBody(response);
    if (!location) throw previewError('redirect-without-location');
    current = normalizeUrl(new URL(location, current).toString());
    if (!current) throw previewError('invalid-redirect');
  }
  throw previewError('too-many-redirects');
}

function decodeEntities(value) {
  const codePoint = (code, radix) => {
    const number = Number.parseInt(code, radix);
    return number <= 0x10ffff ? String.fromCodePoint(number) : '\ufffd';
  };
  return value
    .replace(/&(?:amp|#38);/gi, '&')
    .replace(/&(?:lt|#60);/gi, '<')
    .replace(/&(?:gt|#62);/gi, '>')
    .replace(/&(?:quot|#34);/gi, '"')
    .replace(/&(?:apos|#39);/gi, "'")
    .replace(/&nbsp;/gi, ' ')
    .replace(/&#(\d+);/g, (_match, code) => codePoint(code, 10))
    .replace(/&#x([0-9a-f]+);/gi, (_match, code) => codePoint(code, 16));
}

function cleanText(value, limit) {
  return decodeEntities(value)
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, limit);
}

function attribute(tag, name) {
  const match = new RegExp(`${name}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i').exec(tag);
  return match?.[2] ?? match?.[3] ?? match?.[4];
}

function metaContent(html, attributeName, value) {
  for (const match of html.matchAll(/<meta\b[^>]*>/gi)) {
    const tag = match[0];
    if (attribute(tag, attributeName)?.toLowerCase() !== value.toLowerCase()) continue;
    const content = attribute(tag, 'content');
    if (content != null) return decodeEntities(content).trim();
  }
  return null;
}

function linkHref(html, relations) {
  for (const match of html.matchAll(/<link\b[^>]*>/gi)) {
    const tag = match[0];
    const values = attribute(tag, 'rel')?.toLowerCase().split(/\s+/);
    if (!values?.some(value => relations.includes(value))) continue;
    const href = attribute(tag, 'href');
    if (href) return decodeEntities(href).trim();
  }
  return null;
}

function resolveHttpUrl(value, base) {
  if (!value) return null;
  try {
    const url = new URL(value, base);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    return externalHttpUrl(url.toString());
  } catch {
    return null;
  }
}

export function parseLinkMetadata(html, finalUrl) {
  const titleTag = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1] ?? '';
  const title = cleanText(
    metaContent(html, 'property', 'og:title')
      ?? metaContent(html, 'name', 'twitter:title')
      ?? titleTag,
    512,
  );
  if (!title) return null;
  const base = finalUrl.toString();
  const description = cleanText(
    metaContent(html, 'property', 'og:description')
      ?? metaContent(html, 'name', 'description')
      ?? metaContent(html, 'name', 'twitter:description')
      ?? '',
    2048,
  );
  const siteName = cleanText(
    metaContent(html, 'property', 'og:site_name')
      ?? metaContent(html, 'name', 'application-name')
      ?? '',
    256,
  );
  const canonicalUrl = resolveHttpUrl(
    linkHref(html, ['canonical']) ?? metaContent(html, 'property', 'og:url'),
    base,
  ) ?? base;
  const imageUrl = resolveHttpUrl(
    metaContent(html, 'property', 'og:image:secure_url')
      ?? metaContent(html, 'property', 'og:image')
      ?? metaContent(html, 'property', 'og:image:url')
      ?? metaContent(html, 'name', 'twitter:image')
      ?? metaContent(html, 'name', 'twitter:image:src'),
    base,
  );
  const faviconUrl = resolveHttpUrl(
    linkHref(html, ['icon', 'shortcut', 'apple-touch-icon', 'apple-touch-icon-precomposed']),
    base,
  );
  return {
    url: base,
    canonicalUrl,
    title,
    description,
    siteName,
    hostname: finalUrl.hostname,
    imageUrl,
    faviconUrl,
  };
}

function isGatedPage(metadata) {
  const url = new URL(metadata.canonicalUrl);
  const pathname = url.pathname.toLowerCase();
  if (pathname.includes('captcha') || pathname.includes('wappoc_appmsg')) return true;
  return GATE_TITLES.has(metadata.title.trim().toLowerCase());
}

function imageMime(response, url) {
  const declared = (response.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase();
  if (IMAGE_TYPES.has(declared)) return declared;
  const extension = path.extname(new URL(url).pathname).toLowerCase();
  if (!IMAGE_EXTENSIONS.has(extension)) return null;
  if (extension === '.png') return 'image/png';
  if (extension === '.webp') return 'image/webp';
  if (extension === '.gif') return 'image/gif';
  if (extension === '.avif') return 'image/avif';
  if (extension === '.ico') return 'image/x-icon';
  return 'image/jpeg';
}

async function fetchDataUrl(url, limit, options) {
  if (!url) return null;
  try {
    const { response, url: finalUrl } = await fetchWithRedirects(
      normalizeUrl(url),
      { ...options, accept: 'image/png,image/jpeg,image/webp,image/gif,image/avif,image/x-icon,image/*;q=0.8' },
      options.lookupImpl,
    );
    if (response.status < 200 || response.status >= 300) {
      await discardBody(response);
      return null;
    }
    const mime = imageMime(response, finalUrl);
    if (!mime) {
      await discardBody(response);
      return null;
    }
    const bytes = await readLimitedBody(response, limit);
    return bytes.length === 0 ? null : `data:${mime};base64,${bytes.toString('base64')}`;
  } catch {
    return null;
  }
}

function cacheFilename(cacheDir, url) {
  return path.join(cacheDir, `${createHash('sha256').update(url).digest('hex')}.json`);
}

async function readCache(filename, now) {
  try {
    if ((await stat(filename)).size > 4 * 1024 * 1024) return { hit: false, metadata: null };
    const value = JSON.parse(await readFile(filename, 'utf8'));
    if (value.version !== 1 || typeof value.storedAt !== 'number'
      || typeof value.metadata !== 'object' || value.metadata === null) {
      return { hit: false, metadata: null };
    }
    if (now() - value.storedAt > SUCCESS_TTL || value.storedAt > now()) {
      await rm(filename, { force: true }); return { hit: false, metadata: null };
    }
    return { hit: true, metadata: value.metadata };
  } catch {
    return { hit: false, metadata: null };
  }
}

async function writeCache(filename, metadata, now) {
  try {
    await mkdir(path.dirname(filename), { recursive: true, mode: 0o700 });
    const temporary = `${filename}.${process.pid}.${randomUUID()}.tmp`;
    await writeFile(temporary, JSON.stringify({ version: 1, storedAt: now(), metadata }), { mode: 0o600 });
    await rename(temporary, filename);
  } catch {}
}

async function trimCache(directory, now) {
  const entries = await Promise.all((await readdir(directory)).filter(name => /^[a-f0-9]{64}\.json$/.test(name))
    .map(async name => { const file = path.join(directory, name); return { file, ...await stat(file) }; }));
  entries.sort((a, b) => b.mtimeMs - a.mtimeMs);
  let bytes = 0;
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i]; bytes += entry.size;
    if (i >= 32 || bytes > 32 * 1024 * 1024 || now() - entry.mtimeMs > SUCCESS_TTL)
      await rm(entry.file, { force: true });
  }
}

export function createLinkPreview({
  profile,
  fetchImpl,
  lookupImpl = lookup,
  now = Date.now,
} = {}) {
  const cacheDir = path.join(profile, 'link-preview-cache', 'local');
  const pending = new Map();
  let maintenance = Promise.resolve();
  const options = {
    fetchImpl,
    lookupImpl,
    timeoutMs: 12000,
    accept: 'text/html,application/xhtml+xml,application/xml;q=0.9',
  };

  async function load(url, cacheOnly) {
    const filename = cacheFilename(cacheDir, url.toString());
    const cached = await readCache(filename, now);
    if (cached.hit || cacheOnly) return cached.metadata;
    const key = url.toString();
    const existing = pending.get(key);
    if (existing) return existing;
    if (pending.size >= 4) return null;
    const task = (async () => {
      let metadata = null;
      try {
        const attempt = { ...options, signal: AbortSignal.timeout(options.timeoutMs) };
        const { response, url: finalUrl } = await fetchWithRedirects(url, attempt, lookupImpl);
        if (response.status < 200 || response.status >= 300) {
          await discardBody(response);
          throw previewError(`http-${response.status}`);
        }
        const contentType = (response.headers.get('content-type') ?? '').toLowerCase();
        if (contentType && !contentType.includes('html') && !contentType.includes('xml')) {
          await discardBody(response);
          throw previewError('not-html');
        }
        const html = (await readLimitedBody(response, PAGE_LIMIT)).toString('utf8');
        const parsed = parseLinkMetadata(html, finalUrl);
        if (!parsed || isGatedPage(parsed)) throw previewError('not-previewable');
        const [imageDataUrl, faviconDataUrl] = await Promise.all([
          fetchDataUrl(parsed.imageUrl, IMAGE_LIMIT, attempt),
          fetchDataUrl(
            parsed.faviconUrl ?? new URL('/favicon.ico', finalUrl).href,
            FAVICON_LIMIT,
            attempt,
          ),
        ]);
        metadata = {
          url: parsed.url,
          canonicalUrl: parsed.canonicalUrl,
          title: parsed.title,
          description: parsed.description,
          siteName: parsed.siteName,
          hostname: parsed.hostname,
          imageDataUrl,
          faviconDataUrl,
          fetchedAt: now(),
        };
      } catch (error) {
        if (process.env.GROKBOT_LOCAL_DEBUG_PORT) {
          console.warn('[link-preview]', error.code ?? error.name ?? 'failed');
        }
      }
      if (metadata) {
        await writeCache(filename, metadata, now);
        maintenance = maintenance.then(() => trimCache(cacheDir, now)).catch(() => {});
        await maintenance;
      }
      return metadata;
    })().finally(() => pending.delete(key));
    pending.set(key, task);
    return task;
  }

  return {
    getMetadata({ url, beforeHover } = {}) {
      const normalized = normalizeUrl(url);
      if (!normalized) return Promise.resolve(null);
      return load(normalized, beforeHover === true);
    },
  };
}
