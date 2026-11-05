import { readFile } from 'node:fs/promises';
import { check } from './security.mjs';
import { validateConnector } from './connectors-store.mjs';

export const BUILDER_ID = 'app-builder';
const names = { en: 'Build an app', 'zh-CN': '编写应用' };
const descriptions = { en: 'Develop, validate and submit shareable applications to this Host.', 'zh-CN': '开发、验证并提交可分享的应用。' };
const objectSchema = properties => ({ type: 'object', properties, additionalProperties: false });
const tools = [
  { name: 'application_development_guide', description: 'Read the Host application format, executable MCP example, OAuth setup, and submission workflow before building an application.', inputSchema: objectSchema({}) },
  { name: 'validate_application', description: 'Validate a grokbot-app JSON package without installing or running it. Supply package or an absolute JSON path on the Bot computer.', inputSchema: objectSchema({ package: { type: 'object' }, path: { type: 'string' } }) },
  { name: 'submit_application', description: 'Submit a new application to the Host catalog. The user then adds it in Connected Apps and authorizes external services. Does not execute application code.', inputSchema: objectSchema({ package: { type: 'object' }, path: { type: 'string' } }) },
];
const textResult = value => ({ content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value) }] });

export class Applications {
  constructor({ connectors, plugins, hostCall }) { Object.assign(this, { connectors, plugins, hostCall }); }
  async load() {
    const store = this.connectors.store;
    await store.mutate(data => {
      let row = data.connectors.find(row => row.id === BUILDER_ID);
      check(!row || row.builtin, 409, 'Built-in application ID conflicts with an existing application');
      if (!row) { row = { ...validateConnector({ id: BUILDER_ID, name: names.en, description: descriptions.en,
        url: 'http://app.invalid/builder', auth: { type: 'none' } }), builtin: true, installed: true }; data.connectors.push(row); }
      Object.assign(row, { tools, connectionStatus: 'connected', localizedName: names, localizedDescription: descriptions });
    });
    this.connectors.mcp.builtinClient = row => {
      check(row.id === BUILDER_ID, 404, 'Built-in application not found');
      return { listTools: async () => ({ tools }), close: async () => {}, callTool: async ({ name, arguments: args = {} }) => {
        if (name === 'application_development_guide') return textResult(await readFile(new URL('./application-guide.md', import.meta.url), 'utf8'));
        const input = args.path ? (await this.hostCall('localApplicationRpc', { action: 'read', path: args.path })).package : args.package;
        const preview = this.plugins.preview(input);
        if (name === 'validate_application') return textResult({ valid: true, id: preview.package.id, version: preview.package.version, files: preview.files });
        check(name === 'submit_application', 404, 'Unknown application tool');
        check(!this.connectors.store.data.connectors.some(row => row.id === preview.package.id), 409, 'This application already exists; import updates in Host administration');
        await this.plugins.publish(preview.package);
        await this.plugins.update(preview.package.id, { enabled: true });
        return textResult({ id: preview.package.id, available: true, installed: false, next: 'Add this application in Connected Apps, then authorize it if requested.' });
      } };
    };
    return this;
  }
  get(id, includePackage = true) {
    const row = this.connectors.resolve(id), visible = this.connectors.store.public(row);
    if (row.builtin) return { ...visible, kind: 'builtin', name: names, description: descriptions, skills: [], configuration: [] };
    if (row.pluginId) return { ...visible, ...this.plugins.get(row.id, includePackage), kind: 'package' };
    return { ...visible, kind: 'remote' };
  }
  list() { return this.connectors.store.data.connectors.map(row => this.get(row.id, false)); }
  export(id) {
    const row = this.connectors.resolve(id); check(!row.builtin, 400, 'Built-in applications do not need exporting');
    if (row.pluginId) return { ...this.plugins.package(row.id), kind: 'grokbot-app' };
    const files = [], icon = row.iconDataUrl ? 'icon.' + row.iconDataUrl.split(';')[0].split('/')[1] : undefined;
    if (icon) files.push({ path: icon, encoding: 'base64', content: row.iconDataUrl.split(',')[1] });
    return this.plugins.preview({ schemaVersion: 1, kind: 'grokbot-app', id: row.id, version: '1.0.0',
      name: row.name, description: row.description, runtime: { kind: 'remote-mcp', url: row.url, transport: row.transport, auth: row.auth },
      ...(icon ? { icon } : {}), files }).package;
  }
  async update(id, input) {
    const row = this.connectors.resolve(id);
    if (row.pluginId) { await this.plugins.update(id, input); return this.get(id); }
    check(typeof input.enabled === 'boolean', 400, 'Invalid application state');
    await this.connectors.mcp.close(row.id);
    await this.connectors.store.update(row, () => { row.enabled = input.enabled; }); return this.get(id);
  }
}
