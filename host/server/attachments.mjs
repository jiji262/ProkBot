import { constants } from "node:fs";
import { open, realpath } from "node:fs/promises";
import { extname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { check } from "./security.mjs";

export async function attachmentDataUrl(source, root, urlRoot = root) {
  let url;
  try {
    url = new URL(source);
  } catch {
    check(false, 400, "附件地址无效");
  }
  check(
    url.protocol === "file:" && !url.hostname && !url.search && !url.hash,
    400,
    "附件需要本地文件地址",
  );
  const pathname = fileURLToPath(url);
  const suffix = relative(resolve(urlRoot), pathname);
  check(
    /^agents\/[a-f0-9-]+\/attachments\/[a-zA-Z0-9._-]+$/.test(suffix),
    403,
    "附件不在允许的目录内",
  );
  const base = await realpath(root);
  let filename;
  try {
    filename = await realpath(join(base, suffix));
  } catch {
    check(false, 404, "附件不存在");
  }
  check(filename.startsWith(`${base}${sep}`), 403, "附件不在允许的目录内");
  const mime = {
    ".png": "image/png",
    ".webp": "image/webp",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".gif": "image/gif",
  }[extname(filename).toLowerCase()];
  check(mime, 415, "不支持的附件图片格式");
  const file = await open(filename, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await file.stat();
    check(
      stat.isFile() && stat.size <= 32 * 1024 * 1024,
      413,
      "附件过大或不是普通文件",
    );
    return {
      dataUrl: `data:${mime};base64,${(await file.readFile()).toString("base64")}`,
    };
  } finally {
    await file.close();
  }
}
