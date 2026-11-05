import { check } from './security.mjs';

export const mobileAppIntentMethods = new Set([
  'ListGrokBotAgents', 'SendGrokBotUserMessage', 'GetGrokBotSendStatus',
]);

const statusName = value => `GROK_BOT_SEND_STATUS_${value}`;
const visible = row => row && typeof row.id === 'string' && !row.isHiddenFromSidebar;
const string = value => typeof value === 'string' ? value : '';

function messageIdentity(args) {
  check(typeof args.agentId === 'string' && args.agentId.length > 0 && args.agentId.length <= 256,
    400, 'Invalid Bot ID');
  check(typeof args.messageId === 'string' && args.messageId.length > 0 && args.messageId.length <= 256
    && !/[\u0000-\u001f]/.test(args.messageId), 400, 'Invalid message ID');
  return { accountSlot: 'host', agentId: args.agentId, clientNonce: args.messageId };
}

function listAgent(row) {
  return {
    id: row.id, agentId: row.id, legacyAgentId: row.id,
    name: string(row.name), description: string(row.description), title: string(row.title),
    avatarShape: string(row.avatarShape), avatarColor: string(row.avatarColor),
    ...(row.avatarUrl ? { avatarUrl: row.avatarUrl } : {}),
    ...(row.avatarVersion ? { avatarVersion: row.avatarVersion } : {}),
    createdAtMs: String(row.createdAtMs ?? 0), updatedAtMs: String(row.updatedAtMs ?? 0),
    // Native AppEntityQuery filters on this transport discriminator. Execution
    // still uses the local Host; no Temporal workflow is created.
    harness: 'temporal', role: string(row.role),
  };
}

function acceptanceReply(value, agentId) {
  if (value?.outcome === 'unknown-durability') return { status: statusName('UNKNOWN_DURABILITY') };
  if (value?.outcome === 'not-found'
    || (value?.outcome === 'found' && value.record?.agentId !== agentId))
    return { status: statusName('NOT_FOUND') };
  check(value?.outcome === 'found' && ['pending', 'accepted', 'rejected'].includes(value.record?.status),
    502, 'Invalid Host message status');
  const record = value.record;
  return {
    status: statusName(record.status.toUpperCase()),
    ...(record.echoEntryId ? { echoEntryId: record.echoEntryId } : {}),
    ...(record.rejectionCode ? { rejectionCode: record.rejectionCode } : {}),
    ...(Number.isFinite(record.acceptedAtMs) ? { acceptedAtMs: String(record.acceptedAtMs) } : {}),
  };
}

function sendArguments(args) {
  const identity = messageIdentity(args);
  check(typeof args.text === 'string' && args.text.length <= 256 * 1024, 400, 'Invalid message text');
  const attachmentPaths = args.attachmentPaths ?? [], attachmentNames = args.attachmentNames ?? [];
  for (const values of [attachmentPaths, attachmentNames])
    check(Array.isArray(values) && values.length <= 100 && values.every(value => typeof value === 'string'
      && value.length <= 8192), 400, 'Invalid attachments');
  check(args.text.trim().length > 0 || attachmentPaths.length > 0, 400, 'Message is empty');
  const body = { agentId: identity.agentId, clientNonce: identity.clientNonce, prompt: args.text,
    directAddressedAcceptance: true, attachmentPaths, attachmentNames };
  for (const field of ['richText', 'replyToId']) {
    if (args[field] === undefined) continue;
    check(typeof args[field] === 'string', 400, `Invalid ${field}`);
    body[field] = args[field];
  }
  if (args.isFork !== undefined) {
    check(typeof args.isFork === 'boolean', 400, 'Invalid fork flag');
    body.isFork = args.isFork;
  }
  return body;
}

/** Adapt native App Intents to the same durable send pipeline used by the chat UI. */
export async function mobileAppIntentRpc(hostCall, method, args) {
  check(mobileAppIntentMethods.has(method), 404, 'App Intent method not found');
  if (method === 'ListGrokBotAgents') {
    const rows = await hostCall('listAgents', {});
    check(Array.isArray(rows), 502, 'Invalid Host Bot list');
    return { agents: rows.filter(visible).map(listAgent), slackConnections: [] };
  }
  const identity = messageIdentity(args);
  if (method === 'GetGrokBotSendStatus')
    return acceptanceReply(await hostCall('promptAcceptanceStatus', identity), identity.agentId);

  const body = sendArguments(args), rows = await hostCall('listAgents', {});
  check(Array.isArray(rows), 502, 'Invalid Host Bot list');
  check(rows.some(row => visible(row) && row.id === identity.agentId), 404, 'Bot not found');
  const before = await hostCall('promptAcceptanceStatus', identity);
  // Always let sendPrompt validate the input digest, including when a nonce was
  // previously accepted. Its durable ledger also coalesces concurrent retries.
  const result = await hostCall('sendPrompt', body);
  check(result?.accepted === true, 502, 'Host did not accept the message');
  return {
    dispatched: true,
    mode: 'GROK_BOT_TEMPORAL_HARNESS_MODE_BOX',
    delivery: before?.outcome === 'found' && before.record?.agentId === identity.agentId
      ? 'GROK_BOT_USER_MESSAGE_DELIVERY_DUPLICATE' : 'GROK_BOT_USER_MESSAGE_DELIVERY_ACCEPTED_BOX',
  };
}
