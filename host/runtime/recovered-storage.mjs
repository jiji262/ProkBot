import { constructRecoveredModules } from './recovered-modules.mjs';

export async function installRecoveredStorage(library, directory) {
  const constructed = await constructRecoveredModules(library.storageRecoveryPlan,
    library.getStorageRecoveryBindings(), directory, 'Storage');
  const bindings = library.installRecoveredStorage(constructed.bindings);
  return { installed: true,
    factoryLifetime: 'Once per Host process, after Host flow and before engine and service construction',
    bindings, sharedBindings: library.storageRecoveryPlan.modules.flatMap(module => module.sharedExports ?? []),
    modules: constructed.modules, originalDependencyCount: constructed.originalDependencyCount };
}
