import { posix } from 'node:path';
import { check } from './security.mjs';
import { digest, packageId, packagePath, validateFiles, textField } from './package-files.mjs';
import { validateConnector, connectorUrl } from './connectors-store.mjs';

export const runnerDependencies = { '@modelcontextprotocol/sdk': '1.32.1', zod: '4.6.7' };
const localized = (value, max, label) => typeof value === 'string' ? { en: textField(value, max, label), 'zh-CN': value.trim() } :
  Object.fromEntries(['en', 'zh-CN'].map(locale => [locale, textField(value?.[locale] ?? value?.en ?? value?.['zh-CN'], max, label)]));

export function validatePlugin(input) {
  check(input?.schemaVersion === 1 && ['grokbot-plugin', 'grokbot-app'].includes(input.kind), 400, 'Unsupported plugin format');
  const id = packageId(input.id), files = validateFiles(input.files), paths = new Map(files.map(file => [file.path, file]));
  check(!['executor', 'preview', 'import', 'app-builder'].includes(id), 400, 'Reserved plugin ID');
  const version = textField(input.version, 80, 'plugin version');
  check(/^\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(version), 400, 'Invalid plugin version');
  const name = localized(input.name, 100, 'plugin name'), description = localized(input.description, 2000, 'plugin description');
  const publisher = textField(input.publisher ?? 'Unknown', 100, 'publisher'), license = textField(input.license ?? 'UNLICENSED', 100, 'license');
  let icon;
  if (input.icon) {
    icon = packagePath(input.icon); const file = paths.get(icon), ext = posix.extname(icon).slice(1).toLowerCase();
    check(file && ['png', 'jpg', 'jpeg', 'webp'].includes(ext) && file.bytes <= 250000, 400, 'Invalid plugin icon');
    const bytes = Buffer.from(file.content, file.encoding);
    check(ext === 'png' ? bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex')) :
      ext === 'webp' ? bytes.subarray(0, 4).toString() === 'RIFF' && bytes.subarray(8, 12).toString() === 'WEBP' :
        bytes[0] === 255 && bytes[1] === 216, 400, 'Invalid plugin icon bytes');
  }
  const runtime = input.runtime ?? { kind: 'skills-only' };
  check(['node-stdio', 'remote-mcp', 'skills-only'].includes(runtime.kind), 400, 'Unsupported plugin runtime');
  let normalizedRuntime = { kind: runtime.kind };
  if (runtime.kind === 'node-stdio') {
    const entry = packagePath(runtime.entry);
    check(paths.has(entry) && /\.m?js$/.test(entry), 400, 'Plugin entry file is missing');
    normalizedRuntime.entry = entry;
  } else if (runtime.kind === 'remote-mcp') {
    const connector = validateConnector({ ...runtime, id, name: name.en, description: description.en });
    normalizedRuntime = { kind: runtime.kind, url: connector.url, transport: connector.transport, auth: connector.auth };
    check(!runtime.auth?.clientSecret, 400, 'Plugin packages must not contain credentials');
  }
  let auth;
  if (input.auth) {
    check(runtime.kind === 'node-stdio' && !input.auth.clientSecret, 400, 'Application packages must not contain authorization secrets');
    auth = validateConnector({ id, name: name.en, url: 'http://app.invalid/',
      auth: { ...input.auth, clientId: input.auth.clientId || 'unconfigured' } }).auth;
    if (auth.clientId === 'unconfigured') delete auth.clientId;
  }
  const dependencies = input.dependencies ?? {};
  check(dependencies && typeof dependencies === 'object' && !Array.isArray(dependencies) &&
    Object.entries(dependencies).every(([name, version]) => runnerDependencies[name] === version), 400,
  'Bundle additional dependencies with your entry file; the runner provides the documented MCP SDK and Zod versions');
  const network = input.permissions?.network ?? [];
  check(Array.isArray(network) && network.length <= 30 && ['none', undefined].includes(input.permissions?.workspace), 400, 'Invalid plugin permissions');
  const origins = network.map(value => { const url = new URL(connectorUrl(value));
    check(url.pathname === '/', 400, 'Network permissions must be exact origins'); return url.origin; });
  const configuration = [...(input.configuration ?? [])];
  if (auth?.type === 'oauth2') for (const field of [
    { key: 'OAUTH_CLIENT_ID', name: 'OAuth Client ID', required: !auth.clientId, secret: false },
    { key: 'OAUTH_CLIENT_SECRET', name: 'OAuth Client Secret', required: false, secret: true },
  ]) if (!configuration.some(item => item.key === field.key)) configuration.push(field);
  check(Array.isArray(configuration) && configuration.length <= 30, 400, 'Invalid plugin configuration');
  const keys = new Set();
  const fields = configuration.map(field => {
    check(/^[A-Z][A-Z0-9_]{0,63}$/.test(field.key) && !keys.has(field.key) &&
      !/^(NODE_|LD_|DYLD_|GROKBOT_|PATH$|HOME$|SHELL$)/.test(field.key), 400, 'Invalid configuration key'); keys.add(field.key);
    return { key: field.key, name: localized(field.name ?? field.key, 100, 'configuration label'),
      secret: field.secret === true, required: field.required === true };
  });
  check(runtime.kind === 'node-stdio' || !fields.length, 400, 'Remote MCP authorization uses its connector settings');
  const skills = input.skills ?? [], skillIds = new Set();
  check(Array.isArray(skills) && skills.length <= 50, 400, 'Invalid bundled skills');
  const bundled = skills.map(skill => {
    const skillId = packageId(skill.id), path = packagePath(skill.path);
    check(!skillIds.has(skillId) && posix.basename(path) === 'SKILL.md' && paths.get(path)?.encoding === 'utf8', 400, 'Invalid bundled skill');
    skillIds.add(skillId);
    const requiresTools = skill.requiresTools ?? [];
    check(Array.isArray(requiresTools) && requiresTools.length <= 100 && requiresTools.every(name => /^[A-Za-z][\w.-]{0,100}$/.test(name)), 400, 'Invalid skill tool dependencies');
    return { id: skillId, path, name: localized(skill.name ?? skillId, 100, 'skill name'),
      description: localized(skill.description ?? description, 2000, 'skill description'), requiresTools };
  });
  check(runtime.kind !== 'skills-only' || bundled.length > 0, 400, 'Plugin has no tools or skills');
  return { schemaVersion: 1, kind: input.kind, id, version, name, description, publisher, license,
    ...(icon ? { icon } : {}), runtime: normalizedRuntime, ...(auth ? { auth } : {}), dependencies, permissions: { network: [...new Set(origins)], workspace: 'none' },
    configuration: fields, skills: bundled, files };
}

export const pluginDigest = pkg => digest(JSON.stringify({ ...pkg, kind: 'grokbot-app' }));
export function bundledSkills(pkg, enabled) {
  return pkg.skills.map(skill => {
    const prefix = posix.dirname(skill.path), pathPrefix = prefix === '.' ? '' : prefix + '/';
    return { id: `p-${pkg.id.slice(0, 20)}-${skill.id.slice(0, 20)}-${digest(`${pkg.id}/${skill.id}`).slice(0, 8)}`,
      name: skill.name.en, description: skill.description.en, enabled,
      requiresTools: skill.requiresTools.map(tool => `mcp.${pkg.id}.${tool}`),
      files: pkg.files.filter(file => file.path.startsWith(pathPrefix)).map(file => ({ ...file, path: file.path.slice(pathPrefix.length) })) };
  });
}
export function pluginIcon(pkg) {
  const file = pkg.files.find(file => file.path === pkg.icon); if (!file) return null;
  const ext = posix.extname(pkg.icon).slice(1).replace('jpg', 'jpeg');
  return `data:image/${ext};base64,${Buffer.from(file.content, file.encoding).toString('base64')}`;
}

export function validatePluginConfiguration(pkg, input, previous = {}, { requireAll = true } = {}) {
  check(input && typeof input === 'object' && !Array.isArray(input), 400, 'Invalid plugin configuration');
  const allowed = new Set(pkg.configuration.map(field => field.key));
  check(Object.keys(input).every(key => allowed.has(key)), 400, 'Unknown plugin configuration field');
  return Object.fromEntries(pkg.configuration.map(field => {
    const value = input[field.key] === undefined ? previous[field.key] ?? '' : input[field.key];
    check(typeof value === 'string' && value.length <= 16384 && !value.includes('\0'), 400, 'Invalid plugin configuration value');
    check(!requireAll || !field.required || value, 400, `Required plugin setting: ${field.key}`);
    return [field.key, value];
  }));
}
