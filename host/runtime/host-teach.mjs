import { readFile } from 'node:fs/promises';

/** Seed once through the existing catalog owner, preserving edits and disable state. */
export async function provisionTeachSkill(skills) {
  if (skills.list().some(skill => skill.id === 'learn-from-demonstration')) return;
  const files = await Promise.all(['SKILL.md', 'prepare.py'].map(async path => ({ path, encoding: 'utf8',
    content: await readFile(new URL(`./teach-skill/${path}`, import.meta.url), 'utf8') })));
  await skills.publish({ id: 'learn-from-demonstration', name: 'Learn from demonstration',
    description: 'Turn a recorded task into a reusable skill.', files, enabled: true, requiresTools: [] });
}
