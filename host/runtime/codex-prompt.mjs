/** Applied to both standard and slim prompt sections; official CloudAgent stays disabled. */
export const codexCodingGuidance = [
  'For non-trivial coding work (implementing features, fixing bugs, refactoring, or broad repository investigation), delegate to Codex on a connected Mac. Discover the paired Mac codex_start, codex_status, codex_continue, codex_cancel and codex_list tools through your dynamic MCP tool catalog. The official CloudAgent service is not used.',
  'Pass a clear task, relevant context, constraints and success criteria. Use an existing absolute project directory on the selected Mac, or omit cwd for a new isolated project. Codex uses the account and default model configured on that Mac. It may obtain a repository checkout inside the task directory when required by the user’s coding request.',
  'codex_start returns a job ID before the task finishes. Use codex_status with waitMs:25000 to wait for progress and completion; keep the user informed and do not report success until status is completed and the result is checked. Continue the same job with codex_continue for follow-up work. Use codex_cancel when the user stops it. A disconnected Mac or interrupted task is not a completed task.',
  'Keep the returned Mac, job and project identifiers together. Jobs and results belong to this Bot on that Mac. When Codex requests user input, ask the user and supply their actual answers. Mac local execution permissions still apply. If no Codex-capable Mac is connected, explain that it must be connected or Codex installed/signed in; do not substitute an unavailable official CloudAgent or launch Codex through a shell command.',
];

export function localCodexSection(section, options) {
  if (options.cloudAgentsEnabled) return section;
  if (section.heading === '## Code changes') return { ...section, body: [...codexCodingGuidance] };
  if (section.heading !== '## Where you work') return section;
  return { ...section, body: section.body.map(line => {
    if (!line.includes('Repository work')) return line;
    return line.slice(0, line.indexOf('Repository work')) + 'Repository coding work uses the connected Mac Codex tools described in Code changes.';
  }) };
}

export function localCodexSections(sections, options) { return sections.map(section => localCodexSection(section, options)); }

export function localCodexEdits(edits, options) {
  if (options.cloudAgentsEnabled) return edits;
  const updated = new Map(edits);
  updated.set('## Code changes', { kind: 'replace', body: [...codexCodingGuidance] });
  const where = updated.get('## Where you work');
  if (where?.body) updated.set('## Where you work', localCodexSection({ ...where, heading: '## Where you work' }, options));
  return updated;
}
