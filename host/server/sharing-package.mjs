import { check } from './security.mjs';
import { packageId, textField, digest } from './package-files.mjs';
import { validateSkill } from './skills.mjs';
import { decodeSharingZip, encodeSharingZip } from './sharing-zip.mjs';

const array = (value, maximum = 100) => { check(Array.isArray(value) && value.length <= maximum, 400, 'Invalid package list'); return value; };
const object = value => { check(value && typeof value === 'object' && !Array.isArray(value), 400, 'Invalid package object'); return value; };
const text = (value, limit, label) => textField(value, limit, label);
const optional = (value, limit, label) => value == null || value === '' ? undefined : text(value, limit, label);
const secretPattern = /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|\b(?:sk-[A-Za-z0-9_-]{20,}|apikey_[a-f0-9_]{40,}|gh[pousr]_[A-Za-z0-9]{24,})\b/;
export function assertShareableText(value) {
  check(!secretPattern.test(value), 400, 'Remove credentials before sharing');
}

/** Deliberate allowlist: never serializes a Bot record, execution config or database. */
export function normalizeRecipe(input) {
  object(input); const p = object(input.profile);
  const profile = { name: text(p.name, 100, 'Bot name'), title: text(p.title || p.name, 200, 'Bot title'),
    description: text(p.description, 30_000, 'Bot description') };
  for (const key of ['avatarShape', 'avatarColor']) if (p[key]) {
    check(typeof p[key] === 'string' && /^[a-zA-Z0-9_-]{1,80}$/.test(p[key]), 400, 'Invalid Bot avatar'); profile[key] = p[key];
  }
  const memory = array(input.memory ?? [], 500).map(object).map(item => ({
    kind: item.kind === 'profile' ? 'profile' : 'log',
    ...(typeof item.createdAt === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(item.createdAt) ? { createdAt: item.createdAt } : {}),
    content: text(item.content, 20_000, 'memory'),
  }));
  const skills = array(input.skills ?? []).map(object).map(item => ({ name: text(item.name, 100, 'skill name'),
    description: text(item.description || item.name, 2000, 'skill description'), content: text(item.content, 200_000, 'skill content') }));
  const routines = array(input.routines ?? []).map(object).map(item => ({
    name: text(item.name || item.slug, 100, 'routine name'), slug: packageId(item.slug),
    description: text(item.description || item.name || item.slug, 2000, 'routine description'),
    content: text(item.content, 30_000, 'routine content'),
    ...(item.schedule ? { schedule: text(item.schedule, 200, 'routine schedule') } : {}),
    isEnabled: false,
  }));
  const plugins = array(input.plugins ?? []).map(object).map(item => ({ pluginId: text(item.pluginId, 100, 'plugin ID'),
    name: text(item.name || item.pluginId, 100, 'plugin name'),
    ...(optional(item.description, 2000, 'plugin description') ? { description: item.description.trim() } : {}),
    ...(optional(item.version, 80, 'plugin version') ? { version: item.version.trim() } : {}),
  }));
  const recipe = { profile, memory, skills, routines, plugins }; assertShareableText(JSON.stringify(recipe));
  check(Buffer.byteLength(JSON.stringify(recipe)) <= 10 * 1024 * 1024, 413, 'Bot recipe exceeds size limit'); return recipe;
}

export function normalizeSharePackage(input) {
  check(input?.schemaVersion === 1 && ['bot', 'skill'].includes(input.kind), 400, 'Unsupported sharing package');
  let content;
  if (input.kind === 'bot') content = normalizeRecipe(input.content);
  else {
    content = validateSkill(input.content);
    for (const file of content.files) {
      check(!/(?:^|\/)(?:\.env(?:\..*)?|.*\.(?:db|sqlite|sqlite3|key|p8|p12|mobileprovision)|credentials?\.json|cookies?\.json)$/i.test(file.path), 400, 'Credential or database files cannot be shared');
      assertShareableText(Buffer.from(file.content, file.encoding).toString('utf8'));
    }
  }
  const dependencies = array(input.dependencies ?? []).map(object).map(item => ({
    pluginId: text(item.pluginId, 100, 'plugin ID'), name: text(item.name || item.pluginId, 100, 'plugin name'),
    ...(optional(item.version, 80, 'plugin version') ? { version: item.version.trim() } : {}),
    tools: array(item.tools ?? []).map(tool => text(tool, 200, 'tool name')),
  }));
  const value = { schemaVersion: 1, kind: input.kind, content, dependencies };
  assertShareableText(JSON.stringify(value)); return value;
}

export function packShare(value) {
  const normalized = normalizeSharePackage(value), files = {};
  if (normalized.kind === 'skill') {
    normalized.content.files = normalized.content.files.map(file => {
      const path = `skill/${file.path}`; files[path] = Buffer.from(file.content, file.encoding);
      return { path: file.path, entry: path, encoding: file.encoding, sha256: digest(files[path]) };
    });
  }
  files['package.json'] = JSON.stringify(normalized, null, 2) + '\n'; return encodeSharingZip(files);
}

export function unpackShare(bytes) {
  const files = decodeSharingZip(bytes); check(files['package.json'], 400, 'package.json is required');
  let manifest; try { manifest = JSON.parse(files['package.json'].toString('utf8')); } catch { check(false, 400, 'Invalid package.json'); }
  object(manifest); object(manifest.content);
  const expected = new Set(['package.json']);
  if (manifest.kind === 'skill') {
    manifest.content.files = array(manifest.content.files, 255).map(object).map(file => {
      const entry = `skill/${file.path}`; check(file.entry === entry && files[entry] && !expected.has(entry), 400, 'Invalid skill archive entry');
      expected.add(entry); check(file.sha256 === digest(files[entry]), 400, 'Skill file checksum mismatch');
      check(['utf8', 'base64'].includes(file.encoding), 400, 'Invalid skill encoding');
      return { path: file.path, encoding: file.encoding, content: files[entry].toString(file.encoding) };
    });
  }
  check(Object.keys(files).length === expected.size, 400, 'Unexpected archive files');
  return normalizeSharePackage(manifest);
}

export const shareDigest = value => digest(JSON.stringify(normalizeSharePackage(value)));
