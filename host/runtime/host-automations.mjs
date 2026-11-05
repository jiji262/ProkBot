import { createHash, randomUUID } from 'node:crypto';
import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

const realClock = { now: Date.now, setTimeout, clearTimeout };
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const keyFor = (agentId, automationId) => hash([agentId, automationId]);
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const timestamp = value => Number.isFinite(value) && value >= 0;
const errorView = error => ({ name: error?.name ?? 'Error', message: String(error?.message ?? error).slice(0, 500) });

/** Single Host owner: one bounded temporary file, then durable atomic replacement. */
function atomicJson(path, value) {
  const directory = dirname(path), temporary = `${path}.tmp`;
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  let file;
  try {
    file = openSync(temporary, 'w', 0o600);
    writeFileSync(file, JSON.stringify(value, null, 2) + '\n');
    fsyncSync(file);
    closeSync(file); file = undefined;
    renameSync(temporary, path);
    file = openSync(directory, 'r');
    fsyncSync(file);
  } finally {
    if (file !== undefined) closeSync(file);
    rmSync(temporary, { force: true });
  }
}

function loadClaims(path) {
  let value;
  try { value = JSON.parse(readFileSync(path, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return {}; throw error; }
  if (!record(value) || value.version !== 1 || !record(value.claims)) throw new Error('Invalid local automation claim ledger');
  for (const [key, claim] of Object.entries(value.claims)) {
    if (!record(claim) || typeof claim.agentId !== 'string' || typeof claim.automationId !== 'string' ||
        key !== keyFor(claim.agentId, claim.automationId) || typeof claim.runUuid !== 'string' || !claim.runUuid ||
        !timestamp(claim.definitionCreatedAt) || !timestamp(claim.scheduledForMs) || !timestamp(claim.claimedAt) ||
        (claim.definitionFile !== undefined && typeof claim.definitionFile !== 'string') ||
        !['claimed', 'completed', 'interrupted'].includes(claim.state) ||
        (claim.state !== 'claimed' && !timestamp(claim.finishedAt))) {
      throw new Error('Invalid entry in local automation claim ledger');
    }
  }
  return value.claims;
}

function definitionRemoved(claim) {
  if (!claim.definitionFile) return false;
  try { statSync(claim.definitionFile); return false; }
  catch (error) { return error.code === 'ENOENT'; }
}

/**
 * Local policy: pure cron, one outstanding run per definition, coalesce missed slots.
 * A durable claim consumes its occurrence even if dispatch fails or the Host exits.
 * Original listeners and automation execution remain owned by the original extension.
 * The optional clock/directory arguments exist for deterministic isolated tests.
 */
export async function decorateLocalHostAutomations(context, library, originalApi, {
  stateDirectory = process.env.GROKBOT_STATE_DIR ?? '/research/state',
  clock = realClock,
} = {}) {
  const claimsPath = join(stateDirectory, 'local-automation-claims.json');
  const statusPath = join(stateDirectory, 'local-automations-status.json');
  const transcript = context.deps.transcript;
  const inFlight = new Map();
  let claims = {}, initialized = false, stopped = false, suspended = false;
  let timer, scanning, scanAgain = false, generation = 0, nextDueAt = null;
  let lastScanAt = null, lastError = null, runReady = false, localAuthority = false;
  let trackedDefinitions = 0, eligibleDefinitions = 0;
  const log = message => context.host.log(`[local-automations] ${message}`);
  const active = epoch => !stopped && !suspended && generation === epoch;
  const hasLocalAuthority = () => context.deps.auth.peekAccessToken() === null;

  function saveClaims(next) {
    atomicJson(claimsPath, { version: 1, claims: next });
    claims = next;
  }
  function writeStatus() {
    try {
      atomicJson(statusPath, { version: 1, ready: initialized && !stopped && lastError === null,
        pid: process.pid, suspended, stopped, localAuthority, runReady, lastScanAt,
        updatedAt: new Date(clock.now()).toISOString(), nextDueAt,
        trackedDefinitions, eligibleDefinitions, activeClaims: inFlight.size,
        claimCount: Object.keys(claims).length, ...(lastError ? { error: lastError } : {}),
        policy: 'local-pure-cron; durable-claim-before-dispatch; coalesce-missed; no-interrupted-replay' });
    } catch (error) { log(`cannot write scheduler status: ${errorView(error).message}`); }
  }
  function fail(error) {
    lastError = errorView(error);
    log(lastError.message);
    writeStatus();
  }
  function initialize() {
    if (initialized) return;
    for (const name of ['earliestAutomationNextRunAt', 'getSandAgentsRootDir', 'getSandProfilePath',
      'readSandProfileHarness', 'readSandProfileServerId']) {
      if (typeof library[name] !== 'function') throw new Error(`Missing original automation dependency: ${name}`);
    }
    const next = loadClaims(claimsPath);
    for (const [key, claim] of Object.entries(next)) {
      if (claim.state === 'claimed') next[key] = { ...claim, state: 'interrupted',
        finishedAt: clock.now(), outcome: 'host-restarted' };
    }
    saveClaims(next);
    initialized = true;
  }
  function isBoxLocal(agentId) {
    const profile = library.getSandProfilePath(join(library.getSandAgentsRootDir(), agentId));
    const harness = library.readSandProfileHarness(profile);
    // Same rule as original isBoxHostedForAutomationSync (585377).
    return harness !== null ? harness === 'box' : library.readSandProfileServerId(profile) === null;
  }
  function cancelTimer() {
    if (timer !== undefined) clock.clearTimeout(timer);
    timer = undefined;
  }
  function armTimer() {
    cancelTimer();
    if (stopped || suspended) return;
    const wait = nextDueAt === null ? 15000 : Math.max(100, Math.min(15000, nextDueAt - clock.now()));
    timer = clock.setTimeout(() => { timer = undefined; void requestScan(); }, wait);
    timer?.unref?.();
  }

  function finishClaim(key, runUuid, outcome, error) {
    if (inFlight.get(key) !== runUuid) return;
    inFlight.delete(key);
    if (stopped) return;
    if (claims[key]?.runUuid === runUuid) {
      try {
        saveClaims({ ...claims, [key]: { ...claims[key], state: 'completed', finishedAt: clock.now(),
          outcome: outcome ?? 'not-started', ...(error ? { error: errorView(error) } : {}) } });
      } catch (failure) { fail(failure); }
    }
    writeStatus();
    void requestScan();
  }
  function dispatch(entry, scheduledForMs, timeZone, epoch) {
    const { agentId, automation } = entry, key = keyFor(agentId, automation.id);
    if (!active(epoch) || !hasLocalAuthority() || inFlight.has(key)) return;
    const claim = { agentId, automationId: automation.id, definitionCreatedAt: automation.createdAt,
      ...(automation.filePath ? { definitionFile: automation.filePath } : {}),
      definitionHash: hash([automation.createdAt, automation.trigger, automation.prompt, timeZone]),
      runUuid: randomUUID(), scheduledForMs, claimedAt: clock.now(), state: 'claimed',
      schedule: automation.trigger.schedule, ...(timeZone ? { timeZone } : {}) };
    // No asynchronous gap between durable claim, in-flight ownership and dispatch.
    saveClaims({ ...claims, [key]: claim });
    inFlight.set(key, claim.runUuid);
    let execution;
    try {
      execution = transcript.runServerScheduledAutomation({ agentId, automation,
        runUuid: claim.runUuid, scheduledForMs });
    } catch (error) { finishClaim(key, claim.runUuid, 'dispatch-error', error); return; }
    void Promise.resolve(execution).then(
      outcome => finishClaim(key, claim.runUuid, outcome),
      error => finishClaim(key, claim.runUuid, 'dispatch-error', error));
  }
  async function scanOnce() {
    const epoch = generation;
    if (!active(epoch)) return;
    initialize();
    const definitions = await transcript.listAllAutomationDefinitions();
    if (!active(epoch)) return;
    const current = new Map(definitions.map(entry => [keyFor(entry.agentId, entry.automation.id), entry.automation]));
    // Original enumeration omits invalid/unreadable configs. Absence from that
    // list alone is not deletion and must not erase durable duplicate protection.
    const next = Object.fromEntries(Object.entries(claims).filter(([key, claim]) => {
      const definition = current.get(key);
      return definition ? definition.createdAt === claim.definitionCreatedAt : !definitionRemoved(claim);
    }));
    if (Object.keys(next).length !== Object.keys(claims).length) saveClaims(next);
    trackedDefinitions = definitions.length;
    nextDueAt = null;
    localAuthority = hasLocalAuthority();
    runReady = await context.deps['turn-execution'].isRunReady();
    if (!active(epoch)) return;
    localAuthority = hasLocalAuthority();
    const timeZone = context.deps.settings.getUserTimeZone();
    const eligible = definitions.filter(({ agentId, automation }) =>
      automation.isEnabled && automation.trigger?.type === 'cron' && isBoxLocal(agentId));
    eligibleDefinitions = eligible.length;
    if (localAuthority && runReady) {
      for (const entry of eligible) {
        if (!active(epoch) || !hasLocalAuthority()) break;
        const key = keyFor(entry.agentId, entry.automation.id);
        if (inFlight.has(key)) continue;
        const anchor = Math.max(entry.automation.lastRunAt ?? entry.automation.createdAt, claims[key]?.claimedAt ?? 0);
        const due = library.earliestAutomationNextRunAt({ ...entry.automation, lastRunAt: anchor }, timeZone);
        if (!timestamp(due)) continue;
        if (due <= clock.now()) dispatch(entry, due, timeZone, epoch);
        else nextDueAt = nextDueAt === null ? due : Math.min(nextDueAt, due);
      }
    }
    lastScanAt = new Date(clock.now()).toISOString();
    lastError = null;
    writeStatus();
  }
  function requestScan() {
    if (stopped || suspended) return Promise.resolve();
    if (scanning) { scanAgain = true; return scanning; }
    cancelTimer();
    scanning = (async () => {
      do {
        scanAgain = false;
        try { await scanOnce(); }
        catch (error) { fail(error); }
      } while (scanAgain && !stopped && !suspended);
    })().finally(() => { scanning = undefined; armTimer(); });
    return scanning;
  }

  const offChanged = context.host.events.on('transcript.automation-config-changed', () => {
    generation++;
    void requestScan();
  });
  context.onStop(() => {
    stopped = true; generation++; cancelTimer(); offChanged();
    // Outstanding model work belongs to Transcript. Its claimed ledger entry remains
    // recoverable as interrupted; shutdown does not wait for that model Promise.
    writeStatus();
  });
  await requestScan();
  return {
    ...originalApi,
    async suspendWakes() {
      suspended = true; generation++; cancelTimer(); writeStatus();
      await originalApi.suspendWakes();
    },
    resumeWakes() {
      if (stopped) return;
      const result = originalApi.resumeWakes();
      suspended = false; generation++; void requestScan();
      return result;
    },
    async reconcileNow() {
      if (stopped) return;
      try { return await originalApi.reconcileNow(); }
      finally { await requestScan(); }
    },
  };
}
