import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { constructRecoveredModules } from './recovered-modules.mjs';
import { describeRecoveredBlobWorker } from './recovered-blob-worker.mjs';

export async function installRecoveredWorkerPool(library, directory) {
  const state = resolve(directory, '../..');
  const blobWorker = await describeRecoveredBlobWorker(state);
  const original = library.getWorkerPoolRecoveryBindings();
  const dependencies = { ...original,
    __import_meta_url: pathToFileURL(join(state, 'recovered-worker/host-anchor.cjs')).href };
  const constructed = await constructRecoveredModules(library.workerPoolRecoveryPlan, dependencies, directory, 'Worker pool');
  const bindings = library.installRecoveredWorkerPool(constructed.bindings);
  return { installed: true, bindings, modules: constructed.modules,
    originalDependencyCount: constructed.originalDependencyCount,
    workerEntryAnchor: dependencies.__import_meta_url, blobWorker };
}
