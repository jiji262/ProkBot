import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

/** Recompute cross-family dependencies so factories capture the final callable identities. */
export function combineRecoveryPlans(plans) {
  const modules = plans.flatMap(plan => plan.modules), owners = new Map();
  for (const module of modules) for (const name of [...module.exports, ...module.sharedExports ?? []]) {
    if (owners.has(name)) throw new Error(`Duplicate recovery owner: ${name}`);
    owners.set(name, module.name);
  }
  if (new Set(modules.map(module => module.name)).size !== modules.length) throw new Error('Duplicate recovery module');
  const remaining = modules.map(module => ({ ...module,
    recoveredDependencies: module.dependencies.filter(name => owners.has(name)),
    originalDependencies: module.dependencies.filter(name => !owners.has(name)),
  }));
  const ordered = [], available = new Set();
  while (remaining.length) {
    const index = remaining.findIndex(module => module.recoveredDependencies.every(name => available.has(name)));
    if (index < 0) throw new Error(`Recovery dependency cycle: ${remaining.map(module => module.name).join(', ')}`);
    const [module] = remaining.splice(index, 1);
    ordered.push(module); [...module.exports, ...module.sharedExports ?? []].forEach(name => available.add(name));
  }
  return { modules: ordered };
}

/** Construct shared module closures in dependency order before installing bundle bindings. */
export async function constructRecoveredModules(plan, original, directory, label) {
  const bindings = {}, modules = [];
  for (const module of plan.modules) {
    const dependencies = {};
    for (const name of module.dependencies) {
      const source = module.recoveredDependencies.includes(name) ? bindings : original;
      if (!Object.hasOwn(source, name)) throw new Error(`Unresolved ${label} dependency: ${module.name}/${name}`);
      dependencies[name] = source[name];
    }
    const factory = await import(pathToFileURL(join(directory, module.name)).href);
    const recovered = factory.createRecoveredModule(dependencies);
    for (const name of [...module.exports, ...module.sharedExports ?? []]) {
      if (module.exports.includes(name) ? typeof recovered[name] !== 'function' : recovered[name] === undefined) {
        throw new TypeError(`Invalid ${label} export: ${name}`);
      }
      if (Object.hasOwn(bindings, name)) throw new Error(`Duplicate ${label} binding: ${name}`);
      bindings[name] = recovered[name];
    }
    modules.push({ file: module.name, bindings: module.exports, recoveredDependencies: module.recoveredDependencies,
      ...(module.sharedExports?.length ? { sharedBindings: module.sharedExports } : {}),
      originalDependencyCount: module.originalDependencies.length,
      ...(Object.hasOwn(module, 'splitClass') ? { splitClass: module.splitClass?.className ?? null } : {}) });
  }
  return { bindings, original, modules,
    originalDependencyCount: new Set(plan.modules.flatMap(module => module.originalDependencies)).size };
}
