import { createHash } from "node:crypto";
import { constants } from "node:fs";
import {
  mkdir,
  open,
  readdir,
  realpath,
  rm,
  stat,
  unlink,
} from "node:fs/promises";
import { basename, extname, join, resolve, sep } from "node:path";
import { JsonStore, readJson, writePrivate } from "./storage.mjs";
import { check } from "./security.mjs";

const maximumFile = 20 * 1024 * 1024;
const maximumTotal = 100 * 1024 * 1024;
const maximumCount = 100;
const emptyIndex = () => ({ version: 1, files: [] });
export function validateAgentId(value) {
  check(
    typeof value === "string" && /^[a-f0-9-]{1,128}$/i.test(value),
    400,
    "Bot ID 无效",
  );
  return value;
}
function fileName(value) {
  check(
    typeof value === "string" &&
      value.length > 0 &&
      Buffer.byteLength(value) <= 220 &&
      value === basename(value) &&
      !/[\\/\x00-\x1f\x7f]/.test(value) &&
      ![".", ".."].includes(value) &&
      !/\.[a-f0-9]{16}\.tmp$/.test(value),
    400,
    "文件名称无效或过长",
  );
  return value;
}
const mimeFor = (name) =>
  ({
    ".txt": "text/plain",
    ".md": "text/markdown",
    ".json": "application/json",
    ".csv": "text/csv",
    ".pdf": "application/pdf",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".webp": "image/webp",
    ".docx":
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  })[extname(name).toLowerCase()] ?? "application/octet-stream";
async function agentDirectory(dataDir, agentId, create = false) {
  validateAgentId(agentId);
  const basePath = resolve(dataDir, "library");
  if (create)
    await mkdir(join(basePath, agentId), { recursive: true, mode: 0o700 });
  let base, directory;
  try {
    base = await realpath(basePath);
    directory = await realpath(join(basePath, agentId));
  } catch (error) {
    if (!create && error.code === "ENOENT") return null;
    throw error;
  }
  check(
    base === join(await realpath(dataDir), "library") &&
      directory === join(base, agentId) &&
      directory.startsWith(`${base}${sep}`),
    403,
    "资料库目录不允许符号链接",
  );
  return directory;
}
async function listWithIndex(dataDir, agentId, index) {
  const directory = await agentDirectory(dataDir, agentId);
  if (!directory) return { files: [], totalBytes: 0, canEdit: true };
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (!entry.isFile() || /\.[a-f0-9]{16}\.tmp$/.test(entry.name)) continue;
    const path = join(directory, entry.name);
    const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const current = await file.stat();
      if (!current.isFile() || current.size > maximumFile) continue;
      const metadata = index.files.find(
        (item) =>
          item.agentId === agentId &&
          item.name === entry.name &&
          item.sizeBytes === current.size &&
          item.updatedAtMs === current.mtimeMs,
      );
      const etag =
        metadata?.etag ??
        `sha256:${createHash("sha256")
          .update(await file.readFile())
          .digest("hex")}`;
      files.push({
        name: entry.name,
        path,
        sizeBytes: current.size,
        contentType: metadata?.contentType ?? mimeFor(entry.name),
        updatedAtMs: current.mtimeMs,
        etag,
      });
    } finally {
      await file.close();
    }
  }
  files.sort(
    (a, b) => b.updatedAtMs - a.updatedAtMs || a.name.localeCompare(b.name),
  );
  return {
    files,
    totalBytes: files.reduce((total, file) => total + file.sizeBytes, 0),
    canEdit: true,
  };
}
/** Read-only helper shared with Host task setup. Paths belong to the Host filesystem, not the execution Box. */
export async function listAgentLibraryFiles(dataDir, agentId) {
  const index = await readJson(
    join(dataDir, "library-index.json"),
    emptyIndex(),
  );
  check(
    index.version === 1 && Array.isArray(index.files),
    500,
    "资料库索引格式错误",
  );
  return listWithIndex(dataDir, agentId, index);
}
export class Library {
  constructor(dataDir) {
    this.dataDir = dataDir;
    this.tail = Promise.resolve();
    this.index = new JsonStore(
      join(dataDir, "library-index.json"),
      emptyIndex(),
    );
  }
  async load() {
    await this.index.load();
    return this;
  }
  exclusive(action) {
    const next = this.tail.then(action);
    this.tail = next.catch(() => {});
    return next;
  }
  list(agentId) {
    return this.exclusive(() =>
      listWithIndex(this.dataDir, agentId, this.index.value),
    );
  }
  content({ agentId, name }) {
    return this.exclusive(async () => {
      validateAgentId(agentId);
      fileName(name);
      const directory = await agentDirectory(this.dataDir, agentId);
      check(directory, 404, "资料文件不存在");
      let file;
      try {
        file = await open(
          join(directory, name),
          constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
        );
      } catch (error) {
        check(error.code !== "ENOENT", 404, "资料文件不存在");
        check(error.code !== "ELOOP", 403, "资料文件不允许符号链接");
        throw error;
      }
      try {
        const current = await file.stat();
        check(current.isFile(), 403, "只能读取资料文件");
        check(current.size <= maximumFile, 413, "单个文件最大为 20 MiB");
        // Bound the read even if an external process grows the file meanwhile.
        const chunks = [];
        let size = 0;
        for await (const chunk of file.createReadStream({ autoClose: false })) {
          size += chunk.length;
          check(size <= maximumFile, 413, "单个文件最大为 20 MiB");
          chunks.push(chunk);
        }
        const metadata = this.index.value.files.find(
          (item) =>
            item.agentId === agentId &&
            item.name === name &&
            item.sizeBytes === current.size &&
            item.updatedAtMs === current.mtimeMs,
        );
        return {
          name,
          bytes: Buffer.concat(chunks),
          contentType: metadata?.contentType ?? mimeFor(name),
        };
      } finally {
        await file.close();
      }
    });
  }
  upload(input) {
    return this.exclusive(async () => {
      const agentId = validateAgentId(input.agentId);
      const name = fileName(input.fileName);
      check(
        typeof input.contentType === "string" &&
          input.contentType.length <= 160 &&
          /^[a-zA-Z0-9!#$&^_.+-]+\/[a-zA-Z0-9!#$&^_.+-]+(?:; ?charset=[a-zA-Z0-9_-]+)?$/.test(
            input.contentType,
          ),
        400,
        "文件类型无效",
      );
      check(
        typeof input.base64 === "string" &&
          input.base64.length <= Math.ceil(maximumFile / 3) * 4,
        413,
        "单个文件最大为 20 MiB",
      );
      check(
        input.base64.length % 4 === 0 &&
          /^[A-Za-z0-9+/]*={0,2}$/.test(input.base64),
        400,
        "文件内容需要标准 Base64 编码",
      );
      const bytes = Buffer.from(input.base64, "base64");
      check(
        bytes.length <= maximumFile &&
          bytes.toString("base64") === input.base64,
        400,
        "文件内容编码无效",
      );
      const current = await listWithIndex(
        this.dataDir,
        agentId,
        this.index.value,
      );
      const previous = current.files.find((file) => file.name === name);
      check(
        previous || current.files.length < maximumCount,
        413,
        "每个 Bot 最多保存 100 个文件",
      );
      check(
        current.totalBytes - (previous?.sizeBytes ?? 0) + bytes.length <=
          maximumTotal,
        413,
        "每个 Bot 的资料库最大为 100 MiB",
      );
      const directory = await agentDirectory(this.dataDir, agentId, true);
      const path = join(directory, name);
      await writePrivate(path, bytes);
      const saved = await stat(path);
      const file = {
        name,
        path,
        sizeBytes: bytes.length,
        contentType: input.contentType,
        updatedAtMs: saved.mtimeMs,
        etag: `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
      };
      await this.index.mutate((index) => {
        index.files = index.files.filter(
          (item) => item.agentId !== agentId || item.name !== name,
        );
        index.files.push({ agentId, ...file });
      });
      return file;
    });
  }
  removeAgents(ids) {
    return this.exclusive(async () => {
      for (const agentId of ids) {
        validateAgentId(agentId);
        const directory = await agentDirectory(this.dataDir, agentId);
        if (directory) await rm(directory, { recursive: true, force: true });
      }
      await this.index.mutate((index) => {
        index.files = index.files.filter((item) => !ids.includes(item.agentId));
      });
    });
  }
  remove({ agentId, name }) {
    return this.exclusive(async () => {
      validateAgentId(agentId);
      fileName(name);
      const directory = await agentDirectory(this.dataDir, agentId);
      if (directory)
        await unlink(join(directory, name)).catch((error) => {
          if (error.code !== "ENOENT") throw error;
        });
      await this.index.mutate((index) => {
        index.files = index.files.filter(
          (item) => item.agentId !== agentId || item.name !== name,
        );
      });
    });
  }
}
