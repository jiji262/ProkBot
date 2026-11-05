import { createHash } from 'node:crypto';
import { readFile, cp, mkdir } from 'node:fs/promises';
import { join } from 'node:path';

// These outputs are generated locally from the user's original Host.
export async function prepareHostReliability(stateDirectory) {
  const seed = new URL('../../seed/release-reliability/', import.meta.url);
  const manifest = JSON.parse(await readFile(new URL('manifest.json', seed), 'utf8'));
  const directory = join(stateDirectory, 'reliable-core', manifest.digest.slice(0, 20));
  await mkdir(directory, { recursive: true });
  for (const file of manifest.files) {
    const bytes = await readFile(new URL(file.name, seed));
    if (createHash('sha256').update(bytes).digest('hex') !== file.sha256)
      throw new Error('Prepared runtime integrity failure: ' + file.name);
    await cp(new URL(file.name, seed), file.name === 'host-library-reliable.cjs'
      ? join(stateDirectory, file.name) : join(directory, file.name));
  }
  return { directory, libraryPath: join(stateDirectory, 'host-library-reliable.cjs'), status: manifest.status };
}
