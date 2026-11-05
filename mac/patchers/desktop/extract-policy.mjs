import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';

const sha = bytes => createHash('sha256').update(bytes).digest('hex');

// The original policy is read from the user's verified application, never
// included in a public patcher archive.
export async function extractNotificationPolicy(unpacked, directory) {
  const policy = JSON.parse(await readFile(path.join(directory, 'notification-policy.json'), 'utf8'));
  const source = await readFile(path.join(unpacked, policy.source));
  if (sha(source) !== policy.sourceSha256) throw new Error('原通知判定器来源摘要不匹配');
  const start = policy.byteOffset ?? source.indexOf(policy.startMarker);
  const end = policy.byteLength !== undefined ? start + policy.byteLength : source.indexOf(policy.endMarker, start);
  if (start < 0 || end <= start || end > source.length) throw new Error('原通知判定器字节区段无效');
  const body = source.subarray(start, end);
  if (sha(body) !== policy.sha256) throw new Error('原通知判定器摘要不匹配');
  return Buffer.concat([body, Buffer.from('\nexport { QR as NotificationDecider };\n')]);
}
