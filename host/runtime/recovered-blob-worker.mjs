import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { isMainThread, threadId } from 'node:worker_threads';
import { constructRecoveredModules } from './recovered-modules.mjs';

const sourceSha256 = '868572888c71b317c7878b5efc81b029aa99192e3bef7402591759388a6bcf3c';
const hash = bytes => createHash('sha256').update(bytes).digest('hex');

export async function describeRecoveredBlobWorker(state) {
  const provenance = JSON.parse(await readFile(join(state, 'blob-worker-library-provenance.json'), 'utf8'));
  const prepared = await readFile(join(state, 'blob-worker-library.cjs'));
  const entryPath = join(state, 'recovered-worker/agent-isolation/agent-store-worker.cjs');
  if (provenance.sourceSha256 !== sourceSha256 || hash(prepared) !== provenance.sha256 ||
      hash(await readFile(entryPath)) !== provenance.entrySha256) throw new Error('Prepared blob worker provenance mismatch');
  const directory = join(state, 'recovered-core/stable');
  const manifest = JSON.parse(await readFile(join(directory, 'blob-worker-provenance.json'), 'utf8'));
  if (manifest.sourceSha256 !== sourceSha256) throw new Error('Worker modules source mismatch');
  const modules = [];
  for (const module of manifest.modules) {
    if (!/^blob-worker-[\w-]+\.mjs$/.test(module.name)) throw new Error('Invalid worker module name');
    const sha256 = hash(await readFile(join(directory, module.name)));
    modules.push({ file: module.name, sha256, generatedSha256: module.sha256, modified: sha256 !== module.sha256 });
  }
  return { configured: true, sourceSha256, preparedSha256: provenance.sha256, entryPath,
    entrySha256: provenance.entrySha256, moduleBytesSha256: hash(JSON.stringify(modules)),
    bindings: provenance.bindings, sharedBindings: provenance.sharedBindings, modules };
}

export async function loadRecoveredBlobWorker(state) {
  const status = await describeRecoveredBlobWorker(state);
  const library = createRequire(import.meta.url)(join(state, 'blob-worker-library.cjs'));
  const constructed = await constructRecoveredModules(library.blobWorkerRecoveryPlan,
    library.getBlobWorkerRecoveryBindings(), join(state, 'recovered-core/stable'), 'Blob worker');
  library.installRecoveredBlobWorker(constructed.bindings);
  return { library, status: { ...status, installed: true } };
}

export async function startRecoveredBlobWorker(state) {
  if (isMainThread) throw new Error('Recovered blob worker must run in a worker thread');
  const { library, status } = await loadRecoveredBlobWorker(state);
  console.error('[recovered-blob-worker] installed ' + JSON.stringify({ pid: process.pid, threadId,
    preparedSha256: status.preparedSha256, moduleBytesSha256: status.moduleBytesSha256,
    moduleCount: status.modules.length, callableCount: status.bindings.length,
    modifiedModules: status.modules.filter(module => module.modified).map(module => module.file) }));
  library.getBlobWorkerRecoveryBindings().main();
}
