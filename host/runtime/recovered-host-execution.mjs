import { combineRecoveryPlans, constructRecoveredModules } from './recovered-modules.mjs';
import { withLocalLibraryRunner } from './host-library-files.mjs';

export async function installRecoveredHostExecutionAndSession(library, directory) {
  const plans = [library.hostExecutionRecoveryPlan, library.hostSessionRecoveryPlan];
  const original = library.getHostExecutionRecoveryBindings();
  for (const [name, value] of Object.entries(library.getHostSessionRecoveryBindings())) {
    if (Object.hasOwn(original, name) && original[name] !== value) throw new Error(`Inconsistent recovery identity: ${name}`);
    original[name] = value;
  }
  const plan = combineRecoveryPlans(plans);
  original.SandAgentRunner = withLocalLibraryRunner(original.SandAgentRunner, library);
  const constructed = await constructRecoveredModules(plan, original, directory, 'Host execution/session');
  // Both groups are validated and constructed before changing either bundle group.
  const sessionBindings = library.installRecoveredHostSession(constructed.bindings);
  const executionBindings = library.installRecoveredHostExecution(constructed.bindings);
  const describe = (source, bindings) => {
    const files = new Set(source.modules.map(module => module.name));
    const modules = constructed.modules.filter(module => files.has(module.file));
    return { installed: true, factoryLifetime: 'Once per Host process, jointly ordered after Harness and before SandHost construction',
      bindings, modules, originalDependencyCount: new Set(plan.modules.filter(module => files.has(module.name))
        .flatMap(module => module.originalDependencies)).size };
  };
  return { hostExecution: describe(plans[0], executionBindings), hostSession: describe(plans[1], sessionBindings),
    jointFactoryOrder: plan.modules.map(module => module.name) };
}
