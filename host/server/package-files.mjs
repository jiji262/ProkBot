import { createHash } from 'node:crypto';
import { posix } from 'node:path';
import { check } from './security.mjs';

export const digest = value => createHash('sha256').update(value).digest('hex');
export function packageId(value) {
  check(typeof value === 'string' && /^[a-z][a-z0-9-]{0,63}$/.test(value), 400, 'Invalid package ID');
  return value;
}
export function packagePath(value) {
  check(typeof value === 'string' && value.length <= 240 && !/[\\\0\r\n:]/.test(value) &&
    !value.startsWith('/') && value.split('/').every(part => part && !['.', '..'].includes(part)) &&
    posix.normalize(value) === value, 400, 'Invalid package path');
  return value;
}
export function validateFiles(files, { maxBytes = 10 * 1024 * 1024, maxFiles = 256 } = {}) {
  check(Array.isArray(files) && files.length > 0 && files.length <= maxFiles, 400, 'Invalid package files');
  const paths = new Set(); let total = 0;
  const normalized = files.map(file => {
    const path = packagePath(file.path);
    check(!paths.has(path), 400, 'Duplicate package path'); paths.add(path);
    check(['utf8', 'base64'].includes(file.encoding) && typeof file.content === 'string', 400, 'Invalid file encoding');
    check(file.content.length <= maxBytes * 2, 413, 'Package exceeds size limit');
    const bytes = Buffer.from(file.content, file.encoding);
    if (file.encoding === 'base64') check(bytes.toString('base64') === file.content, 400, 'Invalid base64 file');
    total += bytes.length; check(total <= maxBytes, 413, 'Package exceeds size limit');
    return { path, encoding: file.encoding, content: file.content, sha256: digest(bytes), bytes: bytes.length };
  });
  for (const path of paths) for (const other of paths)
    check(path === other || !other.startsWith(path + '/'), 400, 'File path conflicts with a directory');
  return normalized.sort((a, b) => a.path.localeCompare(b.path));
}
export function textField(value, maximum, label) {
  check(typeof value === 'string' && value.trim() && value.length <= maximum && !value.includes('\0'), 400, `Invalid ${label}`);
  return value.trim();
}
