import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { check } from "./security.mjs";

export class ConnectorMcp {
  constructor(store, oauth) {
    this.store = store;
    this.oauth = oauth;
    this.sessions = new Map();
  }
  async close(id) {
    const pending = this.sessions.get(id);
    this.sessions.delete(id);
    if (pending) {
      const client = await pending.catch(() => null);
      await client?.close().catch(() => {});
    }
  }
  async shutdown() {
    await Promise.all([...this.sessions.keys()].map((id) => this.close(id)));
  }
  async client(row) {
    check(row.enabled && row.installed, 403, "连接器尚未启用或授权");
    if (!this.sessions.has(row.id)) {
      const pending = (async () => {
        if (row.builtin) return this.builtinClient(row);
        if (row.pluginId && row.pluginRuntime !== 'remote-mcp') {
          const client = await this.pluginClient(row);
          client.onclose = () => { if (this.sessions.get(row.id) === pending) this.sessions.delete(row.id); };
          return client;
        }
        const origin = new URL(row.url).origin;
        const fetcher = async (input, init = {}) => {
          const url = new URL(
            typeof input === "string" || input instanceof URL
              ? input
              : input.url,
          );
          check(url.origin === origin, 403, "连接器请求不可跨域");
          check(
            this.store.find(row.id) === row && row.installed && row.enabled,
            403,
            "连接器配置或授权已改变",
          );
          const headers = new Headers(init.headers);
          for (const [key, value] of Object.entries(
            await this.oauth.headers(row),
          ))
            headers.set(key, value);
          return fetch(input, {
            ...init,
            headers,
            redirect: "error",
            signal: init.signal
              ? AbortSignal.any([init.signal, AbortSignal.timeout(60_000)])
              : AbortSignal.timeout(60_000),
          });
        };
        const client = new Client(
          { name: "grokbot-selfhost", version: "1.0.0" },
          { capabilities: {} },
        );
        const transport =
          row.transport === "sse"
            ? new SSEClientTransport(new URL(row.url), {
                fetch: fetcher,
                eventSourceInit: { fetch: fetcher },
              })
            : new StreamableHTTPClientTransport(new URL(row.url), {
                fetch: fetcher,
              });
        try {
          await client.connect(transport, { timeout: 20_000 });
        } catch {
          await client.close().catch(() => {});
          throw new Error("MCP 连接失败，请检查服务地址、传输类型和授权");
        }
        client.onclose = () => {
          if (this.sessions.get(row.id) === pending)
            this.sessions.delete(row.id);
        };
        return client;
      })();
      this.sessions.set(row.id, pending);
      pending.catch(() => {
        if (this.sessions.get(row.id) === pending) this.sessions.delete(row.id);
      });
    }
    return this.sessions.get(row.id);
  }
  async tools(id) {
    const row = this.store.find(id), tools = [];
    let client = await this.client(row);
    let cursor;
    for (let page = 0; page < 20; page++) {
      let result;
      try { result = await client.listTools(cursor ? { cursor } : undefined, { timeout: 20_000 }); }
      catch (error) {
        if (!row.pluginId || error.status !== 404 || cursor) throw error;
        // Only discovery is replayed after an idle container has been reclaimed.
        await this.close(id); client = await this.client(row);
        result = await client.listTools(undefined, { timeout: 20_000 });
      }
      for (const tool of result.tools) {
        check(
          typeof tool.name === "string" &&
            tool.name.length <= 200 &&
            tool.inputSchema?.type === "object",
          502,
          "MCP 工具定义无效",
        );
        tools.push(tool);
      }
      check(tools.length <= 1000, 502, "MCP 工具数量过多");
      cursor = result.nextCursor;
      if (!cursor) break;
    }
    check(!cursor, 502, "MCP 工具分页过多");
    await this.store.update(
      row,
      () => {
        row.tools = tools.map(
          ({ name, description, inputSchema, annotations }) => ({
            name,
            description: description?.slice(0, 8000) ?? "",
            inputSchema,
            annotations,
          }),
        );
        row.connectionStatus = "connected";
      },
      { configuration: false },
    );
    return tools;
  }
  async call(id, name, args) {
    const row = this.store.find(id);
    check(
      typeof name === "string" &&
        typeof args === "object" &&
        args !== null &&
        !Array.isArray(args),
      400,
      "MCP 工具请求无效",
    );
    check(!row.disabledTools.includes(name), 403, "此工具已禁用");
    const tools = row.tools.length ? row.tools : await this.tools(id);
    check(
      tools.some((t) => t.name === name),
      404,
      "MCP 工具不存在",
    );
    try {
      return await (
        await this.client(row)
      ).callTool({ name, arguments: args }, undefined, { timeout: 60_000 });
    } catch {
      return {
        isError: true,
        content: [
          {
            type: "text",
            text: "MCP 调用失败或超时。远程操作可能已经执行，请先核查结果，不要自动重试。",
          },
        ],
      };
    }
  }
}
