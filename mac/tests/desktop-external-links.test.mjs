import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { externalHttpUrl } from '../clients/desktop/external-url.mjs';
import { createLocalServices } from '../clients/desktop/local-services.mjs';
import { installExternalLinks } from '../clients/desktop/external-links.mjs';
import { EventEmitter } from 'node:events';

test('accepts only credential-free HTTP and HTTPS URLs', () => {
  assert.equal(externalHttpUrl('https://example.com/'), 'https://example.com/');
  assert.equal(externalHttpUrl('http://example.com/path?q=1'), 'http://example.com/path?q=1');
  assert.equal(externalHttpUrl('file:///etc/passwd'), null);
  assert.equal(externalHttpUrl('javascript:alert(1)'), null);
  assert.equal(externalHttpUrl('https://user:pass@example.com/'), null);
});

test('opens navigation and new-window links externally and keeps original local reloads', async () => {
  const contents = new EventEmitter(), opened = [], copied=[];
  contents.getURL=()=> 'file:///app/index.html';
  contents.setWindowOpenHandler=callback=>{contents.newWindow=callback;};
  let menu;
  installExternalLinks({webContents:contents},{openExternal:async value=>opened.push(value),
    clipboard:{writeText:value=>copied.push(value)},Menu:{buildFromTemplate:items=>({popup:()=>{menu=items;}})},text:(_zh,en)=>en});
  assert.deepEqual(contents.newWindow({url:'https://example.com/new'}),{action:'deny'});
  let prevented=0; const event={preventDefault:()=>prevented++};
  contents.emit('will-navigate',event,'file:///app/index.html'); assert.equal(prevented,0);
  contents.emit('will-navigate',event,'https://example.com/page'); assert.equal(prevented,1);
  contents.newWindow({url:'file:///etc/passwd'});
  contents.emit('context-menu',{}, {linkURL:'https://example.com/context',selectionText:'',isEditable:false});
  menu[0].click(); menu[1].click();
  await new Promise(resolve=>setImmediate(resolve));
  assert.deepEqual(opened,['https://example.com/new','https://example.com/page','https://example.com/context']);
  assert.deepEqual(copied,['https://example.com/context']);
});

test('opens explicit external links through the desktop bridge', async t => {
  const profile = await mkdtemp(path.join(tmpdir(), 'grokbot-external-link-test-'));
  t.after(() => rm(profile, { recursive: true, force: true }));
  const opened = [];
  const call = await createLocalServices(profile, {}, {
    command: async () => null,
    request: async () => null,
    attachment: async () => null,
    connection: async () => null,
    disconnect: async () => null,
    notifications: {},
    pickAvatarFile: async () => null,
    openExternal: async url => opened.push(url),
  });

  await call('openExternal', { url: 'https://example.com/' });
  await call('openExternal', { url: 'grokbot-local:agent/example' });
  await assert.rejects(call('openExternal', { url: 'file:///etc/passwd' }), /Invalid link address/);
  assert.deepEqual(opened, ['https://example.com/']);
});
