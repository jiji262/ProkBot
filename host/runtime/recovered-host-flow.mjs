import { constructRecoveredModules } from './recovered-modules.mjs';

export function constructRecoveredHostFlow(library, directory) {
  return constructRecoveredModules(library.hostFlowRecoveryPlan, library.getHostFlowRecoveryBindings(), directory, 'Host flow');
}

export async function installRecoveredHostFlow(library, directory) {
  const constructed = await constructRecoveredHostFlow(library, directory);
  const bindings = library.installRecoveredHostFlow(constructed.bindings);
  return { installed: true, factoryLifetime: 'Once per Host process, before engine/Harness construction',
    bindings, modules: constructed.modules, originalDependencyCount: constructed.originalDependencyCount };
}
