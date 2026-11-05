import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createGateway } from '../clients/desktop/gateway.mjs';
import { createLocalServices } from '../clients/desktop/local-services.mjs';

test('sidebar IPC uses Host settings, keeps unset pins distinct from a saved empty list and propagates failures', async t => {
  const profile = await mkdtemp(path.join(os.tmpdir(), 'desktop-sidebar-test-'));
  const requests = [];
  let settings = { sidebarSections: [] }, failure = false;
  const server = createServer(async (req, res) => {
    assert.equal(req.headers.authorization, 'Bearer sidebar-device-token');
    let body = ''; for await (const chunk of req) body += chunk;
    const args = JSON.parse(body);
    requests.push({ path: req.url, args });
    res.writeHead(failure ? 503 : 200, { 'Content-Type': 'application/json' });
    if (failure) return res.end(JSON.stringify({ error: 'Host unavailable' }));
    if (req.url === '/api/setHostSettings') Object.assign(settings, args);
    else assert.equal(req.url, '/api/getHostSettings');
    res.end(JSON.stringify(settings));
  });
  server.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve));
  const gateway = createGateway({ server: `http://127.0.0.1:${server.address().port}`, token: 'sidebar-device-token' }, () => {});
  t.after(async () => { gateway.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await rm(profile, { recursive: true, force: true }); });
  const call = await createLocalServices(profile, {}, { command: gateway.command });
  assert.equal(await call('getHostPinnedAgents'), null);
  assert.deepEqual(await call('getHostSidebarSections'), []);
  const pinnedAgentIds = ['bot-b', 'bot-a'];
  const sections = [{ id: 'section-work', name: '工作', agentIds: ['bot-a'] }];
  assert.deepEqual(await call('setHostPinnedAgents', { pinnedAgentIds }), pinnedAgentIds);
  assert.deepEqual(await call('setHostSidebarSections', { sections }), sections);
  const reopened = await createLocalServices(profile, {}, { command: gateway.command });
  assert.deepEqual(await reopened('getHostPinnedAgents'), pinnedAgentIds);
  assert.deepEqual(await reopened('getHostSidebarSections'), sections);
  assert.deepEqual(requests[2], { path: '/api/setHostSettings', args: { pinnedAgentIds } });
  assert.deepEqual(requests[3], { path: '/api/setHostSettings', args: { sidebarSections: sections } });
  assert.deepEqual(await reopened('setHostPinnedAgents', { pinnedAgentIds: [] }), []);
  assert.deepEqual(await reopened('getHostPinnedAgents'), []);
  const count = requests.length;
  assert.equal(await reopened('getServerPinnedAgents'), null);
  assert.equal(requests.length, count);
  failure = true;
  await assert.rejects(reopened('setHostSidebarSections', { sections: [] }), /Host unavailable/);
  await assert.rejects(reopened('getHostPinnedAgents'), /Host unavailable/);
});

test('original persistence preload restores the active account and excludes inactive accounts and transcript replicas', async t => {
  const profile = await mkdtemp(path.join(os.tmpdir(), 'desktop-sidebar-restore-'));
  t.after(() => rm(profile, { recursive: true, force: true }));
  const call = await createLocalServices(profile, {}, {});
  const active = 'sand.client.slice.account.workspace.';
  const entries = {
    'sand.client.slice.client-meta.account-slot': JSON.stringify({ schemaVersion: 1, value: 'workspace' }),
    [`${active}ui-agent-refs`]: JSON.stringify({ schemaVersion: 1, value: {
      pinnedAgentIds: ['bot-a'], collapsedSectionIds: ['section-work'], hasJoinedCachedPins: true,
    } }),
    [`${active}transcript.replicas.bot-a`]: 'excluded transcript',
    'sand.client.slice.account.other.ui-agent-refs': 'excluded other account',
  };
  for (const [key, value] of Object.entries(entries)) await call('writeClientPersistence', { key, value });
  const restarted = await createLocalServices(profile, {}, {});
  const restored = await restarted('readManyClientPersistence', {
    include: ['sand.', active], exclude: ['sand.client.slice.account.', `${active}transcript.replicas.`],
  });
  assert.deepEqual(restored, Object.fromEntries(Object.entries(entries).slice(0, 2)));
  assert.deepEqual(JSON.parse(restored[`${active}ui-agent-refs`]).value.collapsedSectionIds, ['section-work']);
  assert.deepEqual(await restarted('readManyClientPersistence', { include: [], exclude: [] }), {});
  assert.deepEqual(await restarted('readManyClientPersistence', { include: [active], exclude: [active] }),
    Object.fromEntries(Object.entries(entries).filter(([key]) => key.startsWith(active))));
});

