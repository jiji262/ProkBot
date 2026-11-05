import { randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { mkdir, open } from "node:fs/promises";
import { dirname } from "node:path";

export async function internalCredential(filename, { create = false } = {}) {
  if (create) {
    await mkdir(dirname(filename), { recursive: true, mode: 0o700 });
    let file;
    try {
      file = await open(
        filename,
        constants.O_WRONLY |
          constants.O_CREAT |
          constants.O_EXCL |
          constants.O_NOFOLLOW,
        0o600,
      );
      await file.writeFile(`${randomBytes(32).toString("base64url")}\n`);
      await file.sync();
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
    } finally {
      await file?.close();
    }
  }
  const file = await open(filename, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await file.stat();
    if (!stat.isFile() || (stat.mode & 0o777) !== 0o600 || stat.size > 1024)
      throw new Error(
        "Internal Host credential must be a private regular file (0600)",
      );
    const token = (await file.readFile("utf8")).trim();
    if (!/^[A-Za-z0-9_-]{32,256}$/.test(token))
      throw new Error("Invalid internal Host credential");
    return token;
  } finally {
    await file.close();
  }
}
