import { inflateRawSync } from 'node:zlib';
import { check } from './security.mjs';
import { packagePath } from './package-files.mjs';

const MAX = 15 * 1024 * 1024;
const table = Array.from({ length: 256 }, (_, n) => {
  for (let i = 0; i < 8; i++) n = n & 1 ? 0xedb88320 ^ n >>> 1 : n >>> 1;
  return n >>> 0;
});
const crc = bytes => {
  let n = 0xffffffff;
  for (const byte of bytes) n = table[(n ^ byte) & 255] ^ n >>> 8;
  return (n ^ 0xffffffff) >>> 0;
};

/** Portable ZIP with bounded files; never extracts to a filesystem. */
export function encodeSharingZip(files) {
  check(Object.keys(files).length > 0 && Object.keys(files).length <= 256, 400, 'Invalid ZIP file count');
  const local = [], central = []; let offset = 0;
  for (const [name, value] of Object.entries(files)) {
    packagePath(name); const path = Buffer.from(name), bytes = Buffer.from(value);
    const checksum = crc(bytes), header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50); header.writeUInt16LE(20, 4); header.writeUInt16LE(0x800, 6);
    header.writeUInt32LE(checksum, 14); header.writeUInt32LE(bytes.length, 18); header.writeUInt32LE(bytes.length, 22);
    header.writeUInt16LE(path.length, 26);
    const record = Buffer.alloc(46); record.writeUInt32LE(0x02014b50); record.writeUInt16LE(20, 4);
    record.writeUInt16LE(20, 6); record.writeUInt16LE(0x800, 8); record.writeUInt32LE(checksum, 16);
    record.writeUInt32LE(bytes.length, 20); record.writeUInt32LE(bytes.length, 24); record.writeUInt16LE(path.length, 28);
    record.writeUInt32LE(offset, 42); central.push(record, path); local.push(header, path, bytes);
    offset += header.length + path.length + bytes.length;
  }
  const directory = Buffer.concat(central), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50); end.writeUInt16LE(Object.keys(files).length, 8); end.writeUInt16LE(Object.keys(files).length, 10);
  end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16);
  const result = Buffer.concat([...local, directory, end]); check(result.length <= MAX, 413, 'Package exceeds size limit');
  return result;
}

export function decodeSharingZip(bytes) {
  check(Buffer.isBuffer(bytes) && bytes.length >= 22 && bytes.length <= MAX, 400, 'Invalid ZIP');
  let end = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65557); i--) {
    if (bytes.readUInt32LE(i) === 0x06054b50 && i + 22 + bytes.readUInt16LE(i + 20) === bytes.length) { end = i; break; }
  }
  check(end >= 0 && bytes.readUInt16LE(end + 4) === 0 && bytes.readUInt16LE(end + 6) === 0, 400, 'Invalid ZIP directory');
  const count = bytes.readUInt16LE(end + 10), size = bytes.readUInt32LE(end + 12), start = bytes.readUInt32LE(end + 16);
  check(count > 0 && count <= 256 && count === bytes.readUInt16LE(end + 8) && start + size === end, 400, 'Invalid ZIP directory');
  let cursor = start, total = 0; const files = Object.create(null), ranges = [];
  for (let n = 0; n < count; n++) {
    check(cursor + 46 <= end && bytes.readUInt32LE(cursor) === 0x02014b50, 400, 'Invalid ZIP entry');
    const flags = bytes.readUInt16LE(cursor + 8), method = bytes.readUInt16LE(cursor + 10);
    const compressed = bytes.readUInt32LE(cursor + 20), expanded = bytes.readUInt32LE(cursor + 24);
    const nameSize = bytes.readUInt16LE(cursor + 28), extraSize = bytes.readUInt16LE(cursor + 30), commentSize = bytes.readUInt16LE(cursor + 32);
    const offset = bytes.readUInt32LE(cursor + 42), attributes = bytes.readUInt32LE(cursor + 38);
    check(!(flags & ~0x808) && [0, 8].includes(method) && bytes.readUInt16LE(cursor + 34) === 0 &&
      (attributes >>> 16 & 0xf000) !== 0xa000 && expanded <= MAX && total + expanded <= MAX, 400, 'Unsupported ZIP entry');
    check(cursor + 46 + nameSize + extraSize + commentSize <= end && offset + 30 <= start, 400, 'Invalid ZIP bounds');
    const name = bytes.subarray(cursor + 46, cursor + 46 + nameSize).toString('utf8');
    packagePath(name); check(!Object.hasOwn(files, name), 400, 'Duplicate ZIP path');
    check(bytes.readUInt32LE(offset) === 0x04034b50 && bytes.readUInt16LE(offset + 6) === flags &&
      bytes.readUInt16LE(offset + 8) === method, 400, 'ZIP headers disagree');
    const localNameSize = bytes.readUInt16LE(offset + 26), localExtraSize = bytes.readUInt16LE(offset + 28);
    const data = offset + 30 + localNameSize + localExtraSize;
    check(data + compressed <= start && bytes.subarray(offset + 30, offset + 30 + localNameSize).toString('utf8') === name,
      400, 'Invalid ZIP local entry');
    check(!ranges.some(([a, b]) => offset < b && data + compressed > a), 400, 'Overlapping ZIP entries');
    ranges.push([offset, data + compressed]);
    let content;
    try { content = method === 0 ? bytes.subarray(data, data + compressed) : inflateRawSync(bytes.subarray(data, data + compressed), { maxOutputLength: Math.max(1, expanded) }); }
    catch { check(false, 400, 'Invalid compressed ZIP entry'); }
    check(content.length === expanded && crc(content) === bytes.readUInt32LE(cursor + 16), 400, 'ZIP checksum mismatch');
    files[name] = Buffer.from(content); total += expanded; cursor += 46 + nameSize + extraSize + commentSize;
  }
  check(cursor === end, 400, 'Invalid ZIP directory size'); return files;
}
