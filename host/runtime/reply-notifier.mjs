/** Emit complete replies through the original preference gate and push sender.
 * Foreground suppression belongs to each destination device, not the shared Bot.
 */
import { notificationTransition, DEFAULT_NOTIFICATION_FREQUENCY } from '../clients/shared/notification-frequency.mjs';

export function createReplyNotifier(library, notify, { getFrequency = () => DEFAULT_NOTIFICATION_FREQUENCY } = {}) {
  const notifier = new library.SandMobilePushNotifier({ notify });
  const decider = notifier.decider;
  decider.throttleWindowMs = 0;
  const snapshots = new Map(), seen = new Map(), pending = [];
  let seeded = false;
  const snapshot = agent => ({ ...agent,
    awaitingReason: agent.awaitingUserResponse?.reason ?? null,
    awaitingReasonCopy: agent.awaitingUserResponse?.reasonCopy ?? null,
    notifyEnabled: agent.notifyOnUpdatesEnabled === true,
    isHiddenFromSidebar: agent.isHiddenFromSidebar === true });
  function account(agent) {
    if (!agent.lastMessageId) return;
    const history = seen.get(agent.id) ?? new Set();
    history.add(agent.lastMessageId);
    if (history.size > 256) history.delete(history.values().next().value);
    seen.set(agent.id, history);
  }
  function accept(agent) {
    const before = snapshots.get(agent.id), next = snapshot(agent);
    if (before?.snapshotEpoch === next.snapshotEpoch && Number.isFinite(next.snapshotSeq) &&
        Number.isFinite(before?.snapshotSeq) && next.snapshotSeq <= before.snapshotSeq) return;
    snapshots.set(agent.id, next);
    if (!before) { decider.seedBaseline([next]); account(next); return; }
    const transition = notificationTransition(before, next, getFrequency());
    if (!transition) return;
    if (transition.kind === 'agent-done' && (!next.lastMessageId || seen.get(next.id)?.has(next.lastMessageId))) return;
    account(next);
    for (const decision of decider.gateTransitions([transition], { isWindowFocused: false, nowMs: Date.now() }))
      if (decision.verdict === 'deliver') notifier.fire(decision.transition);
  }
  function ingest(agents) {
    if (!seeded) { pending.push(...agents); return; }
    for (const agent of agents) accept(agent);
  }
  return {
    seedBaseline(agents) {
      for (const agent of agents) if (!snapshots.has(agent.id)) {
        const value = snapshot(agent); snapshots.set(agent.id, value); account(value);
        decider.seedBaseline([value]);
      }
      seeded = true;
      for (const agent of pending.splice(0)) accept(agent);
    },
    handleAgentsEvent: event => ingest(event.agents),
    handleAgentUpsertedEvent: event => ingest([event.agent]),
    forget(id) { snapshots.delete(id); seen.delete(id); decider.forget(id); },
  };
}
