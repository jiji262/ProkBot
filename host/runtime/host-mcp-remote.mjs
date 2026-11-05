import { readFile } from "node:fs/promises";

const empty = () => ({
  revision: -1,
  config: { mcpServers: {} },
  display: { servers: [] },
});
/** Secrets and remote sessions stay in the management service. The original Host
 * still owns discovery, provider naming, approval and McpResult execution. */
export async function createRemoteMcp(library) {
  const base = process.env.GROKBOT_CONNECTORS_URL;
  let snapshot = empty();
  if (!base) return { enabled: false, snapshot: () => snapshot };
  const url = new URL(base);
  if (
    !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw new Error(
      "Connector service must use an authenticated loopback endpoint",
    );
  }
  const token = (
    await readFile(process.env.GROKBOT_INTERNAL_HOST_TOKEN_FILE, "utf8")
  ).trim();
  const request = async (method, args = {}) => {
    const response = await fetch(`${base.replace(/\/$/, "")}/${method}`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(args),
      redirect: "error",
      signal: AbortSignal.timeout(method === "call" ? 70_000 : 25_000),
    });
    if (!response.ok)
      throw new Error(
        `Host connector service returned HTTP ${response.status}`,
      );
    return response.json();
  };
  const refresh = async () => {
    const next = await request("runtime");
    const changed = next.revision !== snapshot.revision;
    snapshot = next;
    return changed;
  };
  const original = (method, args = {}) => request("original", { method, args });
  const backend = {
    listTools: (identifiers) => request("list-tools", { identifiers }),
    executeTool: async (_context, args) => {
      const result = await request("call", {
        serverIdentifier: args.serverIdentifier,
        toolName: args.toolName,
        args: args.args,
      });
      const content = (result.content ?? []).map((item) => {
        if (item.type === "text") return { text: { text: item.text } };
        if (item.type === "image")
          return { image: { data: item.data, mimeType: item.mimeType } };
        // The shipped Host supports text/image blocks; preserve resource/audio
        // data as structured JSON text instead of silently discarding it.
        return { text: { text: JSON.stringify(item) } };
      });
      return library.McpResult.fromJson({
        success: {
          content,
          isError: Boolean(result.isError),
          ...(result.structuredContent
            ? { structuredContent: result.structuredContent }
            : {}),
        },
      });
    },
    checkAuthStatus: async () => ({
      isAvailable: false,
      requiresAuth: true,
      hasValidToken: false,
      error: "请在客户端的连接应用中完成授权。",
    }),
    completeOAuth: async () => {
      throw new Error("请使用 Host OAuth 回调地址完成授权。");
    },
    validateTokens: async (servers) =>
      servers.map((server) => ({
        ...server,
        hasValidToken: snapshot.display.servers.some(
          (row) =>
            row.config.url === server.serverUrl &&
            row.accounts.some((a) => a.hasToken),
        ),
      })),
  };
  const writer = {
    installPlugin: async ({ pluginId, variables }) => {
      await original("installMcpEntry", {
        entryId: String(pluginId),
        values: variables,
      });
      await refresh();
    },
    updatePluginInstall: async ({ pluginId, variables }) => {
      await original("updateMcpPluginInstall", {
        pluginId: String(pluginId),
        values: variables,
      });
      await refresh();
    },
    uninstallPlugin: async ({ pluginId }) => {
      await original("uninstallMcpPlugin", { pluginId: String(pluginId) });
      await refresh();
    },
  };
  const catalog = () => request("catalog");
  const marketplace = {
    bestEffortToken: async () => null,
    marketplacePluginToView: (value) => value,
    resolvePluginLogo: async (url) =>
      (await original("getMcpPluginLogo", { url }))?.dataUrl ?? null,
  };
  return {
    enabled: true,
    snapshot: () => snapshot,
    refresh,
    request,
    original,
    backend,
    writer,
    catalog,
    marketplace,
    fetchMarketplacePlugins: async () => ({
      plugins: (await catalog()).map((row) => ({
        ...row,
        pluginId: row.id,
        variableFields: row.fields ?? [],
      })),
    }),
    effective: () => request("effective"),
    instructions: () => request("instructions"),
  };
}
