import { randomBytes } from "node:crypto";
import { chmod, mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { dirname } from "node:path";

export async function writePrivate(filename, text) {
  await mkdir(dirname(filename), { recursive: true, mode: 0o700 });
  const temporary = `${filename}.${randomBytes(8).toString("hex")}.tmp`;
  let file;
  try {
    file = await open(temporary, "wx", 0o600);
    await file.writeFile(text);
    await file.sync();
    await file.close();
    file = null;
    await rename(temporary, filename);
    const directory = await open(dirname(filename), "r");
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
  } finally {
    await file?.close();
    await rm(temporary, { force: true });
  }
}

export async function readJson(filename, fallback) {
  try {
    return JSON.parse(await readFile(filename, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return fallback;
    throw error;
  }
}

export class JsonStore {
  constructor(filename, initial) {
    this.filename = filename;
    this.initial = initial;
    this.tail = Promise.resolve();
  }
  async load() {
    this.value = await readJson(this.filename, this.initial);
    if (!this.value || this.value.version !== 1)
      throw new Error("Unsupported stored state");
    await chmod(this.filename, 0o600).catch((error) => {
      if (error.code !== "ENOENT") throw error;
    });
    return this;
  }
  mutate(update) {
    const pending = this.tail.then(async () => {
      const next = structuredClone(this.value);
      const result = await update(next);
      await writePrivate(this.filename, `${JSON.stringify(next)}\n`);
      this.value = next;
      return result;
    });
    this.tail = pending.catch(() => {});
    return pending;
  }
}
