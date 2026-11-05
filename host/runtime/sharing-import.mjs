import { join } from 'node:path';
import { readJson, writePrivate } from '../server/storage.mjs';
import { check } from '../server/security.mjs';
import { normalizeRecipe, shareDigest } from '../server/sharing-package.mjs';

/** The importer uses the shipped transcript, skills, automation and memory stores. */
export function decorateLocalSharingApi({ api, host, dataDir = process.env.GROKBOT_DATA_DIR ?? process.env.GROKBOT_STATE_DIR }) {
  const active = new Map();
  async function perform({ agentId, recipe: input, digest }) {
    check(typeof agentId === 'string' && /^[a-f0-9]{8}-[a-f0-9-]{27}$/i.test(agentId), 400, 'Invalid imported Bot ID');
    check(typeof digest === 'string' && /^[a-f0-9]{64}$/.test(digest), 400, 'Invalid package digest');
    const recipe = normalizeRecipe(input), contentDigest = shareDigest({ schemaVersion: 1, kind: 'bot', content: recipe });
    const path = join(dataDir, 'sharing-imports', `${agentId}.json`);
    let state = await readJson(path, null);
    const manager = host.transcript, existing = manager.listAgentsSync().find(agent => agent.id === agentId);
    if (state) check(state.digest === digest && state.contentDigest === contentDigest, 409, 'Imported Bot belongs to another package');
    else {
      check(!existing, 409, 'Bot ID already exists');
      state = { digest, contentDigest, skills: [], routines: [], memories: [], status: 'pending' };
      await writePrivate(path, JSON.stringify(state));
    }
    if (state.status === 'complete') {
      check(existing, 410, 'Imported Bot was deleted');
      return { agent: existing, transcript: await manager.getAgentTranscript(agentId), imported: true };
    }
    let created = existing ? { agent: existing } : await manager.createAgent(recipe.profile, 'user', { agentId, isIntroductionSuppressed: true });
    // Each import has a fresh identity. A failed setup is retained for the same request to resume.
    for (const [index, skill] of recipe.skills.entries()) if (!state.skills.includes(index)) {
      // Original recipes contain a serialized SKILL.md. Keep its prose while discarding
      // imported frontmatter fields such as live source references and triggers.
      const body = skill.content.replace(/^\s*---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/, '').trim();
      check(body, 400, 'Skill body is empty');
      const markdown = `---\nname: ${JSON.stringify(skill.name)}\ndescription: ${JSON.stringify(skill.description)}\n---\n\n${body}\n`;
      const prior = await manager.getAgentWorkflows(agentId);
      if (!prior.some(item => item.name === skill.name && item.body?.trim() === body)) {
        const result = await manager.importAgentSkillMarkdown(agentId, markdown, skill.name);
        check(result.result?.imported?.length > 0, 422, 'Skill could not be imported');
      }
      state.skills.push(index); await writePrivate(path, JSON.stringify(state));
    }
    for (const [index, routine] of recipe.routines.entries()) if (!state.routines.includes(index)) {
      const prior = await manager.getAgentAutomations(agentId);
      const found = prior.find(item => item.name === routine.name && item.prompt === routine.content);
      if (!found) {
        const result = await manager.createAgentAutomation(agentId, { name: routine.name, prompt: routine.content,
          trigger: routine.schedule ? { type: 'cron', schedule: routine.schedule } : { type: 'webhook' }, isEnabled: false }, 'user');
        check(result.length > prior.length, 422, 'Routine could not be imported');
      } else if (found.isEnabled) await manager.setAgentAutomationEnabled(agentId, found.id, false);
      state.routines.push(index); await writePrivate(path, JSON.stringify(state));
    }
    const memory = host.requireHostExtensions().api('memory');
    const store = memory.createAgentStore(join(memory.options.agentsRootDir, agentId));
    try {
      for (const [index, item] of recipe.memory.entries()) if (!state.memories.includes(index)) {
        const parsed = item.createdAt ? Date.parse(`${item.createdAt}T00:00:00Z`) : Date.now();
        store.addMemory(item.content, Number.isFinite(parsed) ? parsed : Date.now(), item.kind);
        state.memories.push(index); await writePrivate(path, JSON.stringify(state));
      }
    } finally { store.setOnChange?.(undefined); }
    state.status = 'complete'; await writePrivate(path, JSON.stringify(state));
    return { agent: created.agent, transcript: await manager.getAgentTranscript(agentId), imported: true };
  }
  return { ...api, getAgentWorkflows: async args => {
    const [workflows, shares] = await Promise.all([api.getAgentWorkflows(args), readJson(join(dataDir, 'sharing.json'), { items: [] })]);
    const published = new Map(shares.items.filter(item => item.kind === 'skill' && item.activeVersion != null)
      .map(item => [item.workflowId, item.id]));
    return workflows.map(skill => published.has(skill.id) ? { ...skill, source: 'plugin',
      pluginId: published.get(skill.id), publishedByCurrentUser: true, shareUrl: "/admin?view=sharing" } : skill);
  }, importLocalSharedBot: args => {
    if (active.has(args.agentId)) return active.get(args.agentId);
    const promise = perform(args).finally(() => active.delete(args.agentId)); active.set(args.agentId, promise); return promise;
  } };
}
