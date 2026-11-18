import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { normalizeHfcPresentation } from '../../../src/channels/feishu/hfc-presentation-config.mjs';
import { PluginConfigStore } from '../../../src/channels/feishu/plugin-config-store.mjs';

test('HFC trial is opt-in, bounded, and copies caller selection', () => {
  assert.deepEqual(normalizeHfcPresentation(), { backend:'legacy', testSessionIds:[], python:null });
  assert.equal(normalizeHfcPresentation({backend:true}).backend,'legacy');
  const ids=['s1','s1','',null,' s2','s3'];
  const result=normalizeHfcPresentation({backend:'hfc',testSessionIds:ids,python:' C:/python.exe '});
  assert.deepEqual(result,{backend:'hfc',testSessionIds:['s1','s3'],python:'C:/python.exe'});
  ids.push('later'); assert.equal(result.testSessionIds.includes('later'),false);
  assert.ok(Object.isFrozen(result) && Object.isFrozen(result.testSessionIds));
  assert.equal(normalizeHfcPresentation({testSessionIds:Array.from({length:100},(_,i)=>`s${i}`)}).testSessionIds.length,32);
});

test('old config loads without rewrite; trial setting survives per-bot persistence', async (t) => {
  const dir=await mkdtemp(join(tmpdir(),'dsh-hfc-config-'));
  t.after(()=>rm(dir,{recursive:true,force:true}));
  const path=join(dir,'config.json');
  const bots=['one','two'].map(id=>({id,appId:`cli_${id}`,secretRef:`SECRET_${id}`,ownerOpenIds:['ou_owner']}));
  const old=JSON.stringify({version:2,bots}); await writeFile(path,old);
  const store=await new PluginConfigStore(path).load();
  assert.equal(await readFile(path,'utf8'),old);
  assert.equal(store.getBot('one').hfcPresentation.backend,'legacy');
  await store.saveBot({...store.getBot('one'),hfcPresentation:{backend:'hfc',testSessionIds:['selected'],python:'C:/python.exe'}});
  const reload=await new PluginConfigStore(path).load();
  assert.deepEqual(reload.getBot('one').hfcPresentation,{backend:'hfc',testSessionIds:['selected'],python:'C:/python.exe'});
  assert.equal(reload.getBot('two').hfcPresentation.backend,'legacy');
});
