import { constructRecoveredModules } from './recovered-modules.mjs';
import { installRemoteBoxAdapter } from './remote-box.mjs';

export async function installRecoveredComputer(library, directory) {
  const original = library.getComputerRecoveryBindings();
  const constructed = await constructRecoveredModules(library.computerRecoveryPlan,
    original, directory, 'Computer/Box');
  const deployment = installRemoteBoxAdapter(constructed.bindings, original);
  const bindings = library.installRecoveredComputer(constructed.bindings);
  return { installed: true, factoryLifetime: 'Once per Host process, before Harness and Host construction',
    bindings, sharedBindings: library.computerRecoveryPlan.modules.flatMap(module => module.sharedExports ?? []),
    modules: constructed.modules, originalDependencyCount: constructed.originalDependencyCount, deployment };
}
