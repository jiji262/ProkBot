import { mobileRpc } from "./connectors-mobile.mjs";
export { mobileConnectorMethods } from "./connectors-mobile.mjs";
import { ConnectorStore, numericId } from "./connectors-store.mjs";
import { ConnectorOAuth } from "./connectors-oauth.mjs";
import { ConnectorMcp } from "./connectors-mcp.mjs";
import { check } from "./security.mjs";

export const connectorApiMethods = new Set([
  "getMcpState",
  "getMcpCatalog",
  "getEffectiveMcpPlugins",
  "getMcpPluginLogo",
  "installMcpEntry",
  "updateMcpPluginInstall",
  "removeMcpServer",
  "uninstallMcpPlugin",
  "authenticateMcpServer",
  "renameMcpAccount",
  "removeMcpAccount",
  "setMcpCustomInstructions",
  "listMcpServerTools",
  "toggleMcpToolDisabled",
]);
const identifier = (row) => `host-${row.id}`;
export class Connectors {
  constructor(dataDir, options = {}) {
    this.store = new ConnectorStore(dataDir);
    this.oauth = new ConnectorOAuth(this.store, {
      ...options,
      changed: (id) => this.mcp.close(id),
    });
    this.mcp = new ConnectorMcp(this.store, this.oauth);
  }
  async load() {
    await this.store.load();
    return this;
  }
  close() {
    return this.mcp.shutdown();
  }
  catalog() {
    return this.store.data.connectors
      .filter((row) => row.enabled)
      .map((row) => ({
        id: numericId(row.id),
        name: row.name,
        displayName: row.name,
        description: row.description,
        category: "Host",
        iconUrl: row.iconDataUrl ?? undefined,
        connectors: [{ name: row.name, description: row.description }],
        skills: row.bundledSkills ?? [],
        fields: row.pluginFields?.length ? row.pluginFields.map(field => ({ key: field.key, type: 'string',
          label: field.name.en, isRequired: field.required && !this.store.unseal(row.pluginConfiguration)?.[field.key], isSecret: field.secret })) : ["bearer", "api-key"].includes(row.auth.type)
          ? [
              {
                key: "secret",
                type: "string",
                label: row.auth.type === "bearer" ? "Bearer Token" : "API Key",
                isRequired: !row.credential,
                isSecret: true,
              },
            ]
          : [],
      }));
  }
  effective() {
    return this.store.data.connectors
      .filter((r) => r.enabled && r.installed)
      .map((row) => ({
        pluginId: numericId(row.id),
        name: row.name,
        displayName: row.name,
        installMode: "user",
        isEnabled: true,
      }));
  }
  state() {
    return {
      servers: this.store.data.connectors
        .filter((r) => r.enabled && r.installed)
        .map((row) => {
          const p = this.store.public(row);
          return {
            id: numericId(row.id),
            name: row.name,
            serverIdentifier: identifier(row),
            rowServerIdentifier: identifier(row),
            pluginId: numericId(row.id),
            accountKey: "default",
            singleAccount: true,
            transport: row.transport === "sse" ? "sse" : "http",
            url: row.url,
            toolCount: row.tools.filter(
              (t) => !row.disabledTools.includes(t.name),
            ).length,
            disabledToolCount: row.disabledTools.length,
            isTeamServer: false,
            customInstructions: row.customInstructions,
            status:
              p.authorizationStatus === "needs_auth"
                ? "needsAuth"
                : row.connectionStatus === "connected"
                  ? "connected"
                  : row.connectionStatus === "error"
                    ? "error"
                    : "loading",
            ...(p.authorizationStatus === "needs_auth"
              ? { statusDetail: { kind: "authentication_required" } }
              : {}),
          };
        }),
    };
  }
  runtime() {
    return {
      revision: this.store.data.revision,
      config: {
        mcpServers: Object.fromEntries(
          this.store.data.connectors
            .filter((r) => r.enabled && r.installed)
            .map((row) => [
              identifier(row),
              { url: row.url, type: row.transport === "sse" ? "sse" : "http" },
            ]),
        ),
      },
      display: {
        servers: this.store.data.connectors
          .filter((r) => r.enabled && r.installed)
          .map((row) => ({
            id: numericId(row.id),
            name: row.name,
            serverIdentifier: identifier(row),
            pluginId: numericId(row.id),
            config: {
              url: row.url,
              type: row.transport === "sse" ? "sse" : "http",
            },
            isTeamServer: false,
            accounts: [
              {
                accountKey: "default",
                serverIdentifier: identifier(row),
                hasToken: row.auth.type === "none" || Boolean(row.credential),
              },
            ],
          })),
      },
    };
  }
  resolve(id) {
    check(typeof id === "string", 400, "连接器 ID 无效");
    return this.store.find(id.startsWith("host-") ? id.slice(5) : id);
  }
  async authorize(id, input, origin, actor) {
    const row = this.resolve(id);
    check(row.enabled, 400, "连接器已停用");
    if (row.pluginId && row.pluginRuntime !== 'remote-mcp') {
      await this.plugins.configure(row.pluginId, input.values ?? {}, { install: true });
      if (row.auth.type === 'none') return { ok: true, connector: this.store.public(this.resolve(id)) };
      return this.authorizeInstalled(this.resolve(id), input, origin, actor);
    }
    return this.authorizeInstalled(row, input, origin, actor);
  }
  async authorizeInstalled(row, input, origin, actor) {
    if (row.auth.type === "oauth2")
      return this.oauth.begin(
        row.id,
        origin,
        actor,
        input.returnTo ?? "client",
      );
    if (row.auth.type !== "none") {
      check(
        typeof input.secret === "string" &&
          input.secret.length > 0 &&
          input.secret.length <= 16384 &&
          !/[\r\n\0]/.test(input.secret),
        400,
        "请输入有效的授权密钥",
      );
    }
    await this.store.update(row, () => {
      row.installed = true;
      row.connectionStatus = "unchecked";
      row.credential =
        row.auth.type === "none"
          ? undefined
          : this.store.seal({ secret: input.secret });
    });
    await this.mcp.close(row.id);
    return { ok: true, connector: this.store.public(row) };
  }
  async disconnect(id) {
    const row = this.resolve(id);
    await this.store.mutate((data) => {
      row.installed = false;
      row.connectionStatus = "unchecked";
      row.credential = undefined;
      row.pluginConfiguration = undefined;
      row.pluginConfiguredKeys = [];
      row.tools = [];
      data.states = data.states.filter(
        (s) => this.store.unseal(s.details).id !== row.id,
      );
    });
    await this.mcp.close(row.id);
    return { ok: true };
  }
  async test(id) {
    try {
      const tools = await this.mcp.tools(this.resolve(id).id);
      return {
        ok: true,
        toolCount: tools.length,
        tools: tools.map(({ name, description }) => ({ name, description })),
      };
    } catch {
      await this.store.update(
        this.resolve(id),
        (row) => {
          row.connectionStatus = "error";
        },
        { configuration: false },
      );
      return {
        ok: false,
        toolCount: 0,
        tools: [],
        error: "MCP 服务无法连接或需要授权，请检查服务配置",
      };
    }
  }
  async route(role, method, path, input, origin, actor) {
    const prefix =
      role === "admin" ? "/admin/api/connectors" : "/local/connectors";
    check(
      path === prefix || path.startsWith(prefix + "/"),
      404,
      "连接器路由不存在",
    );
    const parts = path.slice(prefix.length).split("/").filter(Boolean);
    check(parts.length <= 2, 404, "连接器路由不存在");
    if (!parts.length && method === "GET")
      return {
        connectors: this.store.data.connectors
          .filter((row) => role === "admin" || row.enabled)
          .map((row) => this.store.public(row)),
        redirectUri: new URL("/connectors/oauth/callback", origin).href,
      };
    if (!parts.length && method === "POST") {
      check(role === "admin", 403, "仅管理员可以添加连接器");
      return this.store.save(input);
    }
    check(parts.length > 0, 405, "不支持此操作");
    const row = this.resolve(parts[0]);
    check(role === "admin" || row.enabled, 404, "连接器不存在");
    if (parts.length === 1) {
      if (method === "GET") return this.store.public(row);
      check(role === "admin", 403, "仅管理员可以修改连接器定义");
      check(!row.pluginId, 409, 'Update this application by importing its package');
      if (method === "PUT") {
        const result = await this.store.save(input, row.id);
        await this.mcp.close(row.id);
        return result;
      }
      if (method === "DELETE") {
        await this.disconnect(row.id);
        await this.store.mutate((data) => {
          data.connectors = data.connectors.filter(
            (item) => item.id !== row.id,
          );
        });
        return { ok: true };
      }
    }
    check(method === "POST", 405, "不支持此操作");
    if (parts[1] === "authorize")
      return this.authorize(row.id, input, origin, actor);
    if (parts[1] === "disconnect") return this.disconnect(row.id);
    if (parts[1] === "test") return this.test(row.id);
    check(false, 404, "连接器操作不存在");
  }
  async original(method, args = {}, origin, actor) {
    if (method === "getMcpState") return this.state();
    if (method === "getMcpCatalog") return this.catalog();
    if (method === "getEffectiveMcpPlugins") return this.effective();
    if (method === "getMcpPluginLogo") {
      check(typeof args.url === "string", 400, "图标地址无效");
      return this.store.data.connectors.some(
        (row) => row.iconDataUrl === args.url,
      )
        ? { dataUrl: args.url }
        : null;
    }
    const row = this.resolve(
      args.serverId ?? args.entryId ?? args.pluginId ?? "",
    );
    check(row.enabled, 404, "连接器不存在");
    if (method === "installMcpEntry" || method === "updateMcpPluginInstall") {
      if (row.pluginId && row.pluginRuntime !== "remote-mcp" && row.auth.type === "oauth2") {
        await this.plugins.configure(row.id, args.values ?? {}, { install: true });
        return this.state();
      }
      if (
        ["none", "bearer", "api-key"].includes(row.auth.type) &&
        (!row.credential || args.values?.secret)
      )
        await this.authorize(
          row.id,
          { secret: args.values?.secret, values: args.values },
          origin,
          actor,
        );
      else
        await this.store.mutate(() => {
          row.installed = true;
        });
      return this.state();
    }
    if (method === "authenticateMcpServer") {
      if (row.auth.type !== "oauth2")
        return row.auth.type === "none" || row.credential
          ? { status: "already-authenticated", serverName: row.name }
          : { status: "not-configured", serverName: row.name };
      if (row.credential && !args.forceReauth)
        return { status: "already-authenticated", serverName: row.name };
      return {
        status: "started",
        serverName: row.name,
        ...(await this.authorize(row.id, {}, origin, actor)),
      };
    }
    if (
      ["removeMcpAccount", "removeMcpServer", "uninstallMcpPlugin"].includes(
        method,
      )
    ) {
      await this.disconnect(row.id);
      return method === "removeMcpServer"
        ? { removed: true, state: this.state() }
        : method === "uninstallMcpPlugin"
          ? { removed: true, state: this.state() }
          : this.state();
    }
    if (method === "renameMcpAccount") {
      check(false, 400, "当前 Host 使用单一共享授权，不支持添加或重命名账户");
    }
    if (method === "setMcpCustomInstructions") {
      check(
        typeof args.instructions === "string" &&
          args.instructions.length <= 16000,
        400,
        "指令长度无效",
      );
      await this.store.mutate(() => {
        row.customInstructions = args.instructions;
      });
      return this.state();
    }
    if (method === "listMcpServerTools" || method === "toggleMcpToolDisabled") {
      if (method === "toggleMcpToolDisabled") {
        check(
          typeof args.toolName === "string" &&
            row.tools.some((t) => t.name === args.toolName),
          404,
          "工具不存在",
        );
        await this.store.mutate(() => {
          row.disabledTools = row.disabledTools.includes(args.toolName)
            ? row.disabledTools.filter((n) => n !== args.toolName)
            : [...row.disabledTools, args.toolName];
        });
      }
      const tools = await this.mcp.tools(row.id);
      return tools.map((tool) => ({
        name: tool.name,
        description: tool.description ?? "",
        inputSchema: tool.inputSchema,
        isDisabled: row.disabledTools.includes(tool.name),
      }));
    }
    check(false, 404, "连接器方法不存在");
  }
  mobile(method, args = {}, origin, actor) {
    return mobileRpc(this, method, args, origin, actor);
  }
  async internal(method, args = {}) {
    if (method === 'sync-skills') return this.plugins?.syncResult() ?? [];
    if (method === "runtime") return this.runtime();
    if (method === "catalog") return this.catalog();
    if (method === "effective") return this.effective();
    if (method === "list-tools") {
      check(
        Array.isArray(args.identifiers) && args.identifiers.length <= 100,
        400,
        "服务列表无效",
      );
      return Promise.all(
        args.identifiers.map(async (id) => {
          const row = this.resolve(id);
          let tools = [],
            status = "needsAuth";
          if (row.auth.type === "none" || row.credential) {
            try {
              tools = await this.mcp.tools(row.id);
              status = "connected";
            } catch {
              status = "error";
            }
          }
          return {
            serverIdentifier: identifier(row),
            rowServerIdentifier: identifier(row),
            accountLabel: "default",
            status,
            tools: tools
              .filter((t) => !row.disabledTools.includes(t.name))
              .map((t) => ({
                name: `${identifier(row)}-${t.name}`,
                toolName: t.name,
                providerIdentifier: identifier(row),
                clientKey: identifier(row),
                description: t.description,
                inputSchema: t.inputSchema,
              })),
          };
        }),
      );
    }
    if (method === "instructions")
      return Object.fromEntries(
        this.store.data.connectors
          .filter((r) => r.installed && r.enabled)
          .map((r) => [identifier(r), r.customInstructions]),
      );
    if (method === "original")
      return this.original(args.method, args.args ?? {});
    if (method === "call") {
      check(typeof args.toolName === "string", 400, "工具名称无效");
      const row = this.resolve(args.serverIdentifier);
      const prefix = `${identifier(row)}-`;
      return this.mcp.call(
        row.id,
        args.toolName.startsWith(prefix)
          ? args.toolName.slice(prefix.length)
          : args.toolName,
        args.args,
      );
    }
    check(false, 404, "内部连接器方法不存在");
  }
}
