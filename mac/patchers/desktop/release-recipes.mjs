import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import path from 'node:path';

const sha = bytes => createHash('sha256').update(bytes).digest('hex');
function relativePath(root, value) {
  if (typeof value !== 'string' || value.includes('\\') || value.split('/').some(p => !p || p === '.' || p === '..') || path.isAbsolute(value))
    throw new Error('Invalid recipe path');
  return path.join(root, value);
}
export function applyByteRecipe(source, recipe) {
  if (recipe.schema !== 'grokbot-bytepatch/v1' || source.length !== recipe.sourceBytes || sha(source) !== recipe.sourceSha256)
    throw new Error('Patch input fingerprint mismatch');
  if (!Number.isSafeInteger(recipe.targetBytes) || recipe.targetBytes < 0 || recipe.targetBytes > 256 * 1024 * 1024)
    throw new Error('Invalid patch target size');
  const chunks = []; let size = 0;
  for (const op of recipe.ops) {
    let chunk;
    if (op[0] === 'copy' && op.length === 3) {
      const [, offset, length] = op;
      if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(length) || offset < 0 || length <= 0 || offset + length > source.length)
        throw new Error('Invalid patch copy range');
      chunk = source.subarray(offset, offset + length);
    } else if (op[0] === 'add' && op.length === 2 && typeof op[1] === 'string') {
      chunk = Buffer.from(op[1], 'base64');
      if (chunk.toString('base64') !== op[1]) throw new Error('Invalid patch addition');
    } else throw new Error('Invalid patch instruction');
    size += chunk.length;
    if (size > recipe.targetBytes) throw new Error('Patch output exceeds declared size');
    chunks.push(chunk);
  }
  const result = Buffer.concat(chunks);
  if (result.length !== recipe.targetBytes || sha(result) !== recipe.targetSha256) throw new Error('Patch output fingerprint mismatch');
  return result;
}
export async function applyReleaseRecipes(unpacked, directory) {
  const manifest = JSON.parse(await readFile(path.join(directory, 'manifest.json'), 'utf8'));
  if (manifest.schema !== 'grokbot-desktop-recipes/v1') throw new Error('Unsupported desktop recipe manifest');
  for (const entry of manifest.files) {
    const filename = relativePath(unpacked, entry.path);
    const source = entry.source === null ? Buffer.alloc(0) : await readFile(relativePath(unpacked, entry.source ?? entry.path));
    if (entry.newFile) {
      try { await readFile(filename); throw new Error('Patch destination already exists'); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    const compressed = await readFile(relativePath(directory, entry.recipe));
    if (sha(compressed) !== entry.sha256) throw new Error('Patch recipe fingerprint mismatch');
    const result = applyByteRecipe(source, JSON.parse(gunzipSync(compressed, { maxOutputLength: 64 * 1024 * 1024 })));
    await mkdir(path.dirname(filename), { recursive: true });
    await writeFile(filename, result);
  }
}
