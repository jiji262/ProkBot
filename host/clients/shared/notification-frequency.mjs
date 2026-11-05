export const DEFAULT_NOTIFICATION_FREQUENCY = 'every-reply';
export const NOTIFICATION_FREQUENCIES = ['every-reply', 'task-complete'];

/** Select a transition before the original preference/focus/deduplication gate. */
export function notificationTransition(before, next, frequency = DEFAULT_NOTIFICATION_FREQUENCY) {
  if (!before) return null;
  const attention = next.awaitingReason != null && next.awaitingReason !== before.awaitingReason;
  const newReply = next.lastMessageId != null && next.lastMessageId !== before.lastMessageId;
  const completed = before.isRunning && !next.isRunning && next.awaitingReason == null;
  if (!attention && (frequency === 'task-complete'
    ? next.isRunning || next.awaitingReason != null || (!newReply && !completed)
    : !newReply)) return null;
  return { ...next, agentId: next.id, agentName: next.name,
    kind: attention ? 'agent-needs-input' : 'agent-done',
    reason: attention ? next.awaitingReason : null,
    reasonCopy: attention ? next.awaitingReasonCopy : null };
}
