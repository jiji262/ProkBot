import { grokText } from './i18n.mjs';
import { readFile, writeFile, rename } from 'node:fs/promises';
import path from 'node:path';
import { subscribe } from './streams.mjs';
import { NotificationDecider } from './notification-policy.mjs';
import { notificationTransition, DEFAULT_NOTIFICATION_FREQUENCY, NOTIFICATION_FREQUENCIES } from '../shared/notification-frequency.mjs';

export function agentFromLink(link) {
  try {
    if (typeof link !== 'string' || !/^grokbot-local:\/\/agent\/[a-zA-Z0-9_-]{1,128}$/.test(link)) return null;
    const url = new URL(link);
    if (url.protocol !== 'grokbot-local:' || url.hostname !== 'agent' || url.search || url.hash) return null;
    return decodeURIComponent(url.pathname.slice(1));
  } catch { return null; }
}
export function notificationAgent(agent) {
  return { id: agent.id, name: agent.name, purpose: agent.purpose, isGroup: agent.isGroup,
    isRunning: agent.isRunning, awaitingReason: agent.awaitingUserResponse?.reason ?? null,
    awaitingReasonCopy: agent.awaitingUserResponse?.reasonCopy ?? null,
    notifyEnabled: agent.notifyOnUpdatesEnabled === true, isHiddenFromSidebar: agent.isHiddenFromSidebar === true,
    memberIds: agent.memberIds, lastMessageAuthorId: agent.lastMessageAuthorId ?? null,
    lastMessageId: agent.lastMessageId ?? null, lastMessageTaskId: agent.lastMessageTaskId,
    lastMessagePreview: agent.lastMessagePreview ?? null, lastMessagePreviewSource: agent.lastMessagePreviewSource ?? null,
    pushMessageContent: agent.pushMessageContent ?? null };
}
function summary(value) {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim();
  const segments = [...new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(text)];
  return segments.length > 140 ? segments.slice(0,139).map(item => item.segment).join('') + '…' : text;
}
export async function createNotifications({ config, profile, Notification, openAgent, onUnauthorized,
  sounds, command, getWindow, reportDecision = () => {}, now = Date.now }) {
  const filename = path.join(profile, 'notifications.json');
  let preferences = { sound: 'ping-1-open-blip', playSound: true };
  try { preferences = { ...preferences, ...JSON.parse(await readFile(filename, 'utf8')).preferences }; } catch {}
  let writes = Promise.resolve(), serial = Promise.resolve(), viewedAgentId = null, seeded = false, stopped = false;
  const pending = [], active = new Set(), timestamps = new Map(), snapshots = new Map();
  let frequency = DEFAULT_NOTIFICATION_FREQUENCY, settingsReady = false;
  const decider = new NotificationDecider(0, 'message-history');
  const persist = () => {
    const snapshot = JSON.stringify({ version: 2, preferences });
    writes = writes.catch(() => {}).then(async () => {
      await writeFile(`${filename}.tmp`, snapshot, { mode: 0o600 }); await rename(`${filename}.tmp`, filename);
    }); return writes;
  };
  const focus = () => {
    const window = getWindow?.();
    return window && !window.isDestroyed() && window.isVisible() && window.isFocused()
      ? { kind: 'whole_app' } : { kind: 'unfocused' };
  };
  const accept = agent => {
    if (!agent || typeof agent.id !== 'string' || stopped) return;
    const previous = timestamps.get(agent.id);
    if (previous && previous.epoch === agent.snapshotEpoch && Number.isFinite(previous.seq) && previous.seq >= agent.snapshotSeq) return;
    timestamps.set(agent.id, { epoch: agent.snapshotEpoch, seq: agent.snapshotSeq });
    const next = notificationAgent(agent), before = snapshots.get(agent.id);
    snapshots.set(agent.id, next);
    if (!before) { decider.seedBaseline([next]); return; }
    const transition = notificationTransition(before, next, frequency);
    if (!transition) return;
    for (const decision of decider.gateTransitions([transition], { focus: focus(), nowMs: now() })) {
      const { transition, verdict } = decision;
      if (verdict !== 'deliver') { reportDecision({ agentId: agent.id, kind: transition.kind, outcome: verdict }); continue; }
      if (!Notification.isSupported()) { reportDecision({ agentId: agent.id, kind: transition.kind, outcome: 'unsupported' }); continue; }
      const needsInput = transition.kind === 'agent-needs-input';
      const notice = new Notification({ title: needsInput ? grokText(`${transition.agentName} 需要你处理`, `${transition.agentName} needs your input`) : transition.agentName || 'Grok Bot',
        body: summary(needsInput ? transition.reasonCopy ?? grokText('需要你的回复或授权。', 'Your reply or approval is needed.') : transition.lastMessagePreview ?? grokText('任务已完成。', 'Task completed.')),
        silent: true, urgency: needsInput ? 'critical' : 'normal' });
      active.add(notice);
      notice.on('show', () => reportDecision({ agentId: agent.id, kind: transition.kind, outcome: 'shown' }));
      notice.on('click', () => { reportDecision({ agentId: agent.id, kind: transition.kind, outcome: 'clicked' }); openAgent(agent.id); });
      notice.on('close', () => active.delete(notice));
      notice.on('failed', () => { active.delete(notice); reportDecision({ agentId: agent.id, kind: transition.kind, outcome: 'failed' }); });
      notice.show();
      if (preferences.playSound) sounds?.play(preferences.sound);
      reportDecision({ agentId: agent.id, kind: transition.kind, outcome: 'delivered', sound: preferences.playSound ? preferences.sound : null });
    }
  };
  const ingest = frame => {
    if (!seeded || !settingsReady) { if (pending.length < 2000) pending.push(frame); return; }
    const { channel, payload } = frame;
    if (channel === 'agents' && Array.isArray(payload?.agents)) {
      for (const agent of payload.agents) accept(agent);
      decider.retainOnly(new Set(payload.agents.map(agent => agent.id)));
      for (const id of snapshots.keys()) if (!payload.agents.some(agent => agent.id === id)) { snapshots.delete(id); timestamps.delete(id); }
    } else if (channel === 'agent-upserted') accept(payload?.agent);
  };
  const refresh = async () => {
    const agents = await command('listAgents');
    if (stopped) return;
    if (!seeded) {
      decider.seedBaseline(agents.map(notificationAgent));
      for (const agent of agents) {
        timestamps.set(agent.id, { epoch: agent.snapshotEpoch, seq: agent.snapshotSeq });
        snapshots.set(agent.id, notificationAgent(agent));
      }
      seeded = true;
    }
    else ingest({ channel: 'agents', payload: { agents } });
    if (settingsReady) for (const frame of pending.splice(0)) ingest(frame);
  };
  const enqueue = task => { serial = serial.catch(() => {}).then(task); return serial; };
  const controller = new AbortController();
  void subscribe(config, '/local/notification-settings/events', ({ data }) => enqueue(() => {
    if (!NOTIFICATION_FREQUENCIES.includes(data?.frequency)) return;
    frequency = data.frequency; settingsReady = true;
    if (seeded) for (const frame of pending.splice(0)) ingest(frame);
    reportDecision({ outcome: 'settings-updated', frequency });
  }), controller.signal, { onUnauthorized }).catch(() => { if (!stopped) reportDecision({ outcome: 'settings-stream-unavailable' }); });
  let retry;
  const refreshWithRetry = () => {
    clearTimeout(retry);
    void enqueue(refresh).catch(() => {
      reportDecision({ outcome: 'baseline-unavailable' });
      if (!stopped) retry = setTimeout(refreshWithRetry, 2000);
    });
  };
  void subscribe(config, '/events', ({ data }) => enqueue(() => ingest(data)), controller.signal, {
    onUnauthorized,
    onConnected: refreshWithRetry,
  }).catch(() => { if (!stopped) reportDecision({ outcome: 'stream-unavailable' }); });
  return {
    getPreferences: () => ({ ...preferences }),
    setPreferences: async value => {
      const choices = ['ping-1-open-blip','ping-2-tick','ping-3-double-tick','ping-4-chime-a','ping-5-chime-b'];
      if (typeof value?.playSound !== 'boolean' || !choices.includes(value.sound)) throw new Error('Invalid notification preferences');
      preferences = { sound: value.sound, playSound: value.playSound }; await persist(); return { ...preferences };
    },
    noteViewingAgent: id => { viewedAgentId = typeof id === 'string' && id.length ? id : null; },
    stop: () => { stopped = true; clearTimeout(retry); controller.abort(); sounds?.stop(); for (const notice of active) notice.close(); },
  };
}
