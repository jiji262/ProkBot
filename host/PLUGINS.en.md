# Build an application / 编写应用

Applications add tools, external-service access, and optional skills to this Host. Use the connected Mac's Codex tools for substantial coding. Small applications can be written with the Bot's existing shell/file tools.

Workflow:
1. Clarify the requested operations and external authorization scope. Read the provider's current official API documentation.
2. Write a self-contained JSON package in `/workspace`. Use `validate_application` to check the format. Test the MCP server with representative inputs; do not send real messages or modify external data without the user's instruction.
3. Call `submit_application` with the absolute JSON path. Submission adds a new available app, without executing it.
4. Tell the user its name. They add it through the original Mac/iOS Connected Apps screen and authorize it there. OAuth credentials are configured in the Host application settings when needed.
5. Export the package from Host Applications to share it. Credentials, user configuration and OAuth tokens are not exported. Existing apps are updated by importing a new version in the Host UI.

## Package

`schemaVersion: 1`, `kind: "grokbot-app"`, stable lowercase `id`, semantic `version`, `name` and `description` (strings or `{ "en": "...", "zh-CN": "..." }`), optional `publisher`, `license`, `icon` file path, `files`, `runtime`, optional `configuration`, `skills`, `permissions`, `dependencies`, `auth`.

Files are `{path,encoding:"utf8"|"base64",content}`. Relative paths only; at most 256 files / 10 MiB. Bundle extra dependencies into the entry file; the runtime supplies `@modelcontextprotocol/sdk` 1.32.1 and `zod` 4.6.7. Versions are immutable.

Runtime:
- `{"kind":"node-stdio","entry":"src/index.mjs"}` runs an MCP stdio process on the existing Bot computer. It shares that computer's user/files/network, not a separate Docker sandbox. Send only MCP JSON on stdout; diagnostics use stderr. Avoid logging credentials.
- `{"kind":"remote-mcp","url":"https://example.com/mcp","transport":"streamable-http","auth":{"type":"none"}}` connects a service. Transport may also be `sse`.
- `{"kind":"skills-only"}` provides skills without code.

Configuration: `[{"key":"API_KEY","name":{"en":"API key","zh-CN":"API 密钥"},"secret":true,"required":true}]`. Values are environment variables supplied at launch. Reserved runtime environment keys cannot be used. Do not put real secrets in files or defaults.

`permissions.network` documents exact external origins, e.g. `["https://gmail.googleapis.com"]`. `permissions.workspace` is `"none"` for schema compatibility; it does not sandbox application code in this runtime.

## Executable example

```json
{"schemaVersion":1,"kind":"grokbot-app","id":"my-echo","version":"1.0.0","name":{"en":"Echo","zh-CN":"回声"},"description":{"en":"Return the supplied text.","zh-CN":"返回输入的文字。"},"runtime":{"kind":"node-stdio","entry":"index.mjs"},"dependencies":{"@modelcontextprotocol/sdk":"1.32.1","zod":"4.6.7"},"files":[{"path":"index.mjs","encoding":"utf8","content":"import {McpServer} from '@modelcontextprotocol/sdk/server/mcp.js';\nimport {StdioServerTransport} from '@modelcontextprotocol/sdk/server/stdio.js';\nimport {z} from 'zod';\nconst server=new McpServer({name:'my-echo',version:'1.0.0'});\nserver.registerTool('echo',{description:'Return text',inputSchema:{text:z.string()}},async ({text})=>({content:[{type:'text',text}]}));\nawait server.connect(new StdioServerTransport());\n"}]}
```

## OAuth and Gmail-style applications

For code apps set top-level `auth` to `{ "type":"oauth2", "authorizationUrl":"https://accounts.google.com/o/oauth2/v2/auth", "tokenUrl":"https://oauth2.googleapis.com/token", "scopes":["https://www.googleapis.com/auth/gmail.readonly"] }`. Use only scopes needed for the user request. A remote MCP app puts auth under `runtime.auth` and includes its provider's Client ID.

Host adds `OAUTH_CLIENT_ID` and optional secret `OAUTH_CLIENT_SECRET` configuration fields for code apps. The user supplies their OAuth application credentials and registers the exact callback URL shown in Host Applications. Creating a provider application/verification may be required by the provider; submitting code does not perform that registration.

Host handles PKCE, state, token exchange, expiry and refresh. Code reads `JSON.parse(process.env.GROKBOT_APP_AUTH_HEADERS || '{}')`, then passes these headers only to the declared external provider, e.g. `fetch('https://gmail.googleapis.com/gmail/v1/users/me/profile', {headers})`. Never return authorization headers in tool results. Host restarts the application session when refreshed authorization changes. The same top-level auth supports `bearer` or `api-key` (with `headerName`).

## Skills

`skills:[{id:"use-mail",path:"skills/mail/SKILL.md",name:"Use mail",description:"Read authorized mail",requiresTools:["list_mail"]}]`. Include the SKILL.md and sibling resource files in `files`. Skills become available when the app and required tools are enabled. Keep instructions concise and specific to actual tools.

Use an SVG-free PNG/JPEG/WebP icon file for the original client catalog. Sharing exports the package only; never embed authorization tokens in a package.
