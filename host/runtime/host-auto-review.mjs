import { randomUUID } from 'node:crypto';
import { recordUsage } from './usage-ledger.mjs';

/** Use the shipped classifier policy/schema and approval state machine with the configured model. */
export function createLocalClassifier(config, library, { fetchImpl = globalThis.fetch, log = () => {} } = {}) {
  const tool = library.CLASSIFY_SAND_AUTO_REVIEW_ACTION_TOOL;
  const schema = tool.function.parameters;
  return {
    async execute(ctx, args) {
      const target = args.target?.toJson ? args.target.toJson() : args.target;
      if (!target || typeof target.action !== 'string') throw new Error('Auto-review target is missing');
      const messages = args.conversationContext ?? [];
      const input = {
        trusted_user_instructions: messages.filter(item => item.role === 'user').map(item => item.content),
        untrusted_agent_narration_and_prior_actions: messages.filter(item => item.role !== 'user')
          .map(item => ({ role: item.role, content: item.content })),
        proposed_tool_call: target,
        trusted_auto_run_policy_instructions: target.arguments?.project_permissions?.auto_run ?? {},
      };
      const content = JSON.stringify(input);
      if (Buffer.byteLength(content) > 1024 * 1024) throw new Error('Auto-review context exceeds the supported size');
      const signal = ctx?.signal ? AbortSignal.any([ctx.signal, AbortSignal.timeout(45_000)]) : AbortSignal.timeout(45_000);
      const response = await fetchImpl(`${config.baseUrl.replace(/\/$/, '')}/chat/completions`, {
        method: 'POST', redirect: 'error', signal,
        headers: { 'content-type': 'application/json', authorization: `Bearer ${config.apiKey}` },
        body: JSON.stringify({ model: config.model, stream: false, max_tokens: 4096,
          messages: [{ role: 'system', content: library.SAND_AUTO_REVIEW_CLASSIFIER_SYSTEM_PROMPT },
            { role: 'user', content }], tools: [tool],
          tool_choice: { type: 'function', function: { name: tool.function.name } }, parallel_tool_calls: false }),
      });
      if (!response.ok) {
        await response.body?.cancel();
        throw new Error(`Auto-review model returned HTTP ${response.status}`);
      }
      const reply = await response.json();
      await recordUsage(config.usageDirectory, { raw: reply.usage, model: reply.model ?? config.model, kind: 'review', requestId: reply.id });
      const calls = reply.choices?.[0]?.message?.tool_calls;
      if (reply.choices?.[0]?.finish_reason === 'length' || calls?.length !== 1 || calls[0].function?.name !== tool.function.name)
        throw new Error('Auto-review model did not return one complete classification');
      let decision;
      try { decision = JSON.parse(calls[0].function.arguments); }
      catch { throw new Error('Auto-review model returned invalid JSON'); }
      if (!decision || typeof decision !== 'object' || Array.isArray(decision)) throw new Error('Invalid auto-review classification');
      for (const name of schema.required) {
        if (typeof decision[name] !== 'string' || !decision[name].trim() ||
          (schema.properties[name].enum && !schema.properties[name].enum.includes(decision[name])))
          throw new Error(`Invalid auto-review classification field: ${name}`);
      }
      if (decision.decision === 'BLOCK' && decision.blocked_effect === 'none')
        throw new Error('Auto-review returned an inconsistent decision');
      const outbound = ['outbound_or_binding_external_effect', 'data_or_credential_exfiltration'].includes(decision.blocked_effect);
      if (decision.decision === 'BLOCK' && outbound &&
        (decision.outbound_authorization !== 'unauthorized_destination' || !decision.who_sees_it?.trim()))
        throw new Error('Auto-review returned an incomplete outbound decision');
      const proposedRule = decision.proposed_allow_rule;
      if (proposedRule !== undefined && typeof proposedRule !== 'string') throw new Error('Invalid auto-review proposed rule');
      log(`Local auto-review ${decision.decision}; model=${config.model}; request=${String(reply.id ?? 'unavailable').slice(0, 128)}`);
      return new library.SmartModeClassifierResult({ result: { case: 'success', value: {
        decision: decision.decision === 'ALLOW' ? 1 : 2,
        ...(decision.decision === 'BLOCK' ? { blockReason: decision.reason.slice(0, 500) } : {}),
        ...(decision.decision === 'BLOCK' && proposedRule ? { proposedAllowRule: proposedRule.slice(0, 500) } : {}),
      } } });
    },
  };
}

export function startLocalAutoReview(context, library, config) {
  const service = new library.AutoReviewService({
    auth: context.deps.auth,
    experiments: { checkFeatureGate: () => true },
    settings: context.deps.settings,
    telemetry: context.deps.telemetry.logs,
    awaitingSink: context.deps.transcript.createAwaitingStateSink(),
    transcript: context.deps.transcript,
    hostGeneration: randomUUID(), localMode: 'enforce',
    createClassifierExecutor: () => createLocalClassifier(config, library, { log: message => context.host.log(message) }),
  });
  context.onStop(() => service.stop());
  const startedAt = Date.now();
  const sweep = () => service.sweepStaleAwaitingBadges(() => context.deps.transcript.listAgentIds(), startedAt);
  void context.deps.transcript.expireAllPendingAutoReviewApprovalCards().then(sweep, sweep);
  return service;
}
