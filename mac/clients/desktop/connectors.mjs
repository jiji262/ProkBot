import { grokText } from './i18n.mjs';
/** Original connected-app UI, backed exclusively by the paired Host. */
export function createConnectorHandlers({ command, openExternal }) {
  const map = {
    getMcpState: "getMcpState",
    getGrokBotAgentMcpServers: "getMcpState",
    getEffectivePlugins: "getEffectiveMcpPlugins",
    getMcpCatalog: "getMcpCatalog",
    refreshMcpCatalog: "getMcpCatalog",
    getMcpPluginLogo: "getMcpPluginLogo",
    installEntry: "installMcpEntry",
    updatePluginInstall: "updateMcpPluginInstall",
    removeMcpServer: "removeMcpServer",
    uninstallPlugin: "uninstallMcpPlugin",
    renameMcpAccount: "renameMcpAccount",
    removeMcpAccount: "removeMcpAccount",
    setMcpCustomInstructions: "setMcpCustomInstructions",
    listMcpServerTools: "listMcpServerTools",
    toggleMcpToolDisabled: "toggleMcpToolDisabled",
  };
  return {
    ...Object.fromEntries(
      Object.entries(map).map(([local, remote]) => [
        local,
        (args) => command(remote, args),
      ]),
    ),
    getMcpTeamPopularity: () => [],
    authenticateMcpServer: async (args) => {
      const result = await command("authenticateMcpServer", args);
      if (result.status === "started") {
        const url = new URL(result.authorizationUrl);
        if (
          !["http:", "https:"].includes(url.protocol) ||
          url.username ||
          url.password
        )
          throw new Error(grokText('授权地址无效。', 'Invalid authorization URL.'));
        await openExternal(url.href);
      }
      return result;
    },
  };
}
