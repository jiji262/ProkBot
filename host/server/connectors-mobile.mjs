import { check } from "./security.mjs";
import { numericId } from "./connectors-store.mjs";

export const mobileConnectorMethods = new Set([
  "ListMarketplaces",
  "GetPluginDetails",
  "ListMarketplacePlugins",
  "ListPrivateMarketplacePlugins",
  "GetEffectiveUserPlugins",
  "InstallUserPlugin",
  "UpdateUserPlugin",
  "UpdateUserPluginVariables",
  "UninstallUserPlugin",
  "GetAvailableMcpServers",
  "ValidateMcpOAuthTokens",
  "ListSandMcpTools",
  "RenameMcpOAuthAccount",
  "DeleteMcpOAuthAccount",
  "CheckHttpMcpStatus",
  "CompleteMcpOAuth",
]);
const identifier = (row) => `host-${row.id}`;
export function mobilePlugin(row) {
  const secret = ["bearer", "api-key"].includes(row.auth.type);
  return {
    id: numericId(row.id),
    name: row.name,
    displayName: row.name,
    description: row.description,
    ...(row.iconDataUrl ? { logoUrl: row.iconDataUrl } : {}),
    status: 1,
    isPublished: false,
    isDeprecated: false,
    tags: [],
    curatedCategoryKeys: ["Host"],
    createdAt: String(row.updatedAt),
    updatedAt: String(row.updatedAt),
    gitUrl: "",
    fullRef: row.id,
    skills: row.bundledSkills ?? [],
    subagents: [],
    hooks: [],
    rules: [],
    commands: [],
    mcpServers: [{ name: row.name, description: row.description }],
    variables: {
      type: "object",
      properties: row.pluginFields?.length ? Object.fromEntries(row.pluginFields.map(field => [field.key, {
        type: 'string', title: field.name.en, writeOnly: field.secret,
      }])) : secret
        ? {
            secret: {
              type: "string",
              title: row.auth.type === "bearer" ? "Bearer Token" : "API Key",
              writeOnly: true,
            },
          }
        : {},
      required: row.pluginFields?.length ? row.pluginFields.filter(field => field.required && !row.pluginConfiguredKeys?.includes(field.key)).map(field => field.key) : secret && !row.credential ? ["secret"] : [],
    },
  };
}
export async function mobileRpc(service, method, args, origin, actor) {
  check(mobileConnectorMethods.has(method), 404, "连接器方法不存在");
  const all = service.store.data.connectors.filter((row) => row.enabled);
  const installed = all.filter((row) => row.installed);
  if (method === "ListMarketplaces") return { marketplaces: [] };
  if (method === "GetPluginDetails")
    return { plugin: mobilePlugin(service.resolve(String(args.pluginId))) };
  if (method === "ListMarketplacePlugins")
    return { plugins: all.map(mobilePlugin), hasMore: false };
  if (method === "ListPrivateMarketplacePlugins")
    return { plugins: [], hasMore: false };
  if (method === "GetEffectiveUserPlugins")
    return {
      plugins: installed.map((row) => ({
        plugin: mobilePlugin(row),
        isEnabled: true,
        isTeamRequired: false,
        installMode: "EFFECTIVE_PLUGIN_INSTALL_MODE_USER",
        hasTeamConfiguredVariables: false,
        configuredVariableKeys:
          row.pluginFields?.length ? row.pluginConfiguredKeys ?? [] : row.credential && ["bearer", "api-key"].includes(row.auth.type)
            ? ["secret"]
            : [],
      })),
      marketplaces: [],
    };
  if (
    method === "InstallUserPlugin" ||
    method === "UpdateUserPlugin" ||
    method === "UpdateUserPluginVariables"
  ) {
    await service.original(
      "installMcpEntry",
      { entryId: String(args.pluginId), values: args.variables ?? {} },
      origin,
      actor,
    );
    return {};
  }
  if (method === "UninstallUserPlugin") {
    await service.disconnect(String(args.pluginId));
    return {};
  }
  if (method === "GetAvailableMcpServers")
    return {
      servers: installed.map((row) => ({
        id: Number(numericId(row.id)),
        name: row.name,
        enabled: true,
        isTeamServer: false,
        type: row.transport === "sse" ? "sse" : "http",
        url: row.url,
        hasStaticCredentialHeaders:
          ["bearer", "api-key"].includes(row.auth.type) &&
          Boolean(row.credential),
        args: [],
        pluginId: numericId(row.id),
        // The original mobile client treats this enum as backend-managed MCP.
        // Host owns the connection and credentials; iOS does not open MCP itself.
        servedBy: "MCP_SERVED_BY_GROK",
        serverIdentifier: identifier(row),
        userHasAccessToken: row.auth.type === "none" || Boolean(row.credential),
        isUnseen: false,
        isRequired: false,
        managedByTeamPluginPolicy: false,
        disabledByTeamAdminPolicy: false,
        accounts: [
          {
            accountKey: "default",
            serverIdentifier: identifier(row),
            userHasAccessToken:
              row.auth.type === "none" || Boolean(row.credential),
          },
        ],
      })),
    };
  if (method === "ListSandMcpTools")
    return {
      servers: await service.internal("list-tools", {
        identifiers: args.serverIdentifiers?.length
          ? args.serverIdentifiers
          : installed.map(identifier),
      }),
    };
  if (method === "ValidateMcpOAuthTokens") {
    const targets =
      args.targets ??
      (args.serverUrls ?? []).map((serverUrl) => ({
        serverUrl,
        accountKey: "default",
      }));
    check(Array.isArray(targets) && targets.length <= 100, 400, "服务列表无效");
    return {
      results: targets.map((target) => ({
        serverUrl: target.serverUrl,
        accountKey: target.accountKey ?? "default",
        hasValidToken: installed.some(
          (row) =>
            row.url === target.serverUrl &&
            (row.auth.type === "none" || Boolean(row.credential)),
        ),
      })),
    };
  }
  if (method === "CheckHttpMcpStatus") {
    check(
      Array.isArray(args.serverIds) && args.serverIds.length <= 100,
      400,
      "服务列表无效",
    );
    return {
      statuses: await Promise.all(
        args.serverIds.map(async (id) => {
          const row = service.resolve(String(id)),
            hasToken = row.auth.type === "none" || Boolean(row.credential);
          let authUrl;
          if (row.auth.type === "oauth2" && (!hasToken || args.forceReauth))
            authUrl = (await service.authorize(row.id, {}, origin, actor))
              .authorizationUrl;
          return {
            id: Number(numericId(row.id)),
            isAvailable: true,
            requiresAuth: row.auth.type !== "none",
            hasValidToken: hasToken,
            ...(authUrl ? { authUrl } : {}),
          };
        }),
      ),
    };
  }
  if (method === "DeleteMcpOAuthAccount") {
    await service.disconnect(String(args.serverId));
    return {};
  }
  if (method === "RenameMcpOAuthAccount")
    check(false, 400, "此 Host 使用单一共享授权，不支持重命名账户");
  if (method === "CompleteMcpOAuth") {
    await service.oauth.complete(
      new URLSearchParams({
        state: args.stateId ?? "",
        code: args.authorizationCode ?? args.code ?? "",
      }),
    );
    return {};
  }
}
