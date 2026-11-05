import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join, basename } from 'node:path';
import { pathToFileURL } from 'node:url';
import { installRecoveredHarness } from './recovered-harness.mjs';
import { installRecoveredEngine } from './recovered-engine.mjs';
import { installRecoveredHostFlow } from './recovered-host-flow.mjs';
import { installRecoveredHostExecutionAndSession } from './recovered-host-execution.mjs';
import { installRecoveredComputer } from './recovered-computer.mjs';
import { installRecoveredWorkerPool } from './recovered-worker-pool.mjs';
import { installRecoveredStorage } from './recovered-storage.mjs';
import { installRecoveredPromptTools } from './recovered-prompt-tools.mjs';
import { installRecoveredHostKernel } from './recovered-host-kernel.mjs';
import { installRecoveredToolFramework } from './recovered-tool-framework.mjs';

/** Install editable recovery modules before any Host service is constructed. */
export async function loadRecoveredHostCore(library, directory) {
  const modules = [];
  for (const filename of ['provenance.json', 'acceptance-provenance.json', 'handoff-provenance.json', 'host-flow-provenance.json', 'storage-provenance.json', 'worker-pool-provenance.json', 'tool-framework-provenance.json', 'engine-provenance.json', 'computer-provenance.json', 'prompt-tools-provenance.json', 'harness-provenance.json', 'host-execution-provenance.json', 'host-session-provenance.json', 'host-kernel-provenance.json']) {
    const manifest = JSON.parse(await readFile(join(directory, filename), 'utf8'));
    if (manifest.sourceSha256 !== 'd7ffb02b831337f6e4618a2604fb6ecd00a7f75f4c4bf96f5075f54d473b7f67') {
      throw new Error(`Unexpected recovered source: ${filename}`);
    }
    for (const entry of manifest.modules) {
      if (basename(entry.name) !== entry.name) throw new Error('Invalid recovered module filename');
      const bytes = await readFile(join(directory, entry.name));
      const sha256 = createHash('sha256').update(bytes).digest('hex');
      modules.push({ file: entry.name, sha256, generatedSha256: entry.sha256, modified: sha256 !== entry.sha256 });
    }
  }
  const load = name => import(pathToFileURL(join(directory, name)).href);
  const [scheduler, acceptance, handoff] = await Promise.all([
    load('run-scheduler.mjs'), load('prompt-acceptance.mjs'), load('box-handoff.mjs'),
  ]);
  handoff.configureBoxHandoffProtocol({ computerUseExecutorResource: library.computerUseExecutorResource,
    ComputerUseArgs: library.ComputerUseArgs, ComputerUseAction: library.ComputerUseAction,
    ScreenshotAction: library.ScreenshotAction });
  acceptance.configureAcceptanceRuntime({ PromptAcceptanceRejectedError: library.PromptAcceptanceRejectedError,
    PromptAcceptanceDigestMismatchError: library.PromptAcceptanceDigestMismatchError,
    reportHostDiagnostic: library.reportHostDiagnostic });
  const bindings = library.installRecoveredCore({ SandRunScheduler: scheduler.SandRunScheduler,
    PromptAcceptanceLedger: acceptance.PromptAcceptanceLedger, BoxHandoffService: handoff.BoxHandoffService });
  const hostFlow = await installRecoveredHostFlow(library, directory);
  const storage = await installRecoveredStorage(library, directory);
  const { blobWorker, ...workerPool } = await installRecoveredWorkerPool(library, directory);
  const toolFramework = await installRecoveredToolFramework(library, directory);
  const engine = await installRecoveredEngine(library, directory);
  const computer = await installRecoveredComputer(library, directory);
  const promptTools = await installRecoveredPromptTools(library, directory);
  const harness = await installRecoveredHarness(library, directory);
  const { hostExecution, hostSession, jointFactoryOrder } = await installRecoveredHostExecutionAndSession(library, directory);
  const hostKernel = await installRecoveredHostKernel(library, directory);
  return { mode: 'recovered', directory, bindings: [...bindings, ...hostFlow.bindings, ...storage.bindings, ...workerPool.bindings, ...toolFramework.bindings, ...engine.bindings, ...computer.bindings, ...promptTools.bindings, ...harness.bindings, ...hostExecution.bindings, ...hostSession.bindings, ...hostKernel.bindings],
    modules: [...modules, ...blobWorker.modules], hostFlow, storage, workerPool, blobWorker, toolFramework, engine, computer, promptTools, harness, hostExecution, hostSession, hostKernel, jointFactoryOrder };
}
