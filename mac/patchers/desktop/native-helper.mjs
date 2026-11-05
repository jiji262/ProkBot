import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';

// Grok Bot 0.71.2 universal helper: Swift Array<String> backing the stdio
// peer policy, one entry in each architecture. The UID/signature checks stay intact.
const digest = 'ebcb4aeba02914e0cf073fd3493b2c1235b73814fe60fd7854c296591b68bbc5';
const teamOffsets = [0x1a0e58, 0x4a5c88];
export async function patchNativeHelperTeam(filename, teamId) {
  if (!/^[A-Z0-9]{10}$/.test(teamId)) throw new Error('Computer helper requires a certificate Team ID');
  const bytes = await readFile(filename);
  if (createHash('sha256').update(bytes).digest('hex') !== digest) throw new Error('Unsupported computer helper binary');
  for (const offset of teamOffsets) {
    if (bytes.subarray(offset, offset + 10).toString() !== 'DCNK4UB866' || bytes[offset + 15] !== 0xea)
      throw new Error('Computer helper peer policy fingerprint mismatch');
    bytes.write(teamId, offset, 'ascii');
  }
  await writeFile(filename, bytes);
  return { trustedTeam: teamId, architectures: ['x86_64', 'arm64'], sameUserRequired: true, signatureRequired: true };
}
