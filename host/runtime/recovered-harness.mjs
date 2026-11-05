import { constructRecoveredModules } from './recovered-modules.mjs';

export function constructRecoveredHarness(library, directory) {
  return constructRecoveredModules(library.harnessRecoveryPlan, library.getHarnessRecoveryBindings(), directory, 'Harness');
}

export async function installRecoveredHarness(library, directory) {
  const constructed = await constructRecoveredHarness(library, directory);
  const bindings = library.installRecoveredHarness(constructed.bindings);
  return { installed: true, factoryLifetime: 'One instance of each module per Host process',
    bindings, modules: constructed.modules, originalDependencyCount: constructed.originalDependencyCount };
}
