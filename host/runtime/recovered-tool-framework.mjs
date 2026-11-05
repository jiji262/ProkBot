import { constructRecoveredModules } from './recovered-modules.mjs';

export async function installRecoveredToolFramework(library, directory) {
  const constructed = await constructRecoveredModules(library.toolFrameworkRecoveryPlan,
    library.getToolFrameworkRecoveryBindings(), directory, 'Tool framework');
  const bindings = library.installRecoveredToolFramework(constructed.bindings);
  return { installed: true, bindings,
    sharedBindings: library.toolFrameworkRecoveryPlan.modules.flatMap(module => module.sharedExports ?? []),
    modules: constructed.modules, originalDependencyCount: constructed.originalDependencyCount };
}
