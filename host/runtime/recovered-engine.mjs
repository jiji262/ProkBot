import { constructRecoveredModules } from './recovered-modules.mjs';

export function constructRecoveredEngine(library, directory) {
  return constructRecoveredModules(library.engineRecoveryPlan, library.getEngineRecoveryBindings(), directory, 'Engine');
}

export async function installRecoveredEngine(library, directory) {
  const constructed = await constructRecoveredEngine(library, directory);
  const bindings = library.installRecoveredEngine(constructed.bindings);
  return { installed: true, factoryLifetime: 'Once per Host process, before Harness construction',
    bindings, modules: constructed.modules, originalDependencyCount: constructed.originalDependencyCount };
}
