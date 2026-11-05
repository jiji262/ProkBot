import { constructRecoveredModules } from './recovered-modules.mjs';

export async function installRecoveredHostKernel(library, directory) {
  const constructed = await constructRecoveredModules(library.hostKernelRecoveryPlan,
    library.getHostKernelRecoveryBindings(), directory, 'Host kernel');
  const bindings = library.installRecoveredHostKernel(constructed.bindings);
  return { installed: true, bindings,
    sharedBindings: library.hostKernelRecoveryPlan.modules.flatMap(module => module.sharedExports ?? []),
    modules: constructed.modules, originalDependencyCount: constructed.originalDependencyCount };
}
