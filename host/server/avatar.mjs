import { check } from "./security.mjs";

const maximumBytes = 2 * 1024 * 1024;
const validSize = (width, height) =>
  width > 0 &&
  height > 0 &&
  width <= 8192 &&
  height <= 8192 &&
  width * height <= 16_777_216;
function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++)
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function png(bytes) {
  if (
    bytes.length < 57 ||
    !bytes.subarray(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex"))
  )
    return false;
  let offset = 8,
    imageData = false,
    header = false;
  while (offset + 12 <= bytes.length) {
    const length = bytes.readUInt32BE(offset);
    if (offset + length + 12 > bytes.length) return false;
    const type = bytes.toString("ascii", offset + 4, offset + 8);
    if (
      crc32(bytes.subarray(offset + 4, offset + 8 + length)) !==
      bytes.readUInt32BE(offset + 8 + length)
    )
      return false;
    if (!header) {
      if (
        type !== "IHDR" ||
        length !== 13 ||
        !validSize(
          bytes.readUInt32BE(offset + 8),
          bytes.readUInt32BE(offset + 12),
        )
      )
        return false;
      header = true;
    } else if (type === "IHDR") return false;
    if (type === "IDAT" && length) imageData = true;
    offset += length + 12;
    if (type === "IEND")
      return length === 0 && imageData && offset === bytes.length;
  }
  return false;
}
function jpeg(bytes) {
  if (
    bytes.length < 20 ||
    bytes.readUInt16BE(0) !== 0xffd8 ||
    bytes.readUInt16BE(bytes.length - 2) !== 0xffd9
  )
    return false;
  let offset = 2,
    dimensions = false;
  while (offset + 4 < bytes.length) {
    if (bytes[offset++] !== 0xff) return false;
    while (bytes[offset] === 0xff) offset++;
    const marker = bytes[offset++];
    if (offset + 2 > bytes.length) return false;
    const length = bytes.readUInt16BE(offset);
    if (length < 2 || offset + length > bytes.length) return false;
    if (
      [
        0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce,
        0xcf,
      ].includes(marker)
    ) {
      if (
        length < 8 ||
        !validSize(
          bytes.readUInt16BE(offset + 5),
          bytes.readUInt16BE(offset + 3),
        )
      )
        return false;
      dimensions = true;
    }
    if (marker === 0xda)
      return dimensions && length >= 6 && offset + length < bytes.length - 2;
    offset += length;
  }
  return false;
}
function webp(bytes) {
  if (
    bytes.length < 25 ||
    bytes.toString("ascii", 0, 4) !== "RIFF" ||
    bytes.toString("ascii", 8, 12) !== "WEBP" ||
    bytes.readUInt32LE(4) + 8 !== bytes.length
  )
    return false;
  let offset = 12,
    frame = false;
  while (offset + 8 <= bytes.length) {
    const type = bytes.toString("ascii", offset, offset + 4);
    const length = bytes.readUInt32LE(offset + 4);
    const start = offset + 8;
    if (start + length > bytes.length) return false;
    if (type === "VP8 ") {
      if (
        length < 10 ||
        !bytes
          .subarray(start + 3, start + 6)
          .equals(Buffer.from([0x9d, 1, 0x2a])) ||
        !validSize(
          bytes.readUInt16LE(start + 6) & 0x3fff,
          bytes.readUInt16LE(start + 8) & 0x3fff,
        )
      )
        return false;
      frame = true;
    } else if (type === "VP8L") {
      if (length < 5 || bytes[start] !== 0x2f) return false;
      const bits = bytes.readUInt32LE(start + 1);
      if (!validSize((bits & 0x3fff) + 1, ((bits >>> 14) & 0x3fff) + 1))
        return false;
      frame = true;
    } else if (type === "VP8X") {
      if (
        length !== 10 ||
        !validSize(
          bytes.readUIntLE(start + 4, 3) + 1,
          bytes.readUIntLE(start + 7, 3) + 1,
        )
      )
        return false;
    }
    offset = start + length + (length % 2);
  }
  return frame && offset === bytes.length;
}
export function validateAvatar(value) {
  if (value === null) return null;
  check(typeof value === "string", 400, "头像需要图片数据，或使用 null 清除");
  check(
    value.length <= Math.ceil(maximumBytes / 3) * 4 + 32,
    413,
    "头像最大为 2 MiB",
  );
  const match =
    /^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/]*={0,2})$/.exec(value);
  check(
    match && match[2].length % 4 === 0,
    400,
    "头像需要 PNG、JPEG 或 WebP 的标准 Base64 数据",
  );
  const bytes = Buffer.from(match[2], "base64");
  check(bytes.length <= maximumBytes, 413, "头像最大为 2 MiB");
  check(
    bytes.length > 0 && bytes.toString("base64") === match[2],
    400,
    "头像 Base64 编码无效",
  );
  check(
    { png, jpeg, webp }[match[1]](bytes),
    400,
    "头像图片格式无效，或尺寸超过 1600 万像素",
  );
  return value;
}
