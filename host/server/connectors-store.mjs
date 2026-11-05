import {
  randomBytes,
  createCipheriv,
  createDecipheriv,
  createHash,
} from "node:crypto";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { check } from "./security.mjs";
import { readJson, writePrivate } from "./storage.mjs";

export const connectorId = (value) => {
  check(
    typeof value === "string" && /^[a-z][a-z0-9_-]{0,63}$/.test(value),
    400,
    "连接器 ID 格式无效",
  );
  return value;
};
export const numericId = (id) =>
  (
    BigInt(
      `0x${createHash("sha256").update(`host-connector:${id}`).digest("hex").slice(0, 7)}`,
    ) + 1n
  ).toString();
const text = (value, maximum, label) => {
  check(
    typeof value === "string" &&
      value.length <= maximum &&
      !/[\0\r\n]/.test(value),
    400,
    `${label}格式无效`,
  );
  return value.trim();
};
export function connectorUrl(value, label = "服务地址") {
  let url;
  try {
    url = new URL(text(value, 2048, label));
  } catch {
    check(false, 400, `${label}格式无效`);
  }
  check(
    ["http:", "https:"].includes(url.protocol) &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash &&
      ![
        "169.254.169.254",
        "metadata.google.internal",
        "100.100.100.200",
      ].includes(url.hostname),
    400,
    `${label}须为不含凭证或查询参数的 HTTP(S) 地址`,
  );
  return url.href;
}
export function validateConnector(input, previous) {
  check(
    input && typeof input === "object" && !Array.isArray(input),
    400,
    "连接器定义无效",
  );
  const id = connectorId(input.id ?? previous?.id);
  check(!previous || previous.id === id, 400, "连接器 ID 不能修改");
  const name = text(input.name, 100, "名称");
  check(name, 400, "名称不能为空");
  const description = input.description ?? "";
  check(
    typeof description === "string" &&
      description.length <= 2000 &&
      !description.includes("\0"),
    400,
    "说明格式无效",
  );
  const transport = input.transport ?? "streamable-http";
  check(["streamable-http", "sse"].includes(transport), 400, "传输类型无效");
  const url = connectorUrl(input.url);
  const auth = input.auth ?? { type: "none" };
  check(
    ["none", "bearer", "api-key", "oauth2"].includes(auth.type),
    400,
    "授权类型无效",
  );
  const nextAuth = { type: auth.type };
  if (auth.type === "api-key") {
    nextAuth.headerName = text(auth.headerName, 80, "API Key Header");
    check(
      /^[a-zA-Z][a-zA-Z0-9-]*$/.test(nextAuth.headerName) &&
        !/^(host|cookie|connection|content-length|content-type|accept|origin|proxy-.+|mcp-.+)$/i.test(
          nextAuth.headerName,
        ),
      400,
      "API Key Header 不可覆盖传输头",
    );
  }
  if (auth.type === "oauth2") {
    nextAuth.authorizationUrl = connectorUrl(auth.authorizationUrl, "授权地址");
    nextAuth.tokenUrl = connectorUrl(auth.tokenUrl, "Token 地址");
    nextAuth.clientId = text(auth.clientId, 512, "Client ID");
    check(nextAuth.clientId, 400, "Client ID 不能为空");
    nextAuth.scopes = auth.scopes ?? [];
    check(
      Array.isArray(nextAuth.scopes) &&
        nextAuth.scopes.length <= 50 &&
        nextAuth.scopes.every(
          (s) =>
            typeof s === "string" &&
            /^[\x21\x23-\x5B\x5D-\x7E]{1,200}$/.test(s),
        ),
      400,
      "Scopes 格式无效",
    );
    if (auth.resource)
      nextAuth.resource = connectorUrl(auth.resource, "Resource");
    if (auth.issuer) nextAuth.issuer = connectorUrl(auth.issuer, "Issuer");
  }
  const iconDataUrl = input.iconDataUrl ?? null;
  check(
    iconDataUrl === null ||
      (typeof iconDataUrl === "string" &&
        iconDataUrl.length < 400_000 &&
        /^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/]+=*$/.test(
          iconDataUrl,
        )),
    400,
    "图标须为 PNG/JPEG/WebP data URL",
  );
  return {
    id,
    name,
    description,
    transport,
    url,
    auth: nextAuth,
    enabled: input.enabled !== false,
    iconDataUrl,
    installed: previous?.installed ?? false,
    customInstructions: previous?.customInstructions ?? "",
    disabledTools: previous?.disabledTools ?? [],
    credential:
      previous?.url === url &&
      JSON.stringify(previous.auth) === JSON.stringify(nextAuth)
        ? previous.credential
        : undefined,
    clientSecret: auth.type === "oauth2" ? previous?.clientSecret : undefined,
    updatedAt: Date.now(),
    tools: [],
    connectionStatus: "unchecked",
  };
}
export class ConnectorStore {
  constructor(dataDir) {
    this.directory = join(dataDir, "connectors");
    this.filename = join(this.directory, "catalog.json");
    this.tail = Promise.resolve();
  }
  async load() {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const keyFile = join(this.directory, "encryption.key");
    try {
      this.key = await readFile(keyFile);
    } catch (e) {
      if (e.code !== "ENOENT") throw e;
      this.key = randomBytes(32);
      try {
        await writeFile(keyFile, this.key, { flag: "wx", mode: 0o600 });
      } catch (e) {
        if (e.code !== "EEXIST") throw e;
        this.key = await readFile(keyFile);
      }
    }
    check(this.key.length === 32, 500, "连接器加密密钥无效");
    this.data = await readJson(this.filename, {
      version: 1,
      revision: 0,
      connectors: [],
      states: [],
    });
    return this;
  }
  seal(value) {
    const iv = randomBytes(12),
      cipher = createCipheriv("aes-256-gcm", this.key, iv);
    const bytes = Buffer.concat([
      cipher.update(JSON.stringify(value)),
      cipher.final(),
    ]);
    return {
      iv: iv.toString("base64"),
      tag: cipher.getAuthTag().toString("base64"),
      data: bytes.toString("base64"),
    };
  }
  unseal(value) {
    if (!value) return null;
    const cipher = createDecipheriv(
      "aes-256-gcm",
      this.key,
      Buffer.from(value.iv, "base64"),
    );
    cipher.setAuthTag(Buffer.from(value.tag, "base64"));
    return JSON.parse(
      Buffer.concat([
        cipher.update(Buffer.from(value.data, "base64")),
        cipher.final(),
      ]),
    );
  }
  mutate(callback, { configuration = true } = {}) {
    const run = this.tail
      .catch(() => {})
      .then(async () => {
        const before = structuredClone(this.data);
        let result;
        try {
          result = await callback(this.data);
          if (configuration) this.data.revision++;
          await writePrivate(
            this.filename,
            JSON.stringify(this.data, null, 2) + "\n",
          );
        } catch (error) {
          this.data = before;
          throw error;
        }
        await this.onChanged?.();
        return result;
      });
    this.tail = run;
    return run;
  }
  update(row, callback, options) {
    return this.mutate(() => {
      check(this.find(row.id) === row, 409, "连接器配置已改变，请重试");
      return callback(row);
    }, options);
  }
  find(id) {
    const row = this.data.connectors.find(
      (c) => c.id === id || numericId(c.id) === id,
    );
    check(row, 404, "连接器不存在");
    return row;
  }
  public(row) {
    const { credential, clientSecret, pluginConfiguration, disabledTools, ...visible } = row;
    const token = this.unseal(credential);
    return {
      ...visible,
      hasCredential: Boolean(token),
      auth: { ...row.auth, hasClientSecret: Boolean(clientSecret) },
      authorizationStatus: !row.installed
        ? "disconnected"
        : row.auth.type === "none"
          ? "connected"
          : token
            ? "connected"
            : "needs_auth",
      toolCount: row.tools?.length ?? 0,
      tools: row.tools ?? [],
    };
  }
  async save(input, id) {
    return this.mutate((data) => {
      const previous = id ? this.find(id) : null;
      check(
        previous || data.connectors.length < 100,
        400,
        "连接器数量最多100个",
      );
      const row = validateConnector(input, previous);
      check(
        previous ||
          !data.connectors.some(
            (c) => c.id === row.id || numericId(c.id) === numericId(row.id),
          ),
        409,
        "连接器 ID 已存在",
      );
      if ("clientSecret" in (input.auth ?? {})) {
        const secret = text(input.auth.clientSecret, 8192, "Client Secret");
        row.clientSecret = secret ? this.seal(secret) : undefined;
      }
      if (previous) data.connectors[data.connectors.indexOf(previous)] = row;
      else data.connectors.push(row);
      return this.public(row);
    });
  }
}
